import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createIncognitoCapturePersistence, createRegularCapturePersistence } from "../src/capture-persistence.js";
import { DELIVERY_STATES } from "../src/capture-store.js";
import type { EditorNode, KeyValueStoragePort } from "../src/contracts.js";

globalThis.IDBKeyRange = IDBKeyRange;

interface TestStorage extends KeyValueStoragePort {
  values: Record<string, unknown>;
  writes: string[][];
  readonly QUOTA_BYTES: number;
}

function chromeStorage(initial: Record<string, unknown> = {}): TestStorage {
  const values: Record<string, unknown> = structuredClone(initial);
  const writes: string[][] = [];
  return {
    values,
    writes,
    QUOTA_BYTES: 10 * 1024 * 1024,
    async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      if (keys === null || keys === undefined) return structuredClone(values);
      if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(values[key])]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(values[key] ?? fallback)]));
    },
    async set(next: Record<string, unknown>): Promise<void> {
      writes.push(Object.keys(next));
      Object.assign(values, structuredClone(next));
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async getKeys() { return Object.keys(values); },
    async getBytesInUse() { return new TextEncoder().encode(JSON.stringify(values)).length; }
  };
}

function document(text: string): EditorNode {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function must<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, label);
  return value;
}

function mustRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

test("regular persistence migrates the legacy graph once and makes IndexedDB canonical", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft-1",
      drafts: {
        "draft-1": { id: "draft-1", revision: 2, title: "Migrated", doc: document("Body"), updatedAt: 10 }
      },
      captures: {
        "capture-1": { id: "capture-1", draftId: "old", status: DELIVERY_STATES.blockedSetup, capture: { document: { doc: document("Queued") } }, updatedAt: 20 }
      }
    }
  });
  const repository = createRegularCapturePersistence({ storage, indexedDB: new IDBFactory(), now: () => 100 });
  await repository.ready();

  assert.equal(repository.backendName, "indexeddb");
  assert.equal(must(await repository.getActiveDraft(), "migrated active draft").title, "Migrated");
  assert.equal(must(await repository.getCapture("capture-1"), "migrated capture").status, DELIVERY_STATES.blockedSetup);
  assert.equal(storage.values.captureStateV1, undefined);
  assert.equal(mustRecord(storage.values.captureIndexV3, "capture index").activeDraftId, "draft-1");
  assert.equal(mustRecord(storage.values.captureIndexV3, "capture index").unresolvedCount, 1);
});

test("regular autosave updates one IndexedDB record without rewriting the local index", async () => {
  const storage = chromeStorage();
  const repository = createRegularCapturePersistence({ storage, indexedDB: new IDBFactory(), now: () => 100, uuid: () => "draft" });
  await repository.ready();
  const transient = await repository.getOrCreateDraft({ context: { selection: "Initial" } });
  const structuralWrites = storage.writes.length;
  const saved = await repository.upsertDraft({ ...transient, doc: document("Updated") }, transient.revision);

  assert.equal(must(must(must(await repository.getDraft("draft"), "saved draft").doc.content?.[0], "document block").content?.[0], "text node").text, "Updated");
  assert.equal(must(saved, "saved revision").revision, transient.revision + 1);
  assert.equal(storage.writes.length, structuralWrites);
});

test("draft enqueue is atomic and repeated enqueue reconciles through the draft ID index", async () => {
  const repository = createRegularCapturePersistence({
    storage: chromeStorage(), indexedDB: new IDBFactory(), now: () => 500, uuid: (() => { let id = 0; return () => `id-${++id}`; })()
  });
  const draft = await repository.getOrCreateDraft({ context: { selection: "Atomic" } });
  const record = await repository.enqueue({
    draftId: draft.id,
    capture: { document: { doc: draft.doc } },
    context: draft.context,
    destination: null,
    connectionId: "",
    status: DELIVERY_STATES.blockedSetup
  });
  const repeated = await repository.enqueue({
    draftId: draft.id,
    capture: { document: { doc: draft.doc } },
    context: draft.context,
    destination: null,
    connectionId: "",
    status: DELIVERY_STATES.blockedSetup
  });
  assert.equal(await repository.getDraft(draft.id), null);
  assert.equal(repeated.id, record.id);
  assert.equal((await repository.listCaptures()).length, 1);
});

test("startup recovery is not skipped by the daily retention throttle", async () => {
  let timestamp = 100;
  const repository = createRegularCapturePersistence({
    storage: chromeStorage(), indexedDB: new IDBFactory(), now: () => timestamp, uuid: () => "capture"
  });
  await repository.ready();
  const record = await repository.enqueue({
    draftId: "",
    capture: { document: { doc: document("Interrupted") } },
    context: {},
    destination: { managedDestination: true },
    connectionId: "connection",
    status: DELIVERY_STATES.sending
  });
  await repository.maintain({ recoverInterrupted: false, force: true });

  timestamp += 1;
  await repository.maintain({ recoverInterrupted: true });

  const recovered = must(await repository.getCapture(record.id), "recovered capture");
  assert.equal(recovered.status, DELIVERY_STATES.pending);
  assert.equal(recovered.nextAttemptAt, timestamp);
  assert.equal(must(recovered.lastError, "interruption metadata").kind, "interrupted");
});

test("Incognito persistence stores one session key per record and removes its legacy graph", async () => {
  const storage = chromeStorage();
  const repository = createIncognitoCapturePersistence({ storage, now: () => 100, uuid: () => "draft" });
  await repository.ready();
  const draft = await repository.getOrCreateDraft({ context: { selection: "Private" } });
  assert.ok(storage.values[`incognitoDraftV3:${draft.id}`]);
  assert.deepEqual(mustRecord(storage.values.incognitoCaptureIndexV3, "incognito index").draftIds, [draft.id]);
  assert.equal(storage.values.incognitoCaptureStateV1, undefined);

  const record = await repository.enqueue({
    draftId: draft.id,
    capture: { document: { doc: draft.doc } },
    context: draft.context,
    destination: null,
    connectionId: "",
    status: DELIVERY_STATES.blockedSetup,
    incognito: true
  });
  assert.equal(storage.values[`incognitoDraftV3:${draft.id}`], undefined);
  assert.ok(storage.values[`incognitoCaptureV3:${record.id}`]);
  assert.deepEqual(mustRecord(storage.values.incognitoCaptureIndexV3, "incognito index").captureIds, [record.id]);
});

test("failed IndexedDB initialization preserves and continues using legacy capture storage", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", doc: document("Still safe"), updatedAt: 1 } },
      captures: {}
    }
  });
  const failingIndexedDB = new IDBFactory();
  Object.defineProperty(failingIndexedDB, "open", { value() { throw new Error("IndexedDB unavailable"); } });
  const repository = createRegularCapturePersistence({
    storage,
    indexedDB: failingIndexedDB
  });
  await repository.ready();
  assert.equal(repository.backendName, "legacy");
  assert.equal(must(await repository.getDraft("draft"), "legacy draft").id, "draft");
  assert.ok(storage.values.captureStateV1);
  assert.match(repository.migrationError, /unavailable/);
});

test("a failed local-index checkpoint uses legacy for the run and retries the import on restart", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", revision: 1, doc: document("Before retry"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  const set = storage.set.bind(storage);
  let failMirror = true;
  storage.set = async (values) => {
    if (failMirror && values.captureIndexV3) throw new Error("Mirror checkpoint interrupted");
    return set(values);
  };

  const firstRun = createRegularCapturePersistence({ storage, indexedDB, now: () => 100 });
  await firstRun.ready();
  assert.equal(firstRun.backendName, "legacy");
  assert.ok(storage.values.captureStateV1);
  await firstRun.upsertDraft({ ...must(await firstRun.getDraft("draft"), "fallback draft"), doc: document("Changed in fallback") }, 1);

  failMirror = false;
  const restarted = createRegularCapturePersistence({ storage, indexedDB, now: () => 200 });
  await restarted.ready();
  assert.equal(restarted.backendName, "indexeddb");
  assert.equal(must(must(must(await restarted.getDraft("draft"), "restarted draft").doc.content?.[0], "document block").content?.[0], "text node").text, "Changed in fallback");
  assert.equal(storage.values.captureStateV1, undefined);
  assert.equal(mustRecord(storage.values.captureIndexV3, "capture index").migrationStatus, "complete");
});

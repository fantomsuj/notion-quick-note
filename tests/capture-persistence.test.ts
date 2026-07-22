import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
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

test("canonical IndexedDB data is never replaced by an empty writable fallback", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", doc: document("Canonical"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  const migrated = createRegularCapturePersistence({ storage, indexedDB });
  await migrated.ready();
  assert.equal(storage.values.captureStateV1, undefined);

  const unavailable = {
    open() { throw new Error("transient IndexedDB failure"); }
  } as unknown as IDBFactory;
  const failedRestart = createRegularCapturePersistence({ storage, indexedDB: unavailable });
  await assert.rejects(failedRestart.ready(), /transient IndexedDB failure/);
  assert.equal(storage.values.captureStateV1, undefined);

  const recovered = createRegularCapturePersistence({ storage, indexedDB });
  await recovered.ready();
  assert.equal(must(await recovered.getDraft("draft"), "canonical draft").id, "draft");
});

test("a failed canonical-authority read cannot activate writable legacy fallback", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", doc: document("Canonical"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  await createRegularCapturePersistence({ storage, indexedDB }).ready();

  const get = storage.get.bind(storage);
  storage.get = async () => { throw new Error("authority read interrupted"); };
  const failedRestart = createRegularCapturePersistence({ storage, indexedDB });
  await assert.rejects(failedRestart.ready(), /authority read interrupted/);
  assert.equal(storage.values.captureStateV1, undefined);

  storage.get = get;
  const recovered = createRegularCapturePersistence({ storage, indexedDB });
  await recovered.ready();
  assert.equal(must(await recovered.getDraft("draft"), "canonical draft").id, "draft");
});

test("an imported checkpoint without its legacy graph fails closed and preserves IndexedDB", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", doc: document("Canonical"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  await createRegularCapturePersistence({ storage, indexedDB }).ready();
  mustRecord(storage.values.captureIndexV3, "capture index").migrationStatus = "imported";

  const unavailable = {
    open() { throw new Error("IndexedDB unavailable during incomplete handoff"); }
  } as unknown as IDBFactory;
  await assert.rejects(
    createRegularCapturePersistence({ storage, indexedDB: unavailable }).ready(),
    /unavailable during incomplete handoff/
  );
  assert.equal(storage.values.captureStateV1, undefined);

  const recovered = createRegularCapturePersistence({ storage, indexedDB });
  await recovered.ready();
  assert.equal(must(await recovered.getDraft("draft"), "canonical draft").id, "draft");
  assert.equal(mustRecord(storage.values.captureIndexV3, "repaired index").migrationStatus, "complete");
});

test("a malformed authority checkpoint never authorizes a stale legacy graph", async () => {
  const storage = chromeStorage({
    captureIndexV3: { version: 3, migrationStatus: "unknown" },
    captureStateV1: {
      version: 2,
      activeDraftId: "stale",
      drafts: { stale: { id: "stale", doc: document("Stale"), updatedAt: 1 } },
      captures: {}
    }
  });
  const unavailable = {
    open() { throw new Error("IndexedDB unavailable with malformed checkpoint"); }
  } as unknown as IDBFactory;
  const repository = createRegularCapturePersistence({ storage, indexedDB: unavailable });
  await assert.rejects(repository.ready(), /malformed checkpoint/);
  assert.ok(storage.values.captureStateV1);
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

test("a failed completion marker retains legacy changes and retries the full import on restart", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", revision: 1, doc: document("Before marker failure"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    if (mustRecord(value, "object-store value").migrationStatus === "complete") {
      throw new Error("completion marker interrupted");
    }
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  };
  try {
    const firstRun = createRegularCapturePersistence({ storage, indexedDB, now: () => 100 });
    await firstRun.ready();
    assert.equal(firstRun.backendName, "legacy");
    assert.match(firstRun.migrationError, /completion marker interrupted/);
    assert.ok(storage.values.captureStateV1);
    const draft = must(await firstRun.getDraft("draft"), "fallback draft");
    await firstRun.upsertDraft({ ...draft, doc: document("Changed after marker failure") }, draft.revision);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }

  assert.equal(mustRecord(storage.values.captureIndexV3, "migration checkpoint").migrationStatus, "imported");
  const unavailable = {
    open() { throw new Error("IndexedDB still unavailable"); }
  } as unknown as IDBFactory;
  const fallbackRestart = createRegularCapturePersistence({ storage, indexedDB: unavailable, now: () => 150 });
  await fallbackRestart.ready();
  assert.equal(fallbackRestart.backendName, "legacy");
  const fallbackDraft = must(await fallbackRestart.getDraft("draft"), "second fallback draft");
  await fallbackRestart.upsertDraft({ ...fallbackDraft, doc: document("Changed while IndexedDB remained unavailable") }, fallbackDraft.revision);

  const restarted = createRegularCapturePersistence({ storage, indexedDB, now: () => 200 });
  await restarted.ready();
  assert.equal(restarted.backendName, "indexeddb");
  assert.equal(
    must(must(must(await restarted.getDraft("draft"), "reimported draft").doc.content?.[0], "paragraph").content?.[0], "text").text,
    "Changed while IndexedDB remained unavailable"
  );
  assert.equal(storage.values.captureStateV1, undefined);
});

test("a missing IndexedDB factory falls back lazily and records honest legacy diagnostics", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", revision: 1, doc: document("Fallback"), updatedAt: 1 } },
      captures: {}
    }
  });
  const original = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  try {
    const repository = createRegularCapturePersistence({ storage });
    assert.equal(repository.backendName, "legacy");
    await repository.ready();
    assert.equal(repository.backendName, "legacy");
    assert.match(repository.migrationError, /unavailable/i);
    const metadata = await repository.getMeta();
    assert.equal(metadata.migrationStatus, "legacy");
    assert.match(metadata.migrationError, /unavailable/i);
    assert.equal(must(await repository.getActiveDraft(), "fallback active draft").id, "draft");
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: original });
  }
});

test("a failed fallback metadata write does not hide the in-memory migration warning", async () => {
  const storage = chromeStorage({ captureStateV1: { version: 2, activeDraftId: "", drafts: {}, captures: {} } });
  storage.set = async () => { throw new Error("legacy metadata unavailable"); };
  const repository = createRegularCapturePersistence({ storage });
  await repository.ready();
  assert.equal(repository.backendName, "legacy");
  assert.match(repository.migrationError, /IndexedDB is unavailable/);
});

test("stale legacy graph cleanup failure keeps IndexedDB active and retries removal on restart", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", revision: 1, doc: document("Migrated"), updatedAt: 1 } },
      captures: {}
    }
  });
  const indexedDB = new IDBFactory();
  const remove = storage.remove.bind(storage);
  let failCleanup = true;
  storage.remove = async (keys) => {
    if (failCleanup && (Array.isArray(keys) ? keys : [keys]).includes("captureStateV1")) {
      throw new Error("cleanup interrupted");
    }
    return remove(keys);
  };

  const firstRun = createRegularCapturePersistence({ storage, indexedDB });
  await firstRun.ready();
  assert.equal(firstRun.backendName, "indexeddb");
  assert.match(firstRun.migrationError, /cleanup interrupted/);
  assert.ok(storage.values.captureStateV1);
  assert.equal(must(await firstRun.getDraft("draft"), "durable IndexedDB draft").id, "draft");

  failCleanup = false;
  const restarted = createRegularCapturePersistence({ storage, indexedDB });
  await restarted.ready();
  assert.equal(restarted.backendName, "indexeddb");
  assert.equal(restarted.migrationError, "");
  assert.equal(storage.values.captureStateV1, undefined);
  assert.equal(must(await restarted.getDraft("draft"), "restarted IndexedDB draft").id, "draft");
});

test("migration import events stay suppressed while active repository mutations are forwarded", async () => {
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "draft",
      drafts: { draft: { id: "draft", revision: 1, doc: document("Migrated"), updatedAt: 1 } },
      captures: {}
    }
  });
  const repository = createRegularCapturePersistence({ storage, indexedDB: new IDBFactory(), now: () => 100 });
  const events: string[] = [];
  repository.setChangeHandler((event) => { events.push(event.kind); });
  await repository.ready();
  assert.deepEqual(events, []);

  const draft = must(await repository.getDraft("draft"), "active draft");
  await repository.upsertDraft({ ...draft, title: "Forwarded" }, draft.revision);
  assert.deepEqual(events, ["draft"]);

  const failingIndexedDB = new IDBFactory();
  Object.defineProperty(failingIndexedDB, "open", { value() { throw new Error("open failed"); } });
  const fallback = createRegularCapturePersistence({
    storage: chromeStorage({
      captureStateV1: {
        version: 2,
        activeDraftId: "fallback",
        drafts: { fallback: { id: "fallback", revision: 1, doc: document("Fallback"), updatedAt: 1 } },
        captures: {}
      }
    }),
    indexedDB: failingIndexedDB
  });
  const fallbackEvents: string[] = [];
  fallback.setChangeHandler((event) => { fallbackEvents.push(event.kind); });
  await fallback.ready();
  const fallbackDraft = must(await fallback.getDraft("fallback"), "fallback draft");
  await fallback.upsertDraft({ ...fallbackDraft, title: "Forwarded fallback" }, fallbackDraft.revision);
  assert.deepEqual(fallbackEvents, ["draft"]);
});

test("post-activation index failure preserves the IndexedDB mutation, notifies, and repairs on restart", async () => {
  const storage = chromeStorage();
  const indexedDB = new IDBFactory();
  const firstRun = createRegularCapturePersistence({ storage, indexedDB, now: () => 500, uuid: () => "capture" });
  await firstRun.ready();
  const set = storage.set.bind(storage);
  let failIndex = true;
  storage.set = async (values) => {
    if (failIndex && values.captureIndexV3) throw new Error("index synchronization failed");
    return set(values);
  };
  const events: string[] = [];
  firstRun.setChangeHandler((event) => { events.push(event.kind); });

  const record = await firstRun.enqueue({
    capture: { document: { doc: document("Durable") } },
    context: {},
    destination: null,
    connectionId: "",
    status: DELIVERY_STATES.blockedSetup
  });
  assert.equal(firstRun.backendName, "indexeddb");
  assert.equal(must(await firstRun.getCapture(record.id), "durable domain mutation").id, record.id);
  assert.deepEqual(events, ["capture"]);
  assert.match(firstRun.migrationError, /index synchronization failed/);
  assert.equal(mustRecord(storage.values.captureIndexV3, "stale capture index").unresolvedCount, 0);

  failIndex = false;
  const restarted = createRegularCapturePersistence({ storage, indexedDB });
  await restarted.ready();
  assert.equal(restarted.backendName, "indexeddb");
  assert.equal(restarted.migrationError, "");
  assert.equal(mustRecord(storage.values.captureIndexV3, "repaired capture index").unresolvedCount, 1);
  assert.equal(must(await restarted.getCapture(record.id), "capture after restart").id, record.id);
});

test("legacy fallback uses canonical maintenance, counts, and logical-size diagnostics", async () => {
  const timestamp = 31 * 24 * 60 * 60 * 1000;
  const storage = chromeStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "",
      drafts: {},
      captures: {
        old: { id: "old", status: DELIVERY_STATES.delivered, updatedAt: 0 },
        interrupted: {
          id: "interrupted",
          status: DELIVERY_STATES.sending,
          destination: { managedDestination: true },
          updatedAt: 0
        }
      }
    }
  });
  const failingIndexedDB = new IDBFactory();
  Object.defineProperty(failingIndexedDB, "open", { value() { throw new Error("offline"); } });
  const repository = createRegularCapturePersistence({ storage, indexedDB: failingIndexedDB, now: () => timestamp });
  await repository.ready();
  await repository.maintain({ recoverInterrupted: true, force: true });

  assert.equal(await repository.getCapture("old"), null);
  assert.equal(must(await repository.getCapture("interrupted"), "recovered capture").status, DELIVERY_STATES.pending);
  assert.deepEqual(await repository.countByStatus(), { pending: 1 });
  assert.ok(await repository.logicalBytes() > 0);
  assert.equal((repository as Record<string, unknown>).save, undefined);
  assert.equal((repository as Record<string, unknown>).updateState, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createIndexedDbBackend } from "../src/capture-indexed-db.js";
import { createKeyedCaptureBackend } from "../src/capture-key-store.js";
import { createLegacyGraphBackend } from "../src/capture-legacy-backend.js";
import { CaptureStorageError, normalizeDraft, normalizeRecord } from "../src/capture-store.js";
import type {
  CaptureBackend,
  CaptureDraft,
  CaptureRecord,
  KeyValueStoragePort,
  StorageMetadata
} from "../src/contracts.js";

globalThis.IDBKeyRange = IDBKeyRange;

interface MemoryStorage extends KeyValueStoragePort {
  values: Record<string, unknown>;
  writes: number;
  failSet: boolean;
}

function memoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const values = structuredClone(initial);
  return {
    values,
    writes: 0,
    failSet: false,
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys === null || keys === undefined) return structuredClone(values);
      if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, structuredClone(values[key])]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(values[key] ?? fallback)]));
    },
    async set(next: Record<string, unknown>) {
      this.writes += 1;
      if (this.failSet) throw new Error("storage.set failed");
      Object.assign(values, structuredClone(next));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
    async getKeys() { return Object.keys(values); }
  };
}

function draft(id: string, updatedAt = 1): CaptureDraft {
  const value = normalizeDraft({
    id,
    revision: 1,
    updatedAt,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] }
  });
  assert.ok(value);
  return value;
}

function capture(id: string, draftId = "", nextAttemptAt = 0): CaptureRecord {
  const value = normalizeRecord({
    id,
    draftId,
    status: "pending",
    nextAttemptAt,
    createdAt: nextAttemptAt,
    capture: { document: { doc: { type: "doc", content: [] } } }
  });
  assert.ok(value);
  return value;
}

function meta(activeDraftId = ""): StorageMetadata {
  return {
    key: "state",
    version: 3,
    activeDraftId,
    migrationStatus: "complete",
    migrationError: "",
    lastMaintenanceAt: 10
  };
}

interface BackendFixture {
  create(): CaptureBackend;
  cleanup?(): Promise<void>;
}

function backendConformance(name: string, fixture: () => BackendFixture): void {
  test(`${name} backend conforms to capture storage transactions`, async () => {
    const source = fixture();
    const backend = source.create();
    try {
      await backend.transaction(["meta", "drafts", "captures"], "readwrite", async (tx) => {
        await tx.putDraft(draft("draft-1"));
        await tx.putMeta(meta("draft-1"));
        await tx.putCapture(capture("capture-1", "draft-1", 20));
        await tx.putCapture(capture("capture-2", "draft-2", 200));
      });

      await backend.transaction(["meta", "drafts", "captures"], "readonly", async (tx) => {
        assert.equal((await tx.getMeta())?.activeDraftId, "draft-1");
        assert.equal((await tx.getDraft("draft-1"))?.id, "draft-1");
        assert.deepEqual((await tx.getAllDrafts()).map((item) => item.id), ["draft-1"]);
        assert.equal((await tx.getCapture("capture-1"))?.id, "capture-1");
        assert.equal((await tx.findCaptureByDraftId("draft-1"))?.id, "capture-1");
        assert.deepEqual((await tx.getDueCaptures(100)).map((item) => item.id), ["capture-1"]);
      });

      await backend.transaction(["drafts", "captures"], "readwrite", async (tx) => {
        await tx.deleteDraft("draft-1");
        await tx.deleteCapture("capture-1");
      });
      await backend.transaction(["drafts", "captures"], "readonly", async (tx) => {
        assert.equal(await tx.getDraft("draft-1"), undefined);
        assert.equal(await tx.getCapture("capture-1"), undefined);
      });

      await backend.transaction(["drafts", "captures"], "readwrite", async (tx) => {
        await tx.putDraft(draft("clear-draft"));
        await tx.putCapture(capture("clear-capture"));
        await tx.clearDrafts();
        await tx.clearCaptures();
      });
      await backend.transaction(["drafts", "captures"], "readonly", async (tx) => {
        assert.deepEqual(await tx.getAllDrafts(), []);
        assert.deepEqual(await tx.getAllCaptures(), []);
      });

      await Promise.all(Array.from({ length: 12 }, (_, index) => backend.transaction(["drafts"], "readwrite", async (tx) => {
        await tx.putDraft(draft(`concurrent-${index}`, index));
      })));
      assert.equal(await backend.transaction(["drafts"], "readonly", (tx) => tx.getAllDrafts()).then((items) => items.length), 12);

      await assert.rejects(backend.transaction(["captures"], "readwrite", async (tx) => {
        await tx.putCapture(capture("rolled-back"));
        throw new Error("callback failed");
      }), /callback failed/);
      assert.equal(await backend.transaction(["captures"], "readonly", (tx) => tx.getCapture("rolled-back")), undefined);

      const reconstructed = source.create();
      assert.equal(await reconstructed.transaction(["drafts"], "readonly", (tx) => tx.getDraft("concurrent-5")).then((item) => item?.id), "concurrent-5");
    } finally {
      await source.cleanup?.();
    }
  });
}

backendConformance("IndexedDB", () => {
  const indexedDB = new IDBFactory();
  const databaseName = `capture-conformance-${crypto.randomUUID()}`;
  return { create: () => createIndexedDbBackend({ indexedDB, databaseName }) };
});

backendConformance("session-key", () => {
  const storage = memoryStorage();
  return { create: () => createKeyedCaptureBackend({ storage }) };
});

backendConformance("legacy graph", () => {
  const storage = memoryStorage();
  return { create: () => createLegacyGraphBackend({ storage }) };
});

test("legacy graph backend migrates v1 and derives metadata without changing CaptureState", async () => {
  const storage = memoryStorage({
    captureStateV1: {
      version: 1,
      activeDraftByTab: { 1: "older", 2: "newer" },
      drafts: {
        older: draft("older", 10),
        newer: draft("newer", 20)
      },
      captures: {}
    }
  });
  const backend = createLegacyGraphBackend({ storage });
  const metadata = await backend.transaction(["meta"], "readonly", (tx) => tx.getMeta());
  assert.equal(metadata?.activeDraftId, "newer");
  assert.equal(metadata?.migrationStatus, "legacy");

  await backend.transaction(["meta", "drafts"], "readwrite", async (tx) => {
    await tx.putMeta({ ...meta("older"), migrationStatus: "legacy" });
  });
  const graph = storage.values.captureStateV1 as Record<string, unknown>;
  assert.equal(graph.activeDraftId, "older");
  assert.equal((graph.storageMetadata as StorageMetadata).activeDraftId, "older");
});

test("legacy graph backend normalizes corrupt entries and synchronizes deleted active drafts", async () => {
  const storage = memoryStorage({
    captureStateV1: {
      version: 2,
      activeDraftId: "valid",
      drafts: { valid: draft("valid"), corrupt: "bad" },
      captures: { corrupt: 42 }
    }
  });
  const backend = createLegacyGraphBackend({ storage });
  await backend.transaction(["drafts"], "readwrite", (tx) => tx.deleteDraft("valid"));
  const graph = storage.values.captureStateV1 as Record<string, unknown>;
  assert.deepEqual(graph.drafts, {});
  assert.deepEqual(graph.captures, {});
  assert.equal(graph.activeDraftId, "");
  assert.equal((graph.storageMetadata as StorageMetadata).activeDraftId, "");
});

test("legacy graph backend rejects oversized writes and failed storage.set leaves the prior graph visible", async () => {
  const storage = memoryStorage();
  const quotaBackend = createLegacyGraphBackend({ storage, softLimitBytes: 300 });
  await assert.rejects(
    quotaBackend.transaction(["drafts"], "readwrite", (tx) => tx.putDraft(draft("x".repeat(500)))),
    (error) => error instanceof CaptureStorageError && error.code === "capture_storage_full"
  );
  assert.equal(storage.values.captureStateV1, undefined);

  const backend = createLegacyGraphBackend({ storage, softLimitBytes: 10_000 });
  await backend.transaction(["drafts"], "readwrite", (tx) => tx.putDraft(draft("committed")));
  storage.failSet = true;
  await assert.rejects(backend.transaction(["drafts"], "readwrite", (tx) => tx.putDraft(draft("uncommitted"))), /storage.set failed/);
  storage.failSet = false;
  assert.equal(await backend.transaction(["drafts"], "readonly", (tx) => tx.getDraft("uncommitted")), undefined);
  assert.equal((await backend.transaction(["drafts"], "readonly", (tx) => tx.getDraft("committed")))?.id, "committed");
});

import { CAPTURE_META_KEY, emptyCaptureMeta } from "./capture-record-repository.js";
import { normalizeDraft, normalizeRecord } from "./capture-store.js";
import { isRecord } from "./contracts.js";
import type {
  CaptureBackend,
  CaptureBackendTransaction,
  CaptureDraft,
  CaptureRecord,
  CaptureStoreName,
  CaptureTransactionMode,
  StorageMetadata
} from "./contracts.js";

export const CAPTURE_DATABASE_NAME = "notionQuickNoteCaptureStore";
export const CAPTURE_DATABASE_VERSION = 1;
export const REGULAR_CAPTURE_INDEX_KEY = "captureIndexV3";

interface IndexedDbBackendOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

export function createIndexedDbBackend({ indexedDB: factory = globalThis.indexedDB, databaseName = CAPTURE_DATABASE_NAME }: IndexedDbBackendOptions = {}): CaptureBackend & { deleteDatabase(): Promise<void> } {
  if (!factory) throw new Error("IndexedDB is unavailable.");
  let databasePromise: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (!databasePromise) {
      databasePromise = openRequestPromise(factory.open(databaseName, CAPTURE_DATABASE_VERSION), (request) => {
        const database = request.result;
        const transaction = request.transaction;
        const meta = database.createObjectStore("meta", { keyPath: "key" });
        const drafts = database.createObjectStore("drafts", { keyPath: "id" });
        drafts.createIndex("updatedAt", "updatedAt");
        drafts.createIndex("editTarget", ["mode", "targetRecordId"]);
        const captures = database.createObjectStore("captures", { keyPath: "id" });
        captures.createIndex("draftId", "draftId");
        captures.createIndex("status", "status");
        captures.createIndex("updatedAt", "updatedAt");
        captures.createIndex("due", ["status", "nextAttemptAt"]);
        meta.put(emptyCaptureMeta());
        if (!transaction) throw new Error("IndexedDB upgrade transaction is unavailable.");
        transaction.onerror = () => {
          databasePromise = undefined;
        };
      });
    }
    return databasePromise;
  }

  return {
    name: "indexeddb",
    async transaction<T>(storeNames: CaptureStoreName[], mode: CaptureTransactionMode, callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
      const database = await open();
      const transaction = database.transaction(storeNames, mode, { durability: mode === "readwrite" ? "strict" : "default" });
      const stores: Partial<Record<CaptureStoreName, IDBObjectStore>> = Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]));
      const done = transactionDone(transaction);
      try {
        const result = await callback(transactionApi(stores));
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch {}
        await done.catch(() => undefined);
        throw error;
      }
    },
    async deleteDatabase() {
      const database = await databasePromise?.catch(() => null);
      database?.close();
      databasePromise = undefined;
      await requestPromise(factory.deleteDatabase(databaseName));
    }
  };
}

function transactionApi(stores: Partial<Record<CaptureStoreName, IDBObjectStore>>): CaptureBackendTransaction {
  const meta = stores.meta;
  const drafts = stores.drafts;
  const captures = stores.captures;
  return {
    getMeta: async () => meta ? normalizeMeta(await requestPromise<unknown>(meta.get(CAPTURE_META_KEY))) : undefined,
    putMeta: (value: StorageMetadata) => requestPromise(requireStore(meta, "meta").put({ ...value, key: CAPTURE_META_KEY })),
    getDraft: async (id: string) => normalizeOptionalDraft(await requestPromise<unknown>(requireStore(drafts, "drafts").get(id))),
    putDraft: (draft: CaptureDraft) => requestPromise(requireStore(drafts, "drafts").put(structuredClone(draft))),
    deleteDraft: (id: string) => requestPromise(requireStore(drafts, "drafts").delete(id)),
    clearDrafts: () => requestPromise(requireStore(drafts, "drafts").clear()),
    getAllDrafts: async () => normalizeDrafts(await requestPromise<unknown[]>(requireStore(drafts, "drafts").getAll())),
    getCapture: async (id: string) => normalizeOptionalRecord(await requestPromise<unknown>(requireStore(captures, "captures").get(id))),
    putCapture: (record: CaptureRecord) => requestPromise(requireStore(captures, "captures").put(structuredClone(record))),
    deleteCapture: (id: string) => requestPromise(requireStore(captures, "captures").delete(id)),
    clearCaptures: () => requestPromise(requireStore(captures, "captures").clear()),
    getAllCaptures: async () => normalizeRecords(await requestPromise<unknown[]>(requireStore(captures, "captures").getAll())),
    findCaptureByDraftId: async (draftId: string) => normalizeOptionalRecord(await requestPromise<unknown>(requireStore(captures, "captures").index("draftId").get(draftId))),
    getDueCaptures: async (timestamp: number) => normalizeRecords(await requestPromise<unknown[]>(requireStore(captures, "captures").index("due").getAll(
      IDBKeyRange.bound(["pending", 0], ["pending", Number(timestamp)])
    )))
  };
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function openRequestPromise(request: IDBOpenDBRequest, upgrade: (request: IDBOpenDBRequest) => void): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => upgrade(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another extension context."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
}

function requireStore(store: IDBObjectStore | undefined, name: CaptureStoreName): IDBObjectStore {
  if (!store) throw new Error(`IndexedDB transaction is missing the ${name} store.`);
  return store;
}

function normalizeOptionalDraft(value: unknown): CaptureDraft | undefined {
  return value === undefined ? undefined : normalizeDraft(value) || undefined;
}

function normalizeOptionalRecord(value: unknown): CaptureRecord | undefined {
  return value === undefined ? undefined : normalizeRecord(value) || undefined;
}

function normalizeDrafts(values: unknown[]): CaptureDraft[] {
  return values.map((value) => normalizeDraft(value)).filter((value): value is CaptureDraft => value !== null);
}

function normalizeRecords(values: unknown[]): CaptureRecord[] {
  return values.map((value) => normalizeRecord(value)).filter((value): value is CaptureRecord => value !== null);
}

function normalizeMeta(value: unknown): StorageMetadata | undefined {
  if (value === undefined) return undefined;
  const meta = isRecord(value) ? value : {};
  const migrationStatus = meta.migrationStatus === "complete" || meta.migrationStatus === "failed" || meta.migrationStatus === "imported" || meta.migrationStatus === "legacy"
    ? meta.migrationStatus
    : "pending";
  return {
    key: "state",
    version: 3,
    activeDraftId: typeof meta.activeDraftId === "string" ? meta.activeDraftId : "",
    migrationStatus,
    migrationError: typeof meta.migrationError === "string" ? meta.migrationError : "",
    lastMaintenanceAt: typeof meta.lastMaintenanceAt === "number" ? meta.lastMaintenanceAt : 0,
    ...(typeof meta.migratedAt === "number" ? { migratedAt: meta.migratedAt } : {})
  };
}

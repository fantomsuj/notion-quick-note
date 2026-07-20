// @ts-nocheck
import { CAPTURE_META_KEY, emptyCaptureMeta } from "./capture-record-repository.js";

export const CAPTURE_DATABASE_NAME = "notionQuickNoteCaptureStore";
export const CAPTURE_DATABASE_VERSION = 1;
export const REGULAR_CAPTURE_INDEX_KEY = "captureIndexV3";

export function createIndexedDbBackend({ indexedDB: factory = globalThis.indexedDB, databaseName = CAPTURE_DATABASE_NAME } = {}) {
  if (!factory) throw new Error("IndexedDB is unavailable.");
  let databasePromise;

  function open() {
    if (!databasePromise) {
      databasePromise = requestPromise(factory.open(databaseName, CAPTURE_DATABASE_VERSION), (request) => {
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
        transaction.onerror = () => {
          databasePromise = undefined;
        };
      });
    }
    return databasePromise;
  }

  return {
    name: "indexeddb",
    async transaction(storeNames, mode, callback) {
      const database = await open();
      const transaction = database.transaction(storeNames, mode, { durability: mode === "readwrite" ? "strict" : "default" });
      const stores = Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]));
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

function transactionApi(stores) {
  const meta = stores.meta;
  const drafts = stores.drafts;
  const captures = stores.captures;
  return {
    getMeta: () => meta ? requestPromise(meta.get(CAPTURE_META_KEY)) : Promise.resolve(undefined),
    putMeta: (value) => requestPromise(meta.put({ ...value, key: CAPTURE_META_KEY })),
    getDraft: (id) => requestPromise(drafts.get(id)),
    putDraft: (draft) => requestPromise(drafts.put(structuredClone(draft))),
    deleteDraft: (id) => requestPromise(drafts.delete(id)),
    clearDrafts: () => requestPromise(drafts.clear()),
    getAllDrafts: () => requestPromise(drafts.getAll()),
    getCapture: (id) => requestPromise(captures.get(id)),
    putCapture: (record) => requestPromise(captures.put(structuredClone(record))),
    deleteCapture: (id) => requestPromise(captures.delete(id)),
    clearCaptures: () => requestPromise(captures.clear()),
    getAllCaptures: () => requestPromise(captures.getAll()),
    findCaptureByDraftId: (draftId) => requestPromise(captures.index("draftId").get(draftId)),
    getDueCaptures: (timestamp) => requestPromise(captures.index("due").getAll(
      IDBKeyRange.bound(["pending", 0], ["pending", Number(timestamp)])
    ))
  };
}

function requestPromise(request, upgrade) {
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => upgrade?.(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another extension context."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
}

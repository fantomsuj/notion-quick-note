// @ts-nocheck
import {
  createCaptureRepository,
  emptyCaptureState,
  INCOGNITO_CAPTURE_STATE_KEY,
  normalizeCaptureState,
  REGULAR_CAPTURE_STATE_KEY
} from "./capture-store.js";
import { createIndexedDbBackend, REGULAR_CAPTURE_INDEX_KEY } from "./capture-indexed-db.js";
import { createKeyedCaptureBackend, INCOGNITO_CAPTURE_INDEX_KEY } from "./capture-key-store.js";
import { CAPTURE_INDEX_VERSION, createRecordCaptureRepository } from "./capture-record-repository.js";

export function createRegularCapturePersistence({
  storage,
  indexedDB = globalThis.indexedDB,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID()
}) {
  const legacy = createCaptureRepository({ storage, key: REGULAR_CAPTURE_STATE_KEY, now, uuid });
  const backend = createIndexedDbBackend({ indexedDB });
  const records = createRecordCaptureRepository({ backend, now, uuid });
  let active = records;
  let initialized;
  let migrationError = "";
  let readyComplete = false;
  let externalChangeHandler = async () => undefined;

  records.setChangeHandler(async (event) => {
    if (!readyComplete) return;
    if (event.structural) await syncRegularIndex(records, storage, migrationError).catch((error) => { migrationError = error.message; });
    await externalChangeHandler(event);
  });

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      let meta;
      try {
        meta = await records.getMeta();
      } catch (error) {
        migrationError = error.message;
        active = legacy;
        readyComplete = true;
        return { backend: "legacy", migrationError };
      }

      const legacyValue = (await storage.get(REGULAR_CAPTURE_STATE_KEY))[REGULAR_CAPTURE_STATE_KEY];
      if (meta.migrationStatus !== "complete") {
        try {
          await records.importState(normalizeCaptureState(legacyValue), {
            migrationStatus: "imported",
            migrationError: "",
            migratedAt: now()
          });
          await syncRegularIndex(records, storage, "");
          meta = await records.updateMeta({ migrationStatus: "complete", migrationError: "" });
        } catch (error) {
          migrationError = error.message;
          await records.updateMeta({ migrationStatus: "pending", migrationError }).catch(() => undefined);
          active = legacy;
          readyComplete = true;
          return { backend: "legacy", migrationError };
        }
      } else {
        try {
          await syncRegularIndex(records, storage, "");
        } catch (error) {
          migrationError = error.message;
        }
      }
      if (legacyValue !== undefined) {
        await storage.remove(REGULAR_CAPTURE_STATE_KEY).catch((error) => { migrationError = error.message; });
      }
      readyComplete = true;
      return { backend: "indexeddb", migrationError };
    })();
    return initialized;
  }

  return delegatePersistence({
    initialize,
    active: () => active,
    backendName: () => active === legacy ? "legacy" : "indexeddb",
    migrationError: () => migrationError,
    setChangeHandler(handler) { externalChangeHandler = handler; }
  });
}

export function createIncognitoCapturePersistence({ storage, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
  const backend = createKeyedCaptureBackend({ storage });
  const records = createRecordCaptureRepository({ backend, now, uuid });
  let initialized;
  let migrationError = "";
  let readyComplete = false;
  let externalChangeHandler = async () => undefined;
  records.setChangeHandler((event) => readyComplete ? externalChangeHandler(event) : undefined);

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      try {
        const stored = await storage.get([INCOGNITO_CAPTURE_INDEX_KEY, INCOGNITO_CAPTURE_STATE_KEY]);
        if (!stored[INCOGNITO_CAPTURE_INDEX_KEY]) {
          await records.importState(
            stored[INCOGNITO_CAPTURE_STATE_KEY] === undefined
              ? emptyCaptureState()
              : normalizeCaptureState(stored[INCOGNITO_CAPTURE_STATE_KEY]),
            { migrationStatus: "complete", migratedAt: now() }
          );
        }
        if (stored[INCOGNITO_CAPTURE_STATE_KEY] !== undefined) await storage.remove(INCOGNITO_CAPTURE_STATE_KEY);
        await backend.reconcile();
        readyComplete = true;
      } catch (error) {
        migrationError = error.message;
        throw error;
      }
      return { backend: "session-keys", migrationError };
    })();
    return initialized;
  }

  return delegatePersistence({
    initialize,
    active: () => records,
    backendName: () => "session-keys",
    migrationError: () => migrationError,
    setChangeHandler(handler) { externalChangeHandler = handler; }
  });
}

function delegatePersistence(configuration) {
  const wrapper = {
    ready: configuration.initialize,
    initialize: configuration.initialize,
    setChangeHandler: configuration.setChangeHandler,
    get backendName() { return configuration.backendName(); },
    get migrationError() { return configuration.migrationError(); }
  };
  for (const method of [
    "load", "save", "updateState", "importState", "getMeta", "getDraft", "getActiveDraft", "getCapture",
    "findCaptureByDraftId", "listDrafts", "listCaptures", "listDueCaptures", "countByStatus", "getOrCreateDraft",
    "upsertDraft", "activateDraft", "createEditDraft", "convertEditDraftToNew", "discardDraft", "enqueue",
    "enqueueUpdate", "updateCapture", "claimCapture", "removeCapture", "maintain", "logicalBytes"
  ]) {
    wrapper[method] = async (...args) => {
      await configuration.initialize();
      const repository = configuration.active();
      if (typeof repository[method] === "function") return repository[method](...args);
      if (method === "getDraft") return (await repository.load()).drafts[String(args[0] || "")] || null;
      if (method === "getMeta") {
        const state = await repository.load();
        return {
          key: "state",
          version: CAPTURE_INDEX_VERSION,
          activeDraftId: state.activeDraftId || "",
          migrationStatus: "legacy",
          migrationError: configuration.migrationError(),
          lastMaintenanceAt: 0
        };
      }
      if (method === "getActiveDraft") {
        const state = await repository.load();
        return state.drafts[state.activeDraftId] || null;
      }
      if (method === "getCapture") return (await repository.load()).captures[String(args[0] || "")] || null;
      if (method === "findCaptureByDraftId") return Object.values((await repository.load()).captures).find((item) => item.draftId === args[0]) || null;
      if (method === "listDrafts") return Object.values((await repository.load()).drafts);
      if (method === "listCaptures") {
        const records = Object.values((await repository.load()).captures);
        const statuses = args[0]?.statuses;
        return statuses?.length ? records.filter((item) => statuses.includes(item.status)) : records;
      }
      if (method === "listDueCaptures") return Object.values((await repository.load()).captures)
        .filter((item) => item.status === "pending" && item.nextAttemptAt <= args[0]);
      if (method === "countByStatus") return Object.values((await repository.load()).captures).reduce((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {});
      if (method === "logicalBytes") return new TextEncoder().encode(JSON.stringify(await repository.load())).length;
      if (method === "maintain") return repository.updateState(() => undefined);
      throw new Error(`Capture repository method ${method} is unavailable.`);
    };
  }
  return wrapper;
}

async function syncRegularIndex(repository, storage, migrationError) {
  const [meta, drafts, captures] = await Promise.all([
    repository.getMeta(), repository.listDrafts(), repository.listCaptures()
  ]);
  const unresolvedCount = captures.filter((record) => record.status !== "delivered").length;
  await storage.set({
    [REGULAR_CAPTURE_INDEX_KEY]: {
      version: CAPTURE_INDEX_VERSION,
      activeDraftId: meta.activeDraftId || "",
      draftCount: drafts.length,
      unresolvedCount,
      deliveredCount: captures.length - unresolvedCount,
      migrationStatus: migrationError ? "warning" : "complete",
      migrationError,
      lastMaintenanceAt: Number(meta.lastMaintenanceAt || 0)
    }
  });
}

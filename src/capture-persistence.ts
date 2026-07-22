import { createIndexedDbBackend, REGULAR_CAPTURE_INDEX_KEY } from "./capture-indexed-db.js";
import { createKeyedCaptureBackend, INCOGNITO_CAPTURE_INDEX_KEY } from "./capture-key-store.js";
import { createLegacyGraphBackend } from "./capture-legacy-backend.js";
import { CAPTURE_INDEX_VERSION, createRecordCaptureRepository } from "./capture-record-repository.js";
import {
  emptyCaptureState,
  INCOGNITO_CAPTURE_STATE_KEY,
  normalizeCaptureState,
  REGULAR_CAPTURE_STATE_KEY
} from "./capture-store.js";
import type {
  CaptureChangeEvent,
  CaptureChangeHandler,
  Clock,
  KeyValueStoragePort,
  UUIDFactory
} from "./contracts.js";
import { isRecord } from "./contracts.js";

type RecordRepository = ReturnType<typeof createRecordCaptureRepository>;
type ActiveRepository = RecordRepository;

interface PersistenceInitialization {
  backend: "legacy" | "indexeddb" | "session-keys";
  migrationError: string;
}

interface PersistenceConfiguration {
  initialize: () => Promise<PersistenceInitialization>;
  active: () => ActiveRepository;
  backendName: () => string;
  migrationError: () => string;
  setChangeHandler: (handler: CaptureChangeHandler) => void;
}

export function createRegularCapturePersistence({
  storage,
  indexedDB = globalThis.indexedDB,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID()
}: {
  storage: KeyValueStoragePort;
  indexedDB?: IDBFactory;
  now?: Clock;
  uuid?: UUIDFactory;
}) {
  const legacy = createRecordCaptureRepository({
    backend: createLegacyGraphBackend({ storage }),
    now,
    uuid
  });
  let indexed: RecordRepository | undefined;
  let active: ActiveRepository = legacy;
  let initialized: Promise<PersistenceInitialization> | undefined;
  let migrationError = "";
  let indexSyncError = "";
  let readyComplete = false;
  let externalChangeHandler: CaptureChangeHandler = async () => undefined;

  async function forwardChange(source: RecordRepository, event: CaptureChangeEvent): Promise<void> {
    if (!readyComplete || source !== active) return;
    if (source === indexed && event.structural) {
      try {
        await syncRegularIndex(source, storage, "");
        if (migrationError === indexSyncError) migrationError = "";
        indexSyncError = "";
      } catch (error: unknown) {
        indexSyncError = errorMessage(error);
        migrationError = indexSyncError;
      }
    }
    await externalChangeHandler(event);
  }

  legacy.setChangeHandler((event) => forwardChange(legacy, event));

  async function useLegacyAfterFailure(error: unknown): Promise<PersistenceInitialization> {
    migrationError = errorMessage(error);
    active = legacy;
    await legacy.updateMeta({ migrationStatus: "legacy", migrationError }).catch(() => undefined);
    readyComplete = true;
    return { backend: "legacy", migrationError };
  }

  async function initialize(): Promise<PersistenceInitialization> {
    if (initialized) return initialized;
    initialized = (async () => {
      try {
        const backend = createIndexedDbBackend({ indexedDB });
        const records = createRecordCaptureRepository({ backend, now, uuid });
        indexed = records;
        records.setChangeHandler((event) => forwardChange(records, event));
        const metadata = await records.getMeta();

        if (metadata.migrationStatus !== "complete") {
          const legacyState = await legacy.load();
          await records.importState(legacyState, {
            migrationStatus: "imported",
            migrationError: "",
            migratedAt: now()
          });
          await syncRegularIndex(records, storage, "");
          await records.updateMeta({ migrationStatus: "complete", migrationError: "" });
        } else {
          try {
            await syncRegularIndex(records, storage, "");
          } catch (error: unknown) {
            indexSyncError = errorMessage(error);
            migrationError = indexSyncError;
          }
        }

        active = records;
        readyComplete = true;

        try {
          await storage.remove(REGULAR_CAPTURE_STATE_KEY);
        } catch (error: unknown) {
          migrationError = errorMessage(error);
        }
        return { backend: "indexeddb", migrationError };
      } catch (error: unknown) {
        return useLegacyAfterFailure(error);
      }
    })();
    return initialized;
  }

  return delegatePersistence({
    initialize,
    active: () => active,
    backendName: () => active.backendName,
    migrationError: () => migrationError,
    setChangeHandler(handler: CaptureChangeHandler) { externalChangeHandler = handler; }
  });
}

export function createIncognitoCapturePersistence({ storage, now = () => Date.now(), uuid = () => crypto.randomUUID() }: { storage: KeyValueStoragePort; now?: Clock; uuid?: UUIDFactory }) {
  const backend = createKeyedCaptureBackend({ storage });
  const records = createRecordCaptureRepository({ backend, now, uuid });
  let initialized: Promise<PersistenceInitialization> | undefined;
  let migrationError = "";
  let readyComplete = false;
  let externalChangeHandler: CaptureChangeHandler = async () => undefined;
  records.setChangeHandler((event) => readyComplete ? externalChangeHandler(event) : undefined);

  async function initialize(): Promise<PersistenceInitialization> {
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
      } catch (error: unknown) {
        migrationError = errorMessage(error);
        throw error;
      }
      return { backend: "session-keys", migrationError };
    })();
    return initialized;
  }

  return delegatePersistence({
    initialize,
    active: () => records,
    backendName: () => records.backendName,
    migrationError: () => migrationError,
    setChangeHandler(handler: CaptureChangeHandler) { externalChangeHandler = handler; }
  });
}

function delegatePersistence(configuration: PersistenceConfiguration) {
  async function repository(): Promise<ActiveRepository> {
    await configuration.initialize();
    return configuration.active();
  }

  return {
    ready: configuration.initialize,
    initialize: configuration.initialize,
    setChangeHandler: configuration.setChangeHandler,
    get backendName() { return configuration.backendName(); },
    get migrationError() { return configuration.migrationError(); },
    async load() { return (await repository()).load(); },
    async importState(...args: Parameters<RecordRepository["importState"]>) { return (await repository()).importState(...args); },
    async getMeta() { return (await repository()).getMeta(); },
    async getDraft(...args: Parameters<RecordRepository["getDraft"]>) { return (await repository()).getDraft(...args); },
    async getActiveDraft() { return (await repository()).getActiveDraft(); },
    async getCapture(...args: Parameters<RecordRepository["getCapture"]>) { return (await repository()).getCapture(...args); },
    async findCaptureByDraftId(...args: Parameters<RecordRepository["findCaptureByDraftId"]>) { return (await repository()).findCaptureByDraftId(...args); },
    async listDrafts() { return (await repository()).listDrafts(); },
    async listCaptures(...args: Parameters<RecordRepository["listCaptures"]>) { return (await repository()).listCaptures(...args); },
    async listDueCaptures(...args: Parameters<RecordRepository["listDueCaptures"]>) { return (await repository()).listDueCaptures(...args); },
    async countByStatus() { return (await repository()).countByStatus(); },
    async getOrCreateDraft(...args: Parameters<RecordRepository["getOrCreateDraft"]>) { return (await repository()).getOrCreateDraft(...args); },
    async upsertDraft(...args: Parameters<RecordRepository["upsertDraft"]>) { return (await repository()).upsertDraft(...args); },
    async activateDraft(...args: Parameters<RecordRepository["activateDraft"]>) { return (await repository()).activateDraft(...args); },
    async createEditDraft(...args: Parameters<RecordRepository["createEditDraft"]>) { return (await repository()).createEditDraft(...args); },
    async convertEditDraftToNew(...args: Parameters<RecordRepository["convertEditDraftToNew"]>) { return (await repository()).convertEditDraftToNew(...args); },
    async discardDraft(...args: Parameters<RecordRepository["discardDraft"]>) { return (await repository()).discardDraft(...args); },
    async enqueue(...args: Parameters<RecordRepository["enqueue"]>) { return (await repository()).enqueue(...args); },
    async enqueueUpdate(...args: Parameters<RecordRepository["enqueueUpdate"]>) { return (await repository()).enqueueUpdate(...args); },
    async updateCapture(...args: Parameters<RecordRepository["updateCapture"]>) { return (await repository()).updateCapture(...args); },
    async claimCapture(...args: Parameters<RecordRepository["claimCapture"]>) { return (await repository()).claimCapture(...args); },
    async removeCapture(...args: Parameters<RecordRepository["removeCapture"]>) { return (await repository()).removeCapture(...args); },
    async findCaptureByRemotePageId(...args: Parameters<RecordRepository["findCaptureByRemotePageId"]>) { return (await repository()).findCaptureByRemotePageId(...args); },
    async ensureImportedRemoteCapture(...args: Parameters<RecordRepository["ensureImportedRemoteCapture"]>) { return (await repository()).ensureImportedRemoteCapture(...args); },
    async maintain(...args: Parameters<RecordRepository["maintain"]>) { return (await repository()).maintain(...args); },
    async logicalBytes() { return (await repository()).logicalBytes(); }
  };
}

async function syncRegularIndex(repository: RecordRepository, storage: KeyValueStoragePort, migrationError: string): Promise<void> {
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

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : "Capture persistence failed.";
}

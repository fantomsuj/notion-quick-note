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
import type {
  CaptureChangeHandler,
  Clock,
  DeliveryState,
  KeyValueStoragePort,
  StorageMetadata,
  UUIDFactory
} from "./contracts.js";
import { isRecord } from "./contracts.js";

type LegacyRepository = ReturnType<typeof createCaptureRepository>;
type RecordRepository = ReturnType<typeof createRecordCaptureRepository>;
type ActiveRepository = LegacyRepository | RecordRepository;

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
  const legacy = createCaptureRepository({ storage, key: REGULAR_CAPTURE_STATE_KEY, now, uuid });
  const backend = createIndexedDbBackend({ indexedDB });
  const records = createRecordCaptureRepository({ backend, now, uuid });
  let active: ActiveRepository = records;
  let initialized: Promise<PersistenceInitialization> | undefined;
  let migrationError = "";
  let readyComplete = false;
  let externalChangeHandler: CaptureChangeHandler = async () => undefined;

  records.setChangeHandler(async (event) => {
    if (!readyComplete) return;
    if (event.structural) await syncRegularIndex(records, storage, migrationError).catch((error: unknown) => { migrationError = errorMessage(error); });
    await externalChangeHandler(event);
  });

  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      let meta;
      try {
        meta = await records.getMeta();
      } catch (error: unknown) {
        migrationError = errorMessage(error);
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
        } catch (error: unknown) {
          migrationError = errorMessage(error);
          await records.updateMeta({ migrationStatus: "pending", migrationError }).catch(() => undefined);
          active = legacy;
          readyComplete = true;
          return { backend: "legacy", migrationError };
        }
      } else {
        try {
          await syncRegularIndex(records, storage, "");
        } catch (error: unknown) {
          migrationError = errorMessage(error);
        }
      }
      if (legacyValue !== undefined) {
        await storage.remove(REGULAR_CAPTURE_STATE_KEY).catch((error: unknown) => { migrationError = errorMessage(error); });
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
    backendName: () => "session-keys",
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
    async save(...args: Parameters<LegacyRepository["save"]>) { return (await repository()).save(...args); },
    async updateState(...args: Parameters<LegacyRepository["updateState"]>) { return (await repository()).updateState(...args); },
    async importState(...args: Parameters<RecordRepository["importState"]>) {
      const active = await repository();
      return "importState" in active ? active.importState(...args) : active.save(args[0] || emptyCaptureState());
    },
    async getMeta(): Promise<StorageMetadata> {
      const active = await repository();
      if ("getMeta" in active) return active.getMeta();
      const state = await active.load();
        return {
          key: "state",
          version: CAPTURE_INDEX_VERSION,
          activeDraftId: state.activeDraftId || "",
          migrationStatus: "legacy",
          migrationError: configuration.migrationError(),
          lastMaintenanceAt: 0
        };
    },
    async getDraft(...args: Parameters<LegacyRepository["getDraft"]>) { return (await repository()).getDraft(...args); },
    async getActiveDraft() { return (await repository()).getActiveDraft(); },
    async getCapture(...args: Parameters<LegacyRepository["getCapture"]>) { return (await repository()).getCapture(...args); },
    async findCaptureByDraftId(...args: Parameters<LegacyRepository["findCaptureByDraftId"]>) { return (await repository()).findCaptureByDraftId(...args); },
    async listDrafts() { return (await repository()).listDrafts(); },
    async listCaptures(...args: Parameters<LegacyRepository["listCaptures"]>) { return (await repository()).listCaptures(...args); },
    async listDueCaptures(...args: Parameters<LegacyRepository["listDueCaptures"]>) { return (await repository()).listDueCaptures(...args); },
    async countByStatus(): Promise<Partial<Record<DeliveryState, number>>> {
      const active = await repository();
      if ("countByStatus" in active) return active.countByStatus();
      return (await active.listCaptures()).reduce<Partial<Record<DeliveryState, number>>>((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {});
    },
    async getOrCreateDraft(...args: Parameters<LegacyRepository["getOrCreateDraft"]>) { return (await repository()).getOrCreateDraft(...args); },
    async upsertDraft(...args: Parameters<LegacyRepository["upsertDraft"]>) { return (await repository()).upsertDraft(...args); },
    async activateDraft(...args: Parameters<LegacyRepository["activateDraft"]>) { return (await repository()).activateDraft(...args); },
    async createEditDraft(...args: Parameters<LegacyRepository["createEditDraft"]>) { return (await repository()).createEditDraft(...args); },
    async convertEditDraftToNew(...args: Parameters<LegacyRepository["convertEditDraftToNew"]>) { return (await repository()).convertEditDraftToNew(...args); },
    async discardDraft(...args: Parameters<LegacyRepository["discardDraft"]>) { return (await repository()).discardDraft(...args); },
    async enqueue(...args: Parameters<LegacyRepository["enqueue"]>) { return (await repository()).enqueue(...args); },
    async enqueueUpdate(...args: Parameters<LegacyRepository["enqueueUpdate"]>) { return (await repository()).enqueueUpdate(...args); },
    async updateCapture(...args: Parameters<LegacyRepository["updateCapture"]>) { return (await repository()).updateCapture(...args); },
    async claimCapture(...args: Parameters<LegacyRepository["claimCapture"]>) { return (await repository()).claimCapture(...args); },
    async removeCapture(...args: Parameters<LegacyRepository["removeCapture"]>) { return (await repository()).removeCapture(...args); },
    async findCaptureByRemotePageId(...args: Parameters<LegacyRepository["findCaptureByRemotePageId"]>) { return (await repository()).findCaptureByRemotePageId(...args); },
    async ensureImportedRemoteCapture(...args: Parameters<LegacyRepository["ensureImportedRemoteCapture"]>) { return (await repository()).ensureImportedRemoteCapture(...args); },
    async maintain(...args: Parameters<RecordRepository["maintain"]>) {
      const active = await repository();
      return "maintain" in active ? active.maintain(...args) : active.updateState(() => undefined).then(() => ({ changed: false, maintained: false }));
    },
    async logicalBytes(): Promise<number> {
      const active = await repository();
      return "logicalBytes" in active
        ? active.logicalBytes()
        : new TextEncoder().encode(JSON.stringify(await active.load())).length;
    }
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

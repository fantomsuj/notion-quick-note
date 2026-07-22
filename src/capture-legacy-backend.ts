import { CAPTURE_INDEX_VERSION, CAPTURE_META_KEY } from "./capture-record-repository.js";
import {
  CaptureStorageError,
  normalizeCaptureState,
  normalizeDraft,
  normalizeRecord,
  REGULAR_CAPTURE_STATE_KEY
} from "./capture-store.js";
import type {
  CaptureBackend,
  CaptureBackendTransaction,
  CaptureDraft,
  CaptureRecord,
  CaptureState,
  CaptureStoreName,
  CaptureTransactionMode,
  KeyValueStoragePort,
  StorageMetadata
} from "./contracts.js";
import { isRecord } from "./contracts.js";

const SOFT_LIMIT_BYTES = 8 * 1024 * 1024;

type LegacyCaptureGraph = CaptureState & {
  storageMetadata?: StorageMetadata;
};

interface LegacyGraphBackendOptions {
  storage: KeyValueStoragePort;
  key?: string;
  softLimitBytes?: number;
}

export function createLegacyGraphBackend({
  storage,
  key = REGULAR_CAPTURE_STATE_KEY,
  softLimitBytes = SOFT_LIMIT_BYTES
}: LegacyGraphBackendOptions): CaptureBackend {
  let mutation: Promise<unknown> = Promise.resolve();

  async function execute<T>(mode: CaptureTransactionMode, callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
    const stored = (await storage.get(key))[key];
    const graph = readGraph(stored);
    let dirty = false;

    function changed(): void {
      if (mode === "readonly") throw new Error("Cannot mutate a readonly capture transaction.");
      dirty = true;
    }

    function synchronizeActiveDraft(): void {
      const activeDraftId = graph.drafts[graph.activeDraftId] ? graph.activeDraftId : "";
      graph.activeDraftId = activeDraftId;
      graph.storageMetadata = { ...metadataFor(graph), activeDraftId };
    }

    const transaction: CaptureBackendTransaction = {
      getMeta: async () => structuredClone(metadataFor(graph)),
      putMeta: async (value: StorageMetadata) => {
        changed();
        graph.storageMetadata = normalizeMetadata(value, value.activeDraftId);
        graph.activeDraftId = graph.drafts[graph.storageMetadata.activeDraftId]
          ? graph.storageMetadata.activeDraftId
          : "";
        graph.storageMetadata.activeDraftId = graph.activeDraftId;
      },
      getDraft: async (id: string) => cloneOptional(graph.drafts[id]),
      putDraft: async (value: CaptureDraft) => {
        changed();
        const draft = normalizeDraft(value);
        if (!draft) throw new Error("Cannot store an invalid capture draft.");
        graph.drafts[draft.id] = draft;
        synchronizeActiveDraft();
      },
      deleteDraft: async (id: string) => {
        changed();
        delete graph.drafts[id];
        synchronizeActiveDraft();
      },
      clearDrafts: async () => {
        changed();
        graph.drafts = {};
        synchronizeActiveDraft();
      },
      getAllDrafts: async () => structuredClone(Object.values(graph.drafts)),
      getCapture: async (id: string) => cloneOptional(graph.captures[id]),
      putCapture: async (value: CaptureRecord) => {
        changed();
        const record = normalizeRecord(value);
        if (!record) throw new Error("Cannot store an invalid capture record.");
        graph.captures[record.id] = record;
      },
      deleteCapture: async (id: string) => {
        changed();
        delete graph.captures[id];
      },
      clearCaptures: async () => {
        changed();
        graph.captures = {};
      },
      getAllCaptures: async () => structuredClone(Object.values(graph.captures)),
      findCaptureByDraftId: async (draftId: string) => cloneOptional(
        Object.values(graph.captures).find((record) => record.draftId === draftId)
      ),
      getDueCaptures: async (timestamp: number) => structuredClone(
        Object.values(graph.captures).filter((record) => record.status === "pending" && record.nextAttemptAt <= timestamp)
      )
    };

    const result = await callback(transaction);
    if (mode === "readwrite" && dirty) {
      synchronizeActiveDraft();
      const payload = { [key]: graph };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > softLimitBytes) {
        throw new CaptureStorageError(
          "Quick Note local storage is full. Remove old drafts or delivered history before saving.",
          "capture_storage_full"
        );
      }
      await storage.set(payload);
    }
    return result;
  }

  return {
    name: "legacy",
    transaction<T>(_stores: CaptureStoreName[], mode: CaptureTransactionMode, callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
      if (mode === "readonly") return execute(mode, callback);
      const task = mutation.then(() => execute(mode, callback));
      mutation = task.catch(() => undefined);
      return task;
    }
  };
}

function readGraph(value: unknown): LegacyCaptureGraph {
  const state = normalizeCaptureState(value);
  return {
    ...structuredClone(state),
    storageMetadata: normalizeMetadata(isRecord(value) ? value.storageMetadata : undefined, state.activeDraftId)
  };
}

function metadataFor(graph: LegacyCaptureGraph): StorageMetadata {
  return normalizeMetadata(graph.storageMetadata, graph.activeDraftId);
}

function normalizeMetadata(value: unknown, activeDraftId: string): StorageMetadata {
  const metadata = isRecord(value) ? value : {};
  const migrationStatus: StorageMetadata["migrationStatus"] =
    metadata.migrationStatus === "complete" ||
    metadata.migrationStatus === "failed" ||
    metadata.migrationStatus === "pending" ||
    metadata.migrationStatus === "imported" ||
    metadata.migrationStatus === "legacy"
      ? metadata.migrationStatus
      : "legacy";
  return {
    key: CAPTURE_META_KEY,
    version: CAPTURE_INDEX_VERSION,
    activeDraftId,
    migrationStatus,
    migrationError: typeof metadata.migrationError === "string" ? metadata.migrationError : "",
    lastMaintenanceAt: typeof metadata.lastMaintenanceAt === "number" ? metadata.lastMaintenanceAt : 0,
    ...(typeof metadata.migratedAt === "number" ? { migratedAt: metadata.migratedAt } : {})
  };
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

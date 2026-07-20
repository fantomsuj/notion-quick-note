import { CAPTURE_INDEX_VERSION, emptyCaptureMeta } from "./capture-record-repository.js";
import { normalizeDraft, normalizeRecord } from "./capture-store.js";
import type {
  CaptureBackend,
  CaptureBackendTransaction,
  CaptureDraft,
  CaptureRecord,
  CaptureStoreName,
  CaptureTransactionMode,
  KeyValueStoragePort,
  StorageMetadata
} from "./contracts.js";
import { isRecord } from "./contracts.js";

export const INCOGNITO_CAPTURE_INDEX_KEY = "incognitoCaptureIndexV3";
export const INCOGNITO_DRAFT_PREFIX = "incognitoDraftV3:";
export const INCOGNITO_CAPTURE_PREFIX = "incognitoCaptureV3:";

export function createKeyedCaptureBackend({
  storage,
  indexKey = INCOGNITO_CAPTURE_INDEX_KEY,
  draftPrefix = INCOGNITO_DRAFT_PREFIX,
  capturePrefix = INCOGNITO_CAPTURE_PREFIX
}: {
  storage: KeyValueStoragePort;
  indexKey?: string;
  draftPrefix?: string;
  capturePrefix?: string;
}): CaptureBackend & { reconcile(): Promise<CaptureKeyIndex> } {
  let mutation: Promise<unknown> = Promise.resolve();

  async function execute<T>(mode: CaptureTransactionMode, callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
    const indexValue = await storage.get(indexKey);
    const storedIndex = indexValue[indexKey];
    const index = normalizeIndex(storedIndex);
    const staged = new Map<string, unknown>();
    const deleted = new Set<string>();
    let indexChanged = storedIndex === undefined;

    async function getValue(key: string): Promise<unknown> {
      if (deleted.has(key)) return undefined;
      if (staged.has(key)) return structuredClone(staged.get(key));
      return (await storage.get(key))[key];
    }

    function stage(key: string, value: unknown): void {
      staged.set(key, structuredClone(value));
      deleted.delete(key);
    }

    function remove(key: string): void {
      staged.delete(key);
      deleted.add(key);
    }

    const api: CaptureBackendTransaction = {
      getMeta: async () => ({ ...index.meta }),
      putMeta: async (meta: StorageMetadata) => {
        index.meta = structuredClone(meta);
        indexChanged = true;
      },
      getDraft: async (id: string) => optionalDraft(await getValue(`${draftPrefix}${id}`)),
      putDraft: async (draft: CaptureDraft) => {
        stage(`${draftPrefix}${draft.id}`, draft);
        if (!index.draftIds.includes(draft.id)) {
          index.draftIds.push(draft.id);
          indexChanged = true;
        }
      },
      deleteDraft: async (id: string) => {
        remove(`${draftPrefix}${id}`);
        if (index.draftIds.includes(id)) {
          index.draftIds = index.draftIds.filter((value) => value !== id);
          indexChanged = true;
        }
      },
      clearDrafts: async () => {
        for (const id of index.draftIds) remove(`${draftPrefix}${id}`);
        index.draftIds = [];
        indexChanged = true;
      },
      getAllDrafts: async () => normalizeDrafts(await getMany(index.draftIds, draftPrefix, getValue)),
      getCapture: async (id: string) => optionalRecord(await getValue(`${capturePrefix}${id}`)),
      putCapture: async (record: CaptureRecord) => {
        stage(`${capturePrefix}${record.id}`, record);
        if (!index.captureIds.includes(record.id)) {
          index.captureIds.push(record.id);
          indexChanged = true;
        }
      },
      deleteCapture: async (id: string) => {
        remove(`${capturePrefix}${id}`);
        if (index.captureIds.includes(id)) {
          index.captureIds = index.captureIds.filter((value) => value !== id);
          indexChanged = true;
        }
      },
      clearCaptures: async () => {
        for (const id of index.captureIds) remove(`${capturePrefix}${id}`);
        index.captureIds = [];
        indexChanged = true;
      },
      getAllCaptures: async () => normalizeRecords(await getMany(index.captureIds, capturePrefix, getValue)),
      findCaptureByDraftId: async (draftId: string) => (await getMany(index.captureIds, capturePrefix, getValue))
        .map((value) => normalizeRecord(value)).find((record) => record?.draftId === draftId) || undefined,
      getDueCaptures: async (timestamp: number) => (await getMany(index.captureIds, capturePrefix, getValue))
        .map((value) => normalizeRecord(value)).filter((record): record is CaptureRecord => record !== null && record.status === "pending" && record.nextAttemptAt <= timestamp)
    };

    const result = await callback(api);
    if (mode === "readwrite") {
      const values = Object.fromEntries(staged);
      if (indexChanged) values[indexKey] = index;
      if (Object.keys(values).length) await storage.set(values);
      if (deleted.size) await storage.remove([...deleted]);
    }
    return result;
  }

  return {
    name: "session-keys",
    transaction<T>(_stores: CaptureStoreName[], mode: CaptureTransactionMode, callback: (transaction: CaptureBackendTransaction) => Promise<T> | T): Promise<T> {
      if (mode !== "readwrite") return execute(mode, callback);
      const task = mutation.then(() => execute(mode, callback));
      mutation = task.catch(() => undefined);
      return task;
    },
    async reconcile() {
      const value = await storage.get(indexKey);
      const index = normalizeIndex(value[indexKey]);
      const allKeys = storage.getKeys ? await storage.getKeys() : [];
      const expected = new Set([
        indexKey,
        ...index.draftIds.map((id) => `${draftPrefix}${id}`),
        ...index.captureIds.map((id) => `${capturePrefix}${id}`)
      ]);
      const orphans = allKeys.filter((key) => (key.startsWith(draftPrefix) || key.startsWith(capturePrefix)) && !expected.has(key));
      if (orphans.length) await storage.remove(orphans);
      return index;
    }
  };
}

interface CaptureKeyIndex {
  version: number;
  draftIds: string[];
  captureIds: string[];
  meta: StorageMetadata;
}

function normalizeIndex(value: unknown): CaptureKeyIndex {
  const index = isRecord(value) ? value : {};
  return {
    version: CAPTURE_INDEX_VERSION,
    draftIds: uniqueStrings(index.draftIds),
    captureIds: uniqueStrings(index.captureIds),
    meta: normalizeMeta(index.meta)
  };
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

async function getMany(ids: string[], prefix: string, getValue: (key: string) => Promise<unknown>): Promise<unknown[]> {
  const values = await Promise.all(ids.map((id) => getValue(`${prefix}${id}`)));
  return values.filter(Boolean);
}

function normalizeMeta(value: unknown): StorageMetadata {
  const meta = isRecord(value) ? value : {};
  const fallback = emptyCaptureMeta();
  const migrationStatus: StorageMetadata["migrationStatus"] = meta.migrationStatus === "complete" || meta.migrationStatus === "failed" || meta.migrationStatus === "pending" || meta.migrationStatus === "imported" || meta.migrationStatus === "legacy"
    ? meta.migrationStatus
    : fallback.migrationStatus;
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

function optionalDraft(value: unknown): CaptureDraft | undefined {
  return value === undefined ? undefined : normalizeDraft(value) || undefined;
}

function optionalRecord(value: unknown): CaptureRecord | undefined {
  return value === undefined ? undefined : normalizeRecord(value) || undefined;
}

function normalizeDrafts(values: unknown[]): CaptureDraft[] {
  return values.map((value) => normalizeDraft(value)).filter((value): value is CaptureDraft => value !== null);
}

function normalizeRecords(values: unknown[]): CaptureRecord[] {
  return values.map((value) => normalizeRecord(value)).filter((value): value is CaptureRecord => value !== null);
}

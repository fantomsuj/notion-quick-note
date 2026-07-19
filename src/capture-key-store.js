import { CAPTURE_INDEX_VERSION, emptyCaptureMeta } from "./capture-record-repository.js";

export const INCOGNITO_CAPTURE_INDEX_KEY = "incognitoCaptureIndexV3";
export const INCOGNITO_DRAFT_PREFIX = "incognitoDraftV3:";
export const INCOGNITO_CAPTURE_PREFIX = "incognitoCaptureV3:";

export function createKeyedCaptureBackend({
  storage,
  indexKey = INCOGNITO_CAPTURE_INDEX_KEY,
  draftPrefix = INCOGNITO_DRAFT_PREFIX,
  capturePrefix = INCOGNITO_CAPTURE_PREFIX
}) {
  let mutation = Promise.resolve();

  async function execute(mode, callback) {
    const indexValue = await storage.get(indexKey);
    const storedIndex = indexValue[indexKey];
    const index = normalizeIndex(storedIndex);
    const staged = new Map();
    const deleted = new Set();
    let indexChanged = storedIndex === undefined;

    async function getValue(key) {
      if (deleted.has(key)) return undefined;
      if (staged.has(key)) return structuredClone(staged.get(key));
      return (await storage.get(key))[key];
    }

    function stage(key, value) {
      staged.set(key, structuredClone(value));
      deleted.delete(key);
    }

    function remove(key) {
      staged.delete(key);
      deleted.add(key);
    }

    const api = {
      getMeta: async () => ({ ...index.meta }),
      putMeta: async (meta) => {
        index.meta = { ...emptyCaptureMeta(), ...structuredClone(meta) };
        indexChanged = true;
      },
      getDraft: (id) => getValue(`${draftPrefix}${id}`),
      putDraft: async (draft) => {
        stage(`${draftPrefix}${draft.id}`, draft);
        if (!index.draftIds.includes(draft.id)) {
          index.draftIds.push(draft.id);
          indexChanged = true;
        }
      },
      deleteDraft: async (id) => {
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
      getAllDrafts: async () => getMany(index.draftIds, draftPrefix, getValue),
      getCapture: (id) => getValue(`${capturePrefix}${id}`),
      putCapture: async (record) => {
        stage(`${capturePrefix}${record.id}`, record);
        if (!index.captureIds.includes(record.id)) {
          index.captureIds.push(record.id);
          indexChanged = true;
        }
      },
      deleteCapture: async (id) => {
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
      getAllCaptures: async () => getMany(index.captureIds, capturePrefix, getValue),
      findCaptureByDraftId: async (draftId) => (await getMany(index.captureIds, capturePrefix, getValue))
        .find((record) => record.draftId === draftId),
      getDueCaptures: async (timestamp) => (await getMany(index.captureIds, capturePrefix, getValue))
        .filter((record) => record.status === "pending" && record.nextAttemptAt <= timestamp)
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
    transaction(_stores, mode, callback) {
      if (mode !== "readwrite") return execute(mode, callback);
      const task = mutation.then(() => execute(mode, callback));
      mutation = task.catch(() => undefined);
      return task;
    },
    async reconcile() {
      const value = await storage.get(indexKey);
      const index = normalizeIndex(value[indexKey]);
      const allKeys = typeof storage.getKeys === "function" ? await storage.getKeys() : [];
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

function normalizeIndex(value) {
  return {
    version: CAPTURE_INDEX_VERSION,
    draftIds: uniqueStrings(value?.draftIds),
    captureIds: uniqueStrings(value?.captureIds),
    meta: { ...emptyCaptureMeta(), ...(value?.meta || {}) }
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

async function getMany(ids, prefix, getValue) {
  const values = await Promise.all(ids.map((id) => getValue(`${prefix}${id}`)));
  return values.filter(Boolean);
}

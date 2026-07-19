export const CAPTURE_STATE_VERSION = 2;
export const CAPTURE_RECORD_VERSION = 2;
export const CAPTURE_DRAFT_VERSION = 2;
export const REGULAR_CAPTURE_STATE_KEY = "captureStateV1";
export const INCOGNITO_CAPTURE_STATE_KEY = "incognitoCaptureStateV1";
export const DELIVERY_STATES = Object.freeze({
  pending: "pending",
  sending: "sending",
  delivered: "delivered",
  blockedSetup: "blocked_setup",
  blockedAuth: "blocked_auth",
  blockedDestination: "blocked_destination",
  blockedConflict: "blocked_conflict",
  uncertain: "uncertain"
});

const SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

export class CaptureStorageError extends Error {
  constructor(message, code = "capture_storage_error") {
    super(message);
    this.name = "CaptureStorageError";
    this.code = code;
  }
}

export function emptyCaptureState() {
  return { version: CAPTURE_STATE_VERSION, drafts: {}, activeDraftId: "", captures: {} };
}

export function normalizeCaptureState(value) {
  if (!value || typeof value !== "object") return emptyCaptureState();
  if (value.version === 1) return migrateCaptureStateV1(value);
  if (value.version !== CAPTURE_STATE_VERSION) return emptyCaptureState();
  const drafts = Object.fromEntries(Object.entries(objectValue(value.drafts))
    .map(([id, draft]) => [id, normalizeDraft(draft)])
    .filter(([, draft]) => hasDraftBody(draft)));
  return {
    version: CAPTURE_STATE_VERSION,
    drafts,
    activeDraftId: drafts[value.activeDraftId] ? String(value.activeDraftId) : "",
    captures: Object.fromEntries(Object.entries(objectValue(value.captures)).map(([id, record]) => [id, normalizeRecord(record)]))
  };
}

export function migrateCaptureStateV1(value) {
  const drafts = Object.fromEntries(Object.entries(objectValue(value.drafts))
    .map(([id, draft]) => [id, normalizeDraft(draft)])
    .filter(([, draft]) => hasDraftBody(draft)));
  const referenced = new Set(Object.values(objectValue(value.activeDraftByTab)).map(String));
  const referencedDrafts = Object.values(drafts).filter((draft) => referenced.has(draft.id));
  const candidates = (referencedDrafts.length ? referencedDrafts : Object.values(drafts))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  const active = candidates[0] || null;
  return {
    version: CAPTURE_STATE_VERSION,
    drafts,
    activeDraftId: active?.id || "",
    captures: Object.fromEntries(Object.entries(objectValue(value.captures)).map(([id, record]) => [id, normalizeRecord(record)]))
  };
}

export function createCaptureRepository({
  storage,
  key = REGULAR_CAPTURE_STATE_KEY,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  softLimitBytes = SOFT_LIMIT_BYTES
}) {
  let mutation = Promise.resolve();

  async function load() {
    const value = await storage.get(key);
    return normalizeCaptureState(value[key]);
  }

  async function save(state) {
    const next = pruneCaptureState(state, now());
    const bytes = new TextEncoder().encode(JSON.stringify({ [key]: next })).length;
    if (bytes > softLimitBytes) {
      throw new CaptureStorageError("Quick Note local storage is full. Remove old drafts or delivered history before saving.", "capture_storage_full");
    }
    try {
      await storage.set({ [key]: next });
    } catch (error) {
      throw new CaptureStorageError(error?.message || "Quick Note could not store this capture locally.");
    }
    return next;
  }

  function mutate(callback) {
    const task = mutation.then(async () => {
      const state = await load();
      const result = await callback(state);
      await save(state);
      return result;
    });
    mutation = task.catch(() => undefined);
    return task;
  }

  return {
    load,
    save,
    async getDraft(id) {
      return (await load()).drafts[String(id || "")] || null;
    },
    async getActiveDraft() {
      const state = await load();
      return state.drafts[state.activeDraftId] || null;
    },
    async getCapture(id) {
      return (await load()).captures[String(id || "")] || null;
    },
    async findCaptureByDraftId(draftId) {
      return Object.values((await load()).captures).find((record) => record.draftId === draftId) || null;
    },
    async listDrafts() {
      return Object.values((await load()).drafts);
    },
    async listCaptures({ statuses } = {}) {
      const records = Object.values((await load()).captures);
      return statuses?.length ? records.filter((record) => statuses.includes(record.status)) : records;
    },
    async listDueCaptures(timestamp = now()) {
      return Object.values((await load()).captures)
        .filter((record) => record.status === DELIVERY_STATES.pending && record.nextAttemptAt <= timestamp)
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    updateState(callback) {
      return mutate(async (state) => {
        await callback(state);
        return state;
      });
    },
    async getOrCreateDraft({ tabId, context, includeSource = true, sessionId = "", draftId = "" }) {
      return mutate((state) => {
        const requestedId = String(draftId || "");
        const activeId = state.drafts[requestedId] ? requestedId : state.activeDraftId;
        if (activeId && state.drafts[activeId]) {
          const existing = state.drafts[activeId];
          const next = addContextToDraft(existing, context, now());
          const sessionChanged = Boolean(sessionId && sessionId !== next.sessionId);
          next.tabId = tabId ?? next.tabId ?? null;
          next.sessionId = sessionId || next.sessionId || "";
          if (sessionChanged) {
            next.revision = Number(next.revision || 0) + 1;
            next.updatedAt = now();
          }
          state.drafts[activeId] = next;
          state.activeDraftId = activeId;
          return next;
        }
        const id = requestedId || uuid();
        const timestamp = now();
        const sources = sourceFromContext(context) ? [sourceFromContext(context)] : [];
        const draft = {
          version: CAPTURE_DRAFT_VERSION,
          id,
          tabId: tabId ?? null,
          context,
          mode: "new",
          targetRecordId: "",
          sources,
          revision: 1,
          sessionId: sessionId || "",
          returnDraftId: "",
          title: "",
          includeSource,
          doc: selectionDocument(context?.selection || ""),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        if (hasDraftBody(draft)) {
          state.drafts[id] = draft;
          state.activeDraftId = id;
        }
        return draft;
      });
    },
    async upsertDraft(draft, expectedRevision) {
      return mutate((state) => {
        if (!draft?.id) throw new CaptureStorageError("Draft ID is required.", "invalid_draft");
        const existing = state.drafts[draft.id] || {};
        const staleRevision = expectedRevision !== undefined && Number(expectedRevision) !== Number(existing.revision || 0);
        const staleSession = Boolean(draft.sessionId && existing.sessionId && draft.sessionId !== existing.sessionId);
        if (existing.id && (staleRevision || staleSession)) {
          throw new CaptureStorageError("This note was updated in another tab. Reload the latest copy to continue.", "stale_draft");
        }
        const next = {
          ...existing,
          ...draft,
          version: CAPTURE_DRAFT_VERSION,
          mode: draft.mode === "edit" ? "edit" : existing.mode || "new",
          targetRecordId: String(draft.targetRecordId ?? existing.targetRecordId ?? ""),
          sources: normalizeSources(draft.sources ?? existing.sources ?? [sourceFromContext(draft.context || existing.context)].filter(Boolean)),
          revision: Number(existing.revision || 0) + 1,
          createdAt: existing.createdAt || now(),
          updatedAt: now()
        };
        if (!hasDraftBody(next)) {
          delete state.drafts[next.id];
          if (state.activeDraftId === next.id) {
            state.activeDraftId = state.drafts[next.returnDraftId] ? next.returnDraftId : "";
          }
          return null;
        }
        state.drafts[next.id] = next;
        if (!state.activeDraftId || state.activeDraftId === next.id) state.activeDraftId = next.id;
        return next;
      });
    },
    async activateDraft(id, { returnDraftId = "" } = {}) {
      return mutate((state) => {
        const draft = state.drafts[id];
        if (!draft) return null;
        if (returnDraftId && returnDraftId !== id) draft.returnDraftId = returnDraftId;
        draft.updatedAt = now();
        draft.revision = Number(draft.revision || 0) + 1;
        state.activeDraftId = id;
        return draft;
      });
    },
    async createEditDraft({ recordId, title, doc, sources, remote, baseFingerprint, returnDraftId = "", tabId = null, sessionId = "", replace = false }) {
      return mutate((state) => {
        const record = state.captures[recordId];
        if (!record) return null;
        const existing = Object.values(state.drafts).find((draft) => draft.mode === "edit" && draft.targetRecordId === recordId);
        if (existing) {
          if (replace) {
            existing.title = title;
            existing.doc = doc;
            existing.sources = normalizeSources(sources);
            existing.remote = remote;
            existing.baseFingerprint = baseFingerprint;
          }
          existing.returnDraftId = returnDraftId || existing.returnDraftId || "";
          existing.tabId = tabId;
          existing.sessionId = sessionId || existing.sessionId || "";
          existing.updatedAt = now();
          existing.revision = Number(existing.revision || 0) + 1;
          state.activeDraftId = existing.id;
          return existing;
        }
        const timestamp = now();
        const id = uuid();
        const draft = normalizeDraft({
          id,
          tabId,
          mode: "edit",
          targetRecordId: recordId,
          returnDraftId,
          sessionId,
          title,
          doc,
          sources,
          remote,
          baseFingerprint,
          includeSource: normalizeSources(sources).length > 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
          context: normalizeSources(sources)[0] || record.context || {}
        });
        state.drafts[id] = draft;
        state.activeDraftId = id;
        return draft;
      });
    },
    async convertEditDraftToNew(id) {
      return mutate((state) => {
        const draft = state.drafts[id];
        if (!draft) return null;
        draft.mode = "new";
        draft.targetRecordId = "";
        draft.remote = null;
        draft.baseFingerprint = "";
        draft.revision = Number(draft.revision || 0) + 1;
        draft.updatedAt = now();
        state.activeDraftId = id;
        return draft;
      });
    },
    async discardDraft(id) {
      return mutate((state) => {
        const draft = state.drafts[id];
        if (!draft) return false;
        delete state.drafts[id];
        if (state.activeDraftId === id) state.activeDraftId = state.drafts[draft.returnDraftId] ? draft.returnDraftId : "";
        return true;
      });
    },
    async enqueue({ draftId, capture, context, destination, connectionId, status, incognito = false }) {
      return mutate((state) => {
        const existing = draftId
          ? Object.values(state.captures).find((record) => record.draftId === draftId)
          : null;
        if (existing) return existing;
        const id = uuid();
        const timestamp = now();
        const record = {
          version: CAPTURE_RECORD_VERSION,
          id,
          draftId: draftId || "",
          scope: incognito ? "incognito" : "regular",
          status,
          capture: { ...capture, captureId: id },
          syncedCapture: null,
          pendingCapture: { ...capture, captureId: id },
          operation: "create",
          syncJournal: null,
          context,
          destination,
          connectionId: connectionId || "",
          createdAt: timestamp,
          updatedAt: timestamp,
          attemptCount: 0,
          firstAttemptAt: 0,
          lastAttemptAt: 0,
          nextAttemptAt: status === DELIVERY_STATES.pending ? timestamp : 0,
          lastError: null,
          remote: null,
          forceRetry: false
        };
        state.captures[id] = record;
        if (draftId && state.drafts[draftId]) {
          const returnDraftId = state.drafts[draftId].returnDraftId;
          delete state.drafts[draftId];
          if (state.activeDraftId === draftId) state.activeDraftId = state.drafts[returnDraftId] ? returnDraftId : "";
        }
        return record;
      });
    },
    async enqueueUpdate({ draftId, recordId, capture, baseFingerprint, status }) {
      return mutate((state) => {
        const record = state.captures[recordId];
        if (!record) throw new CaptureStorageError("The recent note is no longer available locally.", "missing_capture");
        const draft = state.drafts[draftId];
        record.pendingCapture = { ...capture, captureId: record.capture?.captureId || record.id };
        record.operation = "update";
        record.baseFingerprint = baseFingerprint || draft?.baseFingerprint || "";
        record.syncJournal = null;
        record.status = status;
        record.nextAttemptAt = status === DELIVERY_STATES.pending ? now() : 0;
        record.lastError = null;
        record.updatedAt = now();
        if (draft) {
          const returnDraftId = draft.returnDraftId;
          delete state.drafts[draftId];
          if (state.activeDraftId === draftId) state.activeDraftId = state.drafts[returnDraftId] ? returnDraftId : "";
        }
        return record;
      });
    },
    async updateCapture(id, updates) {
      return mutate((state) => {
        const existing = state.captures[id];
        if (!existing) return null;
        state.captures[id] = { ...existing, ...updates, updatedAt: now() };
        return state.captures[id];
      });
    },
    async claimCapture(id, timestamp = now()) {
      return mutate((state) => {
        const existing = state.captures[id];
        if (!existing || existing.status !== DELIVERY_STATES.pending || existing.nextAttemptAt > timestamp) return null;
        state.captures[id] = {
          ...existing,
          status: DELIVERY_STATES.sending,
          firstAttemptAt: existing.firstAttemptAt || timestamp,
          lastAttemptAt: timestamp,
          attemptCount: Number(existing.attemptCount || 0) + 1,
          nextAttemptAt: 0,
          lastError: null,
          forceRetry: false,
          updatedAt: timestamp
        };
        return state.captures[id];
      });
    },
    async removeCapture(id) {
      return mutate((state) => Boolean(state.captures[id] && delete state.captures[id]));
    }
  };
}

export function pruneCaptureState(state, timestamp = Date.now()) {
  const delivered = Object.values(state.captures)
    .filter((record) => record.status === DELIVERY_STATES.delivered)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const retainedDelivered = new Set(delivered
    .filter((record, index) => index < 100 && timestamp - record.updatedAt <= 30 * DAY)
    .map((record) => record.id));
  for (const record of delivered) {
    if (!retainedDelivered.has(record.id)) delete state.captures[record.id];
  }

  for (const [id, draft] of Object.entries(state.drafts)) {
    if (!hasDraftBody(draft)) delete state.drafts[id];
  }
  const drafts = Object.values(state.drafts).sort((left, right) => right.updatedAt - left.updatedAt);
  const retainedDrafts = new Set(drafts
    .filter((draft, index) => index < 50 && timestamp - draft.updatedAt <= 30 * DAY)
    .map((draft) => draft.id));
  for (const draft of drafts) {
    if (!retainedDrafts.has(draft.id)) delete state.drafts[draft.id];
  }
  if (!state.drafts[state.activeDraftId]) state.activeDraftId = "";
  return state;
}

export function selectionDocument(selection = "") {
  if (!selection.trim()) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: selection.trim() }] }] },
      { type: "paragraph" }
    ]
  };
}

export function retryDelayMs(attemptCount, retryAfterSeconds = 0) {
  if (retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const minutes = [1, 5, 15, 60][Math.max(0, attemptCount - 1)] || 360;
  return minutes * 60 * 1000;
}

export function recoverInterruptedRecords(state, canVerifyManaged = true, timestamp = Date.now()) {
  for (const record of Object.values(state.captures)) {
    if (record.status !== DELIVERY_STATES.sending) continue;
    record.status = record.destination?.managedDestination && canVerifyManaged
      ? DELIVERY_STATES.pending
      : DELIVERY_STATES.uncertain;
    record.nextAttemptAt = record.status === DELIVERY_STATES.pending ? timestamp : 0;
    record.lastError = { kind: "interrupted", message: "Delivery was interrupted before Notion confirmed the result." };
    record.updatedAt = timestamp;
  }
  return state;
}

export function detachActiveDrafts(state) {
  // Global drafts deliberately survive browser sessions. This function remains
  // as a compatibility no-op for callers created before state v2.
  return state;
}

export function badgeForState(state) {
  const records = Object.values(state.captures);
  const needsAttention = records.some((record) => [
    DELIVERY_STATES.blockedSetup,
    DELIVERY_STATES.blockedAuth,
    DELIVERY_STATES.blockedDestination,
    DELIVERY_STATES.blockedConflict,
    DELIVERY_STATES.uncertain
  ].includes(record.status));
  if (needsAttention) return { text: "!", color: "#d70015" };
  const queued = records.filter((record) => [DELIVERY_STATES.pending, DELIVERY_STATES.sending].includes(record.status)).length;
  return queued ? { text: String(Math.min(queued, 99)), color: "#b26a00" } : { text: "", color: "#00000000" };
}

export function normalizeSources(sources = []) {
  const unique = new Map();
  for (const value of Array.isArray(sources) ? sources : []) {
    if (!value || typeof value !== "object") continue;
    const url = normalizeSourceUrl(value.url);
    const key = url || `selection:${String(value.selection || "").trim()}`;
    if (!key || unique.has(key)) continue;
    unique.set(key, {
      title: String(value.title || "").slice(0, 1000),
      url,
      selection: String(value.selection || "").slice(0, 8000),
      capturedAt: Number(value.capturedAt || Date.now())
    });
    if (unique.size >= 20) break;
  }
  return [...unique.values()];
}

export function sourceFromContext(context = {}) {
  const url = normalizeSourceUrl(context.url);
  const selection = String(context.selection || "").trim();
  if (!url && !selection) return null;
  return {
    title: String(context.title || "").slice(0, 1000),
    url,
    selection: selection.slice(0, 8000),
    capturedAt: Number(context.capturedAt || Date.now())
  };
}

export function addContextToDraft(draft, context, timestamp) {
  const next = normalizeDraft(draft);
  const source = sourceFromContext(context);
  if (!source) return next;
  const before = next.sources.length;
  const shouldAppendSelection = Boolean(source.selection && !documentContainsText(next.doc, source.selection));
  next.sources = normalizeSources([...next.sources, source]);
  if (shouldAppendSelection) {
    next.doc = appendSelection(next.doc, source.selection);
  }
  if (next.sources.length !== before || shouldAppendSelection) {
    next.revision += 1;
    next.updatedAt = timestamp;
  }
  return next;
}

function appendSelection(doc, selection) {
  const content = [...(doc?.content || [])];
  if (content.length === 1 && content[0]?.type === "paragraph" && !(content[0].content || []).length) content.length = 0;
  content.push(
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: selection.trim() }] }] },
    { type: "paragraph" }
  );
  return { type: "doc", content };
}

export function normalizeDraft(draft = {}) {
  const sources = normalizeSources(draft.sources || [sourceFromContext(draft.context)].filter(Boolean));
  return {
    ...draft,
    version: CAPTURE_DRAFT_VERSION,
    id: String(draft.id || ""),
    tabId: draft.tabId ?? null,
    mode: draft.mode === "edit" ? "edit" : "new",
    targetRecordId: String(draft.targetRecordId || ""),
    sources,
    revision: Math.max(1, Number(draft.revision || 1)),
    sessionId: String(draft.sessionId || ""),
    returnDraftId: String(draft.returnDraftId || ""),
    title: String(draft.title || ""),
    includeSource: draft.includeSource !== false && sources.length > 0,
    doc: draft.doc?.type === "doc" ? draft.doc : selectionDocument(draft.context?.selection || "")
  };
}

export function normalizeRecord(record = {}) {
  const capture = record.capture || record.syncedCapture || record.pendingCapture || {};
  return {
    ...record,
    version: CAPTURE_RECORD_VERSION,
    operation: record.operation || (record.status === DELIVERY_STATES.delivered ? "" : "create"),
    syncedCapture: record.syncedCapture || (record.status === DELIVERY_STATES.delivered ? capture : null),
    pendingCapture: record.pendingCapture || (record.status === DELIVERY_STATES.delivered ? null : capture),
    remote: record.remote ? {
      kind: record.remote.kind || (record.destination?.destinationType === "database" && record.remote.id ? "page" : "legacy_section"),
      id: String(record.remote.id || ""),
      url: String(record.remote.url || ""),
      pageId: String(record.remote.pageId || record.remote.id || record.destination?.destinationId || ""),
      blockIds: Array.isArray(record.remote.blockIds) ? record.remote.blockIds.map(String) : [],
      fingerprint: String(record.remote.fingerprint || "")
    } : null
  };
}

function normalizeSourceUrl(value = "") {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function hasDraftBody(draft) {
  return Boolean(documentText(draft.doc).trim());
}

function documentContainsText(doc, text) {
  return documentText(doc).includes(String(text || "").trim());
}

export function captureDocumentText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  return (node.content || []).map(captureDocumentText).join("\n");
}

function documentText(node) {
  return captureDocumentText(node);
}

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

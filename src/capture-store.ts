import type {
  CaptureContext,
  CaptureDestination,
  CaptureDocument,
  CaptureDraft,
  CapturePayload,
  CaptureRecord,
  CaptureRecordBase,
  CaptureRecordUpdate,
  CaptureSource,
  CaptureState,
  Clock,
  DeliveryErrorKind,
  DeliveryErrorMetadata,
  DeliveryState,
  DestinationProperty,
  EditorMark,
  EditorNode,
  JsonValue,
  KeyValueStoragePort,
  RemoteTarget,
  SyncJournal,
  UUIDFactory
} from "./contracts.js";
import { isRecord } from "./contracts.js";

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

interface CaptureRepositoryOptions {
  storage: KeyValueStoragePort;
  key?: string;
  now?: Clock;
  uuid?: UUIDFactory;
  softLimitBytes?: number;
}

export interface DraftRequest {
  tabId?: number | null;
  context?: unknown;
  includeSource?: boolean;
  sessionId?: string;
  draftId?: string;
}

export interface EditDraftRequest {
  recordId: string;
  title: string;
  doc: unknown;
  sources?: unknown;
  remote?: unknown;
  baseFingerprint?: string;
  returnDraftId?: string;
  tabId?: number | null;
  sessionId?: string;
  replace?: boolean;
}

export interface EnqueueRequest {
  draftId?: string;
  capture: unknown;
  context?: unknown;
  destination: CaptureDestination | null;
  connectionId?: string;
  status: DeliveryState;
  incognito?: boolean;
}

export interface EnqueueUpdateRequest {
  draftId: string;
  recordId: string;
  capture: unknown;
  baseFingerprint?: string;
  status: DeliveryState;
}

export interface ImportRemoteCaptureRequest {
  pageId: string;
  title?: string;
  url?: string;
  connectionId?: string;
  destination?: CaptureDestination | null;
  remote?: unknown;
  document?: unknown;
}

export class CaptureStorageError extends Error {
  readonly code: string;

  constructor(message: string, code = "capture_storage_error") {
    super(message);
    this.name = "CaptureStorageError";
    this.code = code;
  }
}

export function emptyCaptureState(): CaptureState {
  return { version: CAPTURE_STATE_VERSION, drafts: {}, activeDraftId: "", captures: {} };
}

export function normalizeCaptureState(value: unknown): CaptureState {
  if (!isRecord(value)) return emptyCaptureState();
  if (value.version === 1) return migrateCaptureStateV1(value);
  if (value.version !== CAPTURE_STATE_VERSION) return emptyCaptureState();
  const drafts = normalizeDraftEntries(value.drafts);
  return {
    version: CAPTURE_STATE_VERSION,
    drafts,
    activeDraftId: typeof value.activeDraftId === "string" && drafts[value.activeDraftId] ? value.activeDraftId : "",
    captures: normalizeRecordEntries(value.captures)
  };
}

export function migrateCaptureStateV1(value: Record<string, unknown>): CaptureState {
  const drafts = normalizeDraftEntries(value.drafts);
  const referenced = new Set(Object.values(objectValue(value.activeDraftByTab)).map(String));
  const referencedDrafts = Object.values(drafts).filter((draft) => referenced.has(draft.id));
  const candidates = (referencedDrafts.length ? referencedDrafts : Object.values(drafts))
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  const active = candidates[0] || null;
  return {
    version: CAPTURE_STATE_VERSION,
    drafts,
    activeDraftId: active?.id || "",
    captures: normalizeRecordEntries(value.captures)
  };
}

export function createCaptureRepository({
  storage,
  key = REGULAR_CAPTURE_STATE_KEY,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  softLimitBytes = SOFT_LIMIT_BYTES
}: CaptureRepositoryOptions) {
  let mutation: Promise<unknown> = Promise.resolve();

  async function load() {
    const value = await storage.get(key);
    return normalizeCaptureState(value[key]);
  }

  async function save(state: CaptureState): Promise<CaptureState> {
    const next = pruneCaptureState(state, now());
    const bytes = new TextEncoder().encode(JSON.stringify({ [key]: next })).length;
    if (bytes > softLimitBytes) {
      throw new CaptureStorageError("Quick Note local storage is full. Remove old drafts or delivered history before saving.", "capture_storage_full");
    }
    try {
      await storage.set({ [key]: next });
    } catch (error: unknown) {
      throw new CaptureStorageError(errorMessage(error, "Quick Note could not store this capture locally."));
    }
    return next;
  }

  function mutate<T>(callback: (state: CaptureState) => T | Promise<T>): Promise<T> {
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
    async getDraft(id: string) {
      return (await load()).drafts[String(id || "")] || null;
    },
    async getActiveDraft() {
      const state = await load();
      return state.drafts[state.activeDraftId] || null;
    },
    async getCapture(id: string) {
      return (await load()).captures[String(id || "")] || null;
    },
    async findCaptureByDraftId(draftId: string) {
      return Object.values((await load()).captures).find((record) => record.draftId === draftId) || null;
    },
    async listDrafts() {
      return Object.values((await load()).drafts);
    },
    async listCaptures({ statuses }: { statuses?: DeliveryState[] } = {}) {
      const records = Object.values((await load()).captures);
      return statuses?.length ? records.filter((record) => statuses.includes(record.status)) : records;
    },
    async listDueCaptures(timestamp = now()) {
      return Object.values((await load()).captures)
        .filter((record) => record.status === DELIVERY_STATES.pending && record.nextAttemptAt <= timestamp)
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    updateState(callback: (state: CaptureState) => void | Promise<void>) {
      return mutate(async (state) => {
        await callback(state);
        return state;
      });
    },
    async getOrCreateDraft({ tabId, context, includeSource = true, sessionId = "", draftId = "" }: DraftRequest) {
      return mutate((state) => {
        const requestedId = String(draftId || "");
        const active = state.drafts[state.activeDraftId];
        const activeId = state.drafts[requestedId]
          ? requestedId
          : requestedId
            ? ""
            : (tabId !== undefined && tabId !== null && active?.tabId !== tabId ? "" : state.activeDraftId);
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
        const source = sourceFromContext(context);
        const sources = source ? [source] : [];
        const normalizedContext = normalizeContext(context);
        const draft: CaptureDraft = {
          version: CAPTURE_DRAFT_VERSION,
          id,
          tabId: tabId ?? null,
          context: normalizedContext,
          mode: "new",
          targetRecordId: "",
          sources,
          dismissedSourceUrls: [],
          revision: 1,
          sessionId: sessionId || "",
          returnDraftId: "",
          title: "",
          includeSource,
          doc: selectionDocument(normalizedContext.selection),
          remote: null,
          baseFingerprint: "",
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
    async upsertDraft(draft: CaptureDraft, expectedRevision?: number) {
      return mutate((state) => {
        if (!draft?.id) throw new CaptureStorageError("Draft ID is required.", "invalid_draft");
        const existing = state.drafts[draft.id];
        const staleRevision = expectedRevision !== undefined && Number(expectedRevision) !== Number(existing?.revision || 0);
        const staleSession = Boolean(draft.sessionId && existing?.sessionId && draft.sessionId !== existing.sessionId);
        if (existing && (staleRevision || staleSession)) {
          throw new CaptureStorageError("This note was updated in another tab. Reload the latest copy to continue.", "stale_draft");
        }
        const next = requireDraft({
          ...(existing || {}),
          ...draft,
          version: CAPTURE_DRAFT_VERSION,
          mode: draft.mode === "edit" ? "edit" : existing?.mode || "new",
          targetRecordId: String(draft.targetRecordId ?? existing?.targetRecordId ?? ""),
          sources: normalizeSources(draft.sources ?? existing?.sources ?? [sourceFromContext(draft.context || existing?.context)].filter(Boolean)),
          revision: Number(existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || now(),
          updatedAt: now()
        });
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
    async activateDraft(id: string, { returnDraftId = "" }: { returnDraftId?: string } = {}) {
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
    async createEditDraft({ recordId, title, doc, sources, remote, baseFingerprint, returnDraftId = "", tabId = null, sessionId = "", replace = false }: EditDraftRequest) {
      return mutate((state) => {
        const record = state.captures[recordId];
        if (!record) return null;
        const existing = Object.values(state.drafts).find((draft) => draft.mode === "edit" && draft.targetRecordId === recordId);
        if (existing) {
          if (replace) {
            existing.title = title;
            existing.doc = normalizeEditorNode(doc);
            existing.sources = normalizeSources(sources);
            existing.remote = normalizeRemoteTarget(remote, record.destination);
            existing.baseFingerprint = baseFingerprint || "";
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
        const draft = requireDraft({
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
    async convertEditDraftToNew(id: string) {
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
    async discardDraft(id: string) {
      return mutate((state) => {
        const draft = state.drafts[id];
        if (!draft) return false;
        delete state.drafts[id];
        if (state.activeDraftId === id) state.activeDraftId = state.drafts[draft.returnDraftId] ? draft.returnDraftId : "";
        return true;
      });
    },
    async enqueue({ draftId, capture, context, destination, connectionId, status, incognito = false }: EnqueueRequest) {
      return mutate((state) => {
        const existing = draftId
          ? Object.values(state.captures).find((record) => record.draftId === draftId)
          : null;
        if (existing) return existing;
        const id = uuid();
        const timestamp = now();
        const record = requireRecord({
          version: CAPTURE_RECORD_VERSION,
          id,
          draftId: draftId || "",
          scope: incognito ? "incognito" : "regular",
          status,
          capture: withCaptureId(capture, id),
          syncedCapture: null,
          pendingCapture: withCaptureId(capture, id),
          operation: "create",
          syncJournal: null,
          context: normalizeContext(context),
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
        });
        state.captures[id] = record;
        if (draftId && state.drafts[draftId]) {
          const returnDraftId = state.drafts[draftId].returnDraftId;
          delete state.drafts[draftId];
          if (state.activeDraftId === draftId) state.activeDraftId = state.drafts[returnDraftId] ? returnDraftId : "";
        }
        return record;
      });
    },
    async enqueueUpdate({ draftId, recordId, capture, baseFingerprint, status }: EnqueueUpdateRequest) {
      return mutate((state) => {
        const record = state.captures[recordId];
        if (!record) throw new CaptureStorageError("The recent note is no longer available locally.", "missing_capture");
        const draft = state.drafts[draftId];
        const next = requireRecord({
          ...record,
          pendingCapture: withCaptureId(capture, record.capture.captureId || record.id),
          operation: "update",
          baseFingerprint: baseFingerprint || draft?.baseFingerprint || "",
          syncJournal: null,
          status,
          nextAttemptAt: status === DELIVERY_STATES.pending ? now() : 0,
          lastError: null,
          updatedAt: now()
        });
        state.captures[recordId] = next;
        if (draft) {
          const returnDraftId = draft.returnDraftId;
          delete state.drafts[draftId];
          if (state.activeDraftId === draftId) state.activeDraftId = state.drafts[returnDraftId] ? returnDraftId : "";
        }
        return next;
      });
    },
    async updateCapture(id: string, updates: CaptureRecordUpdate) {
      return mutate((state) => {
        const existing = state.captures[id];
        if (!existing) return null;
        state.captures[id] = requireRecord({ ...existing, ...updates, updatedAt: now() });
        return state.captures[id];
      });
    },
    async claimCapture(id: string, timestamp = now()) {
      return mutate((state) => {
        const existing = state.captures[id];
        if (!existing || existing.status !== DELIVERY_STATES.pending || existing.nextAttemptAt > timestamp) return null;
        state.captures[id] = requireRecord({
          ...existing,
          status: DELIVERY_STATES.sending,
          firstAttemptAt: existing.firstAttemptAt || timestamp,
          lastAttemptAt: timestamp,
          attemptCount: Number(existing.attemptCount || 0) + 1,
          nextAttemptAt: 0,
          lastError: null,
          forceRetry: false,
          updatedAt: timestamp
        });
        return state.captures[id];
      });
    },
    async removeCapture(id: string) {
      return mutate((state) => Boolean(state.captures[id] && delete state.captures[id]));
    },
    async findCaptureByRemotePageId(pageId: string) {
      const needle = compactRemoteId(pageId);
      if (!needle) return null;
      return Object.values((await load()).captures).find((record) => {
        return compactRemoteId(record.remote?.pageId) === needle || compactRemoteId(record.remote?.id) === needle;
      }) || null;
    },
    async ensureImportedRemoteCapture({ pageId, title = "", url = "", connectionId = "", destination = null, remote = null, document = null }: ImportRemoteCaptureRequest) {
      const needle = compactRemoteId(pageId);
      if (!needle) throw new CaptureStorageError("A Notion page ID is required.", "invalid_remote_page");
      return mutate((state) => {
        const existing = Object.values(state.captures).find((record) => {
          return compactRemoteId(record.remote?.pageId) === needle || compactRemoteId(record.remote?.id) === needle;
        });
        const timestamp = now();
        const captureDocument: CaptureDocument = {
          version: 1,
          title: String(title || "").trim(),
          doc: isRecord(document) && document.type === "doc" ? normalizeEditorNode(document) : selectionDocument()
        };
        const remoteValue = isRecord(remote) ? remote : {};
        const nextRemote = normalizeRemoteTarget({
          kind: "page",
          id: compactRemoteId(remoteValue.id) || needle,
          pageId: compactRemoteId(remoteValue.pageId) || needle,
          url: stringValue(remoteValue.url) || url,
          blockIds: remoteValue.blockIds,
          fingerprint: remoteValue.fingerprint
        }, destination) || emptyRemoteTarget(destination);
        if (existing) {
          if (existing.status === DELIVERY_STATES.delivered || existing.status === DELIVERY_STATES.blockedConflict) {
            existing.remote = { ...existing.remote, ...nextRemote };
            if (url) existing.remote.url = url || existing.remote.url;
            if (title && !existing.syncedCapture?.document?.title) {
              existing.syncedCapture = {
                ...(existing.syncedCapture || existing.capture || {}),
                document: {
                  ...(existing.syncedCapture?.document || existing.capture?.document || {}),
                  title: String(title || "").trim()
                }
              };
            }
            if (destination && !existing.destination) existing.destination = destination;
            if (connectionId && !existing.connectionId) existing.connectionId = connectionId;
            existing.updatedAt = timestamp;
            state.captures[existing.id] = normalizeRecord(existing);
            return state.captures[existing.id];
          }
          return normalizeRecord(existing);
        }
        const id = uuid();
        const capture = { document: captureDocument, captureId: id, sources: [], includeSource: false };
        const record = requireRecord({
          version: CAPTURE_RECORD_VERSION,
          id,
          draftId: "",
          scope: "regular",
          status: DELIVERY_STATES.delivered,
          capture,
          syncedCapture: capture,
          pendingCapture: null,
          operation: "",
          syncJournal: null,
          context: {},
          destination,
          connectionId: connectionId || "",
          createdAt: timestamp,
          updatedAt: timestamp,
          attemptCount: 0,
          firstAttemptAt: 0,
          lastAttemptAt: 0,
          nextAttemptAt: 0,
          lastError: null,
          remote: nextRemote,
          forceRetry: false,
          importedFromNotion: true
        });
        state.captures[id] = record;
        return record;
      });
    }
  };
}

function compactRemoteId(value: unknown = ""): string {
  return String(value || "").replaceAll("-", "").toLowerCase();
}

export function pruneCaptureState(state: CaptureState, timestamp = Date.now()): CaptureState {
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

export function selectionDocument(selection = ""): EditorNode {
  if (!selection.trim()) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: selection.trim() }] }] },
      { type: "paragraph" }
    ]
  };
}

export function retryDelayMs(attemptCount: number, retryAfterSeconds = 0): number {
  if (retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const minutes = [1, 5, 15, 60][Math.max(0, attemptCount - 1)] || 360;
  return minutes * 60 * 1000;
}

export function recoverInterruptedRecords(state: CaptureState, canVerifyManaged = true, timestamp = Date.now()): CaptureState {
  for (const record of Object.values(state.captures)) {
    if (record.status !== DELIVERY_STATES.sending) continue;
    const status = (record.destination?.managedDestination && canVerifyManaged) || Boolean(record.syncJournal?.treeWrite)
      ? DELIVERY_STATES.pending
      : DELIVERY_STATES.uncertain;
    state.captures[record.id] = requireRecord({
      ...record,
      status,
      nextAttemptAt: status === DELIVERY_STATES.pending ? timestamp : 0,
      lastError: { kind: "interrupted", message: "Delivery was interrupted before Notion confirmed the result." },
      updatedAt: timestamp
    });
  }
  return state;
}

export function detachActiveDrafts(state: CaptureState): CaptureState {
  // Global drafts deliberately survive browser sessions. This function remains
  // as a compatibility no-op for callers created before state v2.
  return state;
}

export function badgeForState(state: CaptureState): { text: string; color: string } {
  const records = Object.values(state.captures);
  const attentionStates: ReadonlySet<DeliveryState> = new Set([
    DELIVERY_STATES.blockedSetup,
    DELIVERY_STATES.blockedAuth,
    DELIVERY_STATES.blockedDestination,
    DELIVERY_STATES.blockedConflict,
    DELIVERY_STATES.uncertain
  ]);
  const queuedStates: ReadonlySet<DeliveryState> = new Set([DELIVERY_STATES.pending, DELIVERY_STATES.sending]);
  const needsAttention = records.some((record) => attentionStates.has(record.status));
  if (needsAttention) return { text: "!", color: "#d70015" };
  const queued = records.filter((record) => queuedStates.has(record.status)).length;
  return queued ? { text: String(Math.min(queued, 99)), color: "#b26a00" } : { text: "", color: "#00000000" };
}

export function normalizeSources(sources: unknown = []): CaptureSource[] {
  const unique = new Map<string, CaptureSource>();
  for (const value of Array.isArray(sources) ? sources : []) {
    if (!isRecord(value)) continue;
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

export function normalizeDismissedSourceUrls(value: unknown = []): string[] {
  const unique = new Set<string>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const url = normalizeSourceUrl(candidate);
    if (!url) continue;
    unique.add(url);
    if (unique.size >= 100) break;
  }
  return [...unique];
}

export function sourceFromContext(context: unknown = {}): CaptureSource | null {
  if (!isRecord(context)) return null;
  const url = normalizeSourceUrl(context.url);
  const selection = stringValue(context.selection).trim();
  if (!url && !selection) return null;
  return {
    title: stringValue(context.title).slice(0, 1000),
    url,
    selection: selection.slice(0, 8000),
    capturedAt: Number(context.capturedAt || Date.now())
  };
}

export function addContextToDraft(
  draft: unknown,
  context: unknown,
  timestamp: number,
  { explicit = true }: { explicit?: boolean } = {}
): CaptureDraft {
  const next = requireDraft(draft);
  const source = sourceFromContext(context);
  if (!source) return next;
  const dismissed = new Set(normalizeDismissedSourceUrls(next.dismissedSourceUrls));
  if (!explicit && source.url && dismissed.has(source.url)) return next;
  if (explicit && source.url) dismissed.delete(source.url);
  next.dismissedSourceUrls = [...dismissed];
  const previousSources = next.sources;
  const existingIndex = source.url ? previousSources.findIndex((candidate) => candidate.url === source.url) : -1;
  const mergedSources = existingIndex >= 0
    ? previousSources.map((candidate, index) => index === existingIndex ? {
        ...candidate,
        title: source.title || candidate.title,
        selection: source.selection || candidate.selection,
        capturedAt: source.capturedAt
      } : candidate)
    : [...previousSources, source];
  const shouldAppendSelection = Boolean(source.selection && !documentContainsText(next.doc, source.selection));
  next.sources = normalizeSources(mergedSources);
  if (shouldAppendSelection) {
    next.doc = appendSelection(next.doc, source.selection);
  }
  if (JSON.stringify(next.sources) !== JSON.stringify(previousSources) || shouldAppendSelection) {
    next.revision += 1;
    next.updatedAt = timestamp;
  }
  return next;
}

function appendSelection(doc: EditorNode, selection: string): EditorNode {
  const content = [...(doc?.content || [])];
  if (content.length === 1 && content[0]?.type === "paragraph" && !(content[0].content || []).length) content.length = 0;
  content.push(
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: selection.trim() }] }] },
    { type: "paragraph" }
  );
  return { type: "doc", content };
}

export function normalizeDraft(draft: CaptureDraft): CaptureDraft;
export function normalizeDraft(draft?: unknown): CaptureDraft | null;
export function normalizeDraft(draft: unknown = {}): CaptureDraft | null {
  if (!isRecord(draft)) return null;
  const value = draft;
  if (!isSupportedItemVersion(value.version)) return null;
  const context = normalizeContext(value.context);
  const sources = normalizeSources(value.sources || [sourceFromContext(context)].filter(Boolean));
  const remote = normalizeRemoteTarget(value.remote, null);
  return {
    version: CAPTURE_DRAFT_VERSION,
    id: stringValue(value.id),
    tabId: typeof value.tabId === "number" ? value.tabId : null,
    context,
    mode: value.mode === "edit" ? "edit" : "new",
    targetRecordId: stringValue(value.targetRecordId),
    sources,
    dismissedSourceUrls: normalizeDismissedSourceUrls(value.dismissedSourceUrls),
    revision: Math.max(1, numberValue(value.revision, 1)),
    sessionId: stringValue(value.sessionId),
    returnDraftId: stringValue(value.returnDraftId),
    title: stringValue(value.title),
    includeSource: value.includeSource !== false && sources.length > 0,
    doc: isRecord(value.doc) && value.doc.type === "doc" ? normalizeEditorNode(value.doc) : selectionDocument(context.selection),
    remote,
    baseFingerprint: stringValue(value.baseFingerprint),
    createdAt: numberValue(value.createdAt),
    updatedAt: numberValue(value.updatedAt)
  };
}

export function normalizeRecord(record: CaptureRecord): CaptureRecord;
export function normalizeRecord(record?: unknown): CaptureRecord | null;
export function normalizeRecord(record: unknown = {}): CaptureRecord | null {
  if (!isRecord(record)) return null;
  const value = record;
  if (!isSupportedItemVersion(value.version)) return null;
  const rawCapture = value.capture || value.syncedCapture || value.pendingCapture;
  const capture = normalizeCapturePayload(rawCapture, stringValue(value.id));
  const rawStatus = isDeliveryState(value.status) ? value.status : DELIVERY_STATES.pending;
  const destination = normalizeDestination(value.destination);
  const remote = normalizeRemoteTarget(value.remote, destination);
  const base: CaptureRecordBase = {
    version: CAPTURE_RECORD_VERSION,
    id: stringValue(value.id),
    draftId: stringValue(value.draftId),
    scope: value.scope === "incognito" ? "incognito" : "regular",
    capture,
    syncedCapture: value.syncedCapture ? normalizeCapturePayload(value.syncedCapture, capture.captureId) : rawStatus === DELIVERY_STATES.delivered ? capture : null,
    pendingCapture: value.pendingCapture ? normalizeCapturePayload(value.pendingCapture, capture.captureId) : rawStatus === DELIVERY_STATES.delivered ? null : capture,
    operation: value.operation === "update" ? "update" : value.operation === "" || rawStatus === DELIVERY_STATES.delivered ? "" : "create",
    context: normalizeContext(value.context),
    destination,
    connectionId: stringValue(value.connectionId),
    attemptCount: numberValue(value.attemptCount),
    firstAttemptAt: numberValue(value.firstAttemptAt),
    lastAttemptAt: numberValue(value.lastAttemptAt),
    nextAttemptAt: numberValue(value.nextAttemptAt),
    createdAt: numberValue(value.createdAt),
    updatedAt: numberValue(value.updatedAt),
    forceRetry: value.forceRetry === true,
    baseFingerprint: stringValue(value.baseFingerprint),
    syncJournal: normalizeSyncJournal(value.syncJournal),
    importedFromNotion: value.importedFromNotion === true
  };
  if (rawStatus === DELIVERY_STATES.delivered) {
    return { ...base, status: rawStatus, deliveredAt: numberValue(value.deliveredAt), lastError: null, remote: remote || emptyRemoteTarget(destination) };
  }
  if (isTerminalDeliveryState(rawStatus)) {
    return {
      ...base,
      status: rawStatus,
      deliveredAt: 0,
      lastError: normalizeDeliveryError(value.lastError, defaultErrorForStatus(rawStatus)),
      remote
    };
  }
  return {
    ...base,
    status: rawStatus,
    deliveredAt: 0,
    lastError: value.lastError == null ? null : normalizeDeliveryError(value.lastError),
    remote
  };
}

function normalizeSourceUrl(value: unknown = ""): string {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function hasDraftBody(draft: Pick<CaptureDraft, "doc">): boolean {
  return Boolean(documentText(draft.doc).trim());
}

function documentContainsText(doc: EditorNode, text: string): boolean {
  return documentText(doc).includes(String(text || "").trim());
}

export function captureDocumentText(node: EditorNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  return (node.content || []).map(captureDocumentText).join("\n");
}

function documentText(node: EditorNode | null | undefined): string {
  return captureDocumentText(node);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeDraftEntries(value: unknown): Record<string, CaptureDraft> {
  const entries: Array<[string, CaptureDraft]> = [];
  for (const [id, persisted] of Object.entries(objectValue(value))) {
    const draft = normalizeDraft(persisted);
    if (draft && hasDraftBody(draft)) entries.push([id, draft]);
  }
  return Object.fromEntries(entries);
}

function normalizeRecordEntries(value: unknown): Record<string, CaptureRecord> {
  const entries: Array<[string, CaptureRecord]> = [];
  for (const [id, persisted] of Object.entries(objectValue(value))) {
    const record = normalizeRecord(persisted);
    if (record) entries.push([id, record]);
  }
  return Object.fromEntries(entries);
}

function isSupportedItemVersion(version: unknown): boolean {
  return version === undefined || version === 1 || version === CAPTURE_DRAFT_VERSION;
}

function requireDraft(value: unknown): CaptureDraft {
  const draft = normalizeDraft(value);
  if (!draft) throw new CaptureStorageError("This draft uses an unsupported storage version.", "unsupported_draft_version");
  return draft;
}

function requireRecord(value: unknown): CaptureRecord {
  const record = normalizeRecord(value);
  if (!record) throw new CaptureStorageError("This capture uses an unsupported storage version.", "unsupported_capture_version");
  return record;
}

function normalizeContext(value: unknown): CaptureContext {
  const context = isRecord(value) ? value : {};
  return {
    version: 1,
    title: stringValue(context.title),
    url: stringValue(context.url),
    selection: stringValue(context.selection),
    capturedAt: numberValue(context.capturedAt)
  };
}

function normalizeCapturePayload(value: unknown, fallbackId = ""): CapturePayload {
  const capture = isRecord(value) ? value : {};
  return {
    document: normalizeCaptureDocument(capture.document),
    captureId: stringValue(capture.captureId) || fallbackId,
    sources: normalizeSources(capture.sources),
    includeSource: capture.includeSource !== false
  };
}

function withCaptureId(value: unknown, captureId: string): CapturePayload {
  const capture = normalizeCapturePayload(value, captureId);
  return { ...capture, captureId };
}

function normalizeCaptureDocument(value: unknown): CaptureDocument {
  const document = isRecord(value) ? value : {};
  return {
    version: 1,
    title: stringValue(document.title),
    doc: isRecord(document.doc) ? normalizeEditorNode(document.doc) : selectionDocument()
  };
}

export function normalizeEditorNode(value: unknown): EditorNode {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "paragraph" };
  const node: EditorNode = { type: value.type };
  if (typeof value.text === "string") node.text = value.text;
  const attrs = normalizeJsonObject(value.attrs);
  if (attrs) node.attrs = attrs;
  if (Array.isArray(value.marks)) {
    const marks = value.marks.map(normalizeEditorMark).filter((mark): mark is EditorMark => mark !== null);
    if (marks.length) node.marks = marks;
  }
  if (Array.isArray(value.content)) node.content = value.content.map(normalizeEditorNode);
  return node;
}

function normalizeEditorMark(value: unknown): EditorMark | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const attrs = normalizeJsonObject(value.attrs);
  return attrs ? { type: value.type, attrs } : { type: value.type };
}

function normalizeJsonObject(value: unknown): Record<string, JsonValue> | null {
  if (!isRecord(value)) return null;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (isJsonValue(child)) entries.push([key, child]);
  }
  return Object.fromEntries(entries);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function normalizeDestination(value: unknown): CaptureDestination | null {
  if (!isRecord(value)) return null;
  const destination: CaptureDestination = {};
  copyString(value, destination, "destinationId");
  copyString(value, destination, "destinationDatabaseId");
  copyString(value, destination, "destinationName");
  copyString(value, destination, "destinationUrl");
  if (value.destinationType === "page" || value.destinationType === "database") destination.destinationType = value.destinationType;
  copyString(value, destination, "titleProperty");
  if (typeof value.managedDestination === "boolean") destination.managedDestination = value.managedDestination;
  if (typeof value.destinationSchemaVersion === "number") destination.destinationSchemaVersion = value.destinationSchemaVersion;
  copyString(value, destination, "destinationMarker");
  copyString(value, destination, "destinationConnectionId");
  const properties = normalizeDestinationProperties(value.destinationProperties);
  if (properties) destination.destinationProperties = properties;
  return destination;
}

function normalizeDestinationProperties(value: unknown): Record<string, DestinationProperty> | null {
  if (!isRecord(value)) return null;
  const properties: Array<[string, DestinationProperty]> = [];
  for (const [key, property] of Object.entries(value)) {
    if (!isRecord(property) || typeof property.id !== "string" || typeof property.name !== "string") continue;
    properties.push([key, { id: property.id, name: property.name }]);
  }
  return Object.fromEntries(properties);
}

function copyString<K extends keyof CaptureDestination>(source: Record<string, unknown>, target: CaptureDestination, key: K): void {
  const value = source[key];
  if (typeof value === "string") Object.assign(target, { [key]: value });
}

function normalizeRemoteTarget(value: unknown, destination: CaptureDestination | null): RemoteTarget | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const kind = value.kind === "page" || value.kind === "section" || value.kind === "legacy_section"
    ? value.kind
    : destination?.destinationType === "database" && id ? "page" : "legacy_section";
  return {
    kind,
    id,
    url: stringValue(value.url),
    pageId: stringValue(value.pageId) || id || destination?.destinationId || "",
    blockIds: Array.isArray(value.blockIds) ? value.blockIds.map(String) : [],
    fingerprint: stringValue(value.fingerprint),
    ...(typeof value.lastEditedTime === "string" ? { lastEditedTime: value.lastEditedTime } : {})
  };
}

function emptyRemoteTarget(destination: CaptureDestination | null): RemoteTarget {
  return { kind: "page", id: "", url: "", pageId: destination?.destinationId || "", blockIds: [], fingerprint: "" };
}

function normalizeSyncJournal(value: unknown): SyncJournal | null {
  if (!isRecord(value)) return null;
  const journal: SyncJournal = {};
  if (isRecord(value.insertedSegments)) {
    journal.insertedSegments = Object.fromEntries(Object.entries(value.insertedSegments)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([key, ids]) => [key, ids.map(String)]));
  }
  if (Array.isArray(value.archivedIds)) journal.archivedIds = value.archivedIds.map(String);
  const treeWrite = normalizeTreeWriteJournal(value.treeWrite);
  if (treeWrite) journal.treeWrite = treeWrite;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "insertedSegments" && key !== "archivedIds" && key !== "treeWrite" && isJsonValue(child)) journal[key] = child;
  }
  return journal;
}

function normalizeTreeWriteJournal(value: unknown): SyncJournal["treeWrite"] | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!new Set(["initializing", "creating_page", "writing", "archiving", "complete"]).has(String(value.phase))) return null;
  if (value.destinationType !== "database" && value.destinationType !== "page") return null;
  if (typeof value.connectionId !== "string" || typeof value.destinationParentId !== "string"
    || typeof value.operationTimestamp !== "string") return null;
  if (value.pageId !== undefined && typeof value.pageId !== "string") return null;
  if (value.pageUrl !== undefined && typeof value.pageUrl !== "string") return null;
  if (!isRecord(value.groups) || !Object.values(value.groups).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))) return null;
  if (!Array.isArray(value.archivedBlockIds) || !value.archivedBlockIds.every((id) => typeof id === "string")) return null;
  return {
    version: 1,
    phase: value.phase as NonNullable<SyncJournal["treeWrite"]>["phase"],
    connectionId: value.connectionId,
    destinationType: value.destinationType,
    destinationParentId: value.destinationParentId,
    ...(value.pageId !== undefined ? { pageId: value.pageId } : {}),
    ...(value.pageUrl !== undefined ? { pageUrl: value.pageUrl } : {}),
    operationTimestamp: value.operationTimestamp,
    groups: Object.fromEntries(Object.entries(value.groups).map(([path, ids]) => [path, [...ids as string[]]])),
    archivedBlockIds: [...value.archivedBlockIds]
  };
}

function normalizeDeliveryError(value: unknown, fallback: DeliveryErrorMetadata = { kind: "unknown", message: "Delivery needs attention." }): DeliveryErrorMetadata {
  const error = isRecord(value) ? value : {};
  const kind = isDeliveryErrorKind(error.kind) ? error.kind : fallback.kind;
  return {
    kind,
    message: typeof error.message === "string" && error.message ? error.message : fallback.message,
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.retryAfter === "number" ? { retryAfter: error.retryAfter } : {})
  };
}

function isDeliveryErrorKind(value: unknown): value is DeliveryErrorKind {
  return typeof value === "string" && DELIVERY_ERROR_KINDS.has(value);
}

const DELIVERY_ERROR_KINDS: ReadonlySet<string> = new Set([
  "authentication", "auth", "setup", "destination", "conflict", "remote_conflict", "connection_changed",
  "rate_limited", "retryable", "ambiguous", "ambiguous_managed", "ambiguous_manual", "interrupted",
  "attention_required", "timeout", "timeout_manual", "offline", "delivery", "unknown"
]);

function isDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === "string" && Object.values(DELIVERY_STATES).some((state) => state === value);
}

function isTerminalDeliveryState(state: DeliveryState): state is Exclude<DeliveryState, "pending" | "sending" | "delivered"> {
  return state !== "pending" && state !== "sending" && state !== "delivered";
}

function defaultErrorForStatus(status: Exclude<DeliveryState, "pending" | "sending" | "delivered">): DeliveryErrorMetadata {
  switch (status) {
    case "blocked_setup": return { kind: "setup", message: "Connect Notion to deliver this capture." };
    case "blocked_auth": return { kind: "auth", message: "Reconnect Notion to deliver this capture." };
    case "blocked_destination": return { kind: "destination", message: "Choose a valid Notion destination." };
    case "blocked_conflict": return { kind: "conflict", message: "The remote note changed." };
    case "uncertain": return { kind: "ambiguous", message: "Delivery needs review." };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : fallback;
  return Number.isFinite(number) ? number : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : fallback;
}

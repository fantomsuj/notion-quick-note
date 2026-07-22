import type {
  CaptureContext,
  CaptureDestination,
  CaptureDocument,
  CaptureDraft,
  CapturePayload,
  CaptureRecord,
  CaptureRecordBase,
  CaptureSource,
  CaptureState,
  DeliveryErrorKind,
  DeliveryErrorMetadata,
  DeliveryState,
  DestinationProperty,
  EditorMark,
  EditorNode,
  JsonValue,
  RemoteTarget,
  SyncJournal
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

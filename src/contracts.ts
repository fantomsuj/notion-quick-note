export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EditorMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

export type NotionColorName = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export interface EditorNode {
  type: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: EditorMark[];
  content?: EditorNode[];
}

export interface CaptureDocument {
  version: 1;
  title: string;
  doc: EditorNode;
}

export interface CaptureContext {
  version: 1;
  title: string;
  url: string;
  selection: string;
  capturedAt: number;
  frameUrl?: string;
}

export type PanelRegistrationMessage = {
  type: "REGISTER_PANEL";
  windowId: number;
};

export type PanelNavigationMessage =
  | { type: "SHOW_COMPOSER"; draftId?: string; tabId?: number }
  | { type: "SHOW_ACTIVITY" };

export type PanelContextMessage = {
  type: "ACTIVE_PAGE_CONTEXT";
  tabId: number;
  page: CaptureContext;
};

export type PanelToWorkerMessage = PanelRegistrationMessage;
export type WorkerToPanelMessage = PanelNavigationMessage | PanelContextMessage;

export function isPanelRegistrationMessage(value: unknown): value is PanelRegistrationMessage {
  return isRecord(value)
    && value.type === "REGISTER_PANEL"
    && typeof value.windowId === "number"
    && Number.isInteger(value.windowId)
    && value.windowId >= 0;
}

export interface CaptureSource {
  title: string;
  url: string;
  selection: string;
  capturedAt: number;
}

export interface DestinationProperty {
  id: string;
  name: string;
}

export interface Destination {
  id: string;
  databaseId?: string;
  type: "page" | "database";
  name: string;
  url?: string;
  icon?: string;
  titleProperty?: string;
  managedDestination?: boolean;
  schemaVersion?: number;
  marker?: string;
  properties?: Record<string, DestinationProperty>;
}

export interface CaptureDestination {
  destinationId?: string;
  destinationDatabaseId?: string;
  destinationName?: string;
  destinationUrl?: string;
  destinationType?: "page" | "database";
  titleProperty?: string;
  managedDestination?: boolean;
  destinationSchemaVersion?: number;
  destinationMarker?: string;
  destinationProperties?: Record<string, DestinationProperty>;
  destinationConnectionId?: string;
}

export interface Connection {
  authType: "oauth" | "token";
  token: string;
  connectionHandle: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string;
  botId: string;
  connectionId: string;
}

export interface Settings extends Connection {
  legacyOAuthBotId: string;
  legacyOAuthConnectionId: string;
  destinationType: "page" | "database";
  destinationId: string;
  destinationDatabaseId: string;
  destinationName: string;
  destinationUrl: string;
  titleProperty: string;
  managedDestination: boolean;
  destinationSchemaVersion: number;
  destinationMarker: string;
  destinationProperties: Record<string, DestinationProperty>;
  destinationConnectionId: string;
  databaseProvisioning: DatabaseProvisioning | null;
  onboardingComplete: boolean;
  includeSource: boolean;
  aiEnabled: boolean;
  aiSuggestTitle: boolean;
  aiExtractTodos: boolean;
  oauthClientId: string;
  oauthBrokerUrl: string;
  oauthReconnectRequired?: boolean;
}

export interface DatabaseProvisioning {
  connectionId: string;
  marker: string;
  status: "recovering" | "creating" | "uncertain" | "failed";
  startedAt: number;
  lastAttemptAt: number;
  lastError?: {
    message: string;
    status: number;
    code: string;
  } | null;
}

export type DeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "blocked_setup"
  | "blocked_auth"
  | "blocked_destination"
  | "blocked_conflict"
  | "uncertain";

export type DeliveryErrorKind =
  | "authentication"
  | "auth"
  | "setup"
  | "destination"
  | "conflict"
  | "remote_conflict"
  | "connection_changed"
  | "rate_limited"
  | "retryable"
  | "ambiguous"
  | "ambiguous_managed"
  | "ambiguous_manual"
  | "interrupted"
  | "attention_required"
  | "timeout"
  | "timeout_manual"
  | "offline"
  | "delivery"
  | "unknown";

export interface DeliveryErrorMetadata {
  kind: DeliveryErrorKind;
  message: string;
  status?: number;
  code?: string;
  retryAfter?: number;
}

export interface RemoteTarget {
  kind: "page" | "section" | "legacy_section";
  id: string;
  url: string;
  pageId: string;
  lastEditedTime?: string;
  blockIds: string[];
  fingerprint: string;
}

export interface SyncJournal {
  insertedSegments?: Record<string, string[]>;
  [key: string]: JsonValue | undefined;
}

export interface CaptureDraft {
  version: 2;
  id: string;
  tabId: number | null;
  context: CaptureContext;
  mode: "new" | "edit";
  targetRecordId: string;
  sources: CaptureSource[];
  dismissedSourceUrls: string[];
  revision: number;
  sessionId: string;
  returnDraftId: string;
  title: string;
  includeSource: boolean;
  doc: EditorNode;
  remote: RemoteTarget | null;
  baseFingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface CapturePayload {
  document: CaptureDocument;
  captureId: string;
  sources: CaptureSource[];
  includeSource: boolean;
}

export interface CaptureRecordBase {
  version: 2;
  id: string;
  draftId: string;
  scope: "regular" | "incognito";
  capture: CapturePayload;
  syncedCapture: CapturePayload | null;
  pendingCapture: CapturePayload | null;
  operation: "" | "create" | "update";
  context: CaptureContext;
  destination: CaptureDestination | null;
  connectionId: string;
  attemptCount: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  forceRetry: boolean;
  baseFingerprint: string;
  syncJournal: SyncJournal | null;
  importedFromNotion: boolean;
}

export type CaptureRecord = CaptureRecordBase & (
  | { status: "pending" | "sending"; deliveredAt: 0; lastError: DeliveryErrorMetadata | null; remote: RemoteTarget | null }
  | { status: "delivered"; deliveredAt: number; lastError: null; remote: RemoteTarget }
  | { status: "blocked_setup" | "blocked_auth" | "blocked_destination" | "blocked_conflict" | "uncertain"; deliveredAt: 0; lastError: DeliveryErrorMetadata; remote: RemoteTarget | null }
);

export interface CaptureState {
  version: 2;
  drafts: Record<string, CaptureDraft>;
  activeDraftId: string;
  captures: Record<string, CaptureRecord>;
}

export interface StorageMetadata {
  key: "state";
  version: 3;
  activeDraftId: string;
  migrationStatus: "pending" | "complete" | "failed" | "imported" | "legacy";
  migrationError: string;
  lastMaintenanceAt: number;
  migratedAt?: number | undefined;
}

export interface RecoveryExport {
  version: 1;
  exportedAt: string;
  captures: CaptureRecord[];
  drafts: CaptureDraft[];
}

export interface RecoveryFile {
  filename: string;
  mimeType: "application/json" | "text/markdown";
  content: string;
}

export interface KeyValueStoragePort {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getKeys?(): Promise<string[]>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

export type Clock = () => number;
export type UUIDFactory = () => string;

export type CaptureStoreName = "meta" | "drafts" | "captures";
export type CaptureTransactionMode = "readonly" | "readwrite";

export interface CaptureBackendTransaction {
  getMeta(): Promise<StorageMetadata | undefined>;
  putMeta(value: StorageMetadata): Promise<unknown>;
  getDraft(id: string): Promise<CaptureDraft | undefined>;
  putDraft(draft: CaptureDraft): Promise<unknown>;
  deleteDraft(id: string): Promise<unknown>;
  clearDrafts(): Promise<unknown>;
  getAllDrafts(): Promise<CaptureDraft[]>;
  getCapture(id: string): Promise<CaptureRecord | undefined>;
  putCapture(record: CaptureRecord): Promise<unknown>;
  deleteCapture(id: string): Promise<unknown>;
  clearCaptures(): Promise<unknown>;
  getAllCaptures(): Promise<CaptureRecord[]>;
  findCaptureByDraftId(draftId: string): Promise<CaptureRecord | undefined>;
  getDueCaptures(timestamp: number): Promise<CaptureRecord[]>;
}

export interface CaptureBackend {
  readonly name: string;
  transaction<T>(
    stores: CaptureStoreName[],
    mode: CaptureTransactionMode,
    callback: (transaction: CaptureBackendTransaction) => Promise<T> | T
  ): Promise<T>;
  reconcile?(): Promise<unknown>;
}

export interface CaptureChangeEvent {
  kind: "import" | "draft" | "capture" | "maintenance";
  structural?: boolean;
  created?: boolean;
  id?: string;
  record?: CaptureRecord;
}

export type CaptureChangeHandler = (event: CaptureChangeEvent) => void | Promise<void>;

export interface TimerPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CryptoPort {
  randomUUID(): string;
  subtle: Pick<SubtleCrypto, "digest" | "encrypt" | "decrypt" | "generateKey" | "importKey" | "exportKey" | "sign" | "verify">;
}

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CaptureRepositoryPort {
  readonly backendName: string;
  setChangeHandler(handler: CaptureChangeHandler): void;
  load(): Promise<CaptureState>;
  save(state: CaptureState): Promise<CaptureState>;
  getDraft(id: string): Promise<CaptureDraft | null>;
  getActiveDraft(): Promise<CaptureDraft | null>;
  getCapture(id: string): Promise<CaptureRecord | null>;
  listCaptures(options?: { statuses?: DeliveryState[] }): Promise<CaptureRecord[]>;
  listDueCaptures(timestamp?: number): Promise<CaptureRecord[]>;
  listDrafts(): Promise<CaptureDraft[]>;
  upsertDraft(draft: CaptureDraft, expectedRevision?: number): Promise<CaptureDraft | null>;
  updateCapture(id: string, updates: CaptureRecordUpdate): Promise<CaptureRecord | null>;
  claimCapture(id: string, timestamp?: number): Promise<CaptureRecord | null>;
}

export type CaptureRecordUpdate = Partial<Omit<CaptureRecordBase, "version" | "id">> & {
  status?: DeliveryState;
  deliveredAt?: number;
  lastError?: DeliveryErrorMetadata | null;
  remote?: RemoteTarget | null;
};

type EmptyRequest<T extends string> = T extends string ? { type: T } : never;
type IdRequest<T extends string> = T extends string ? { type: T; id: string } : never;

export type CaptureDraftInput = Omit<CaptureDraft, "createdAt" | "updatedAt"> &
  Partial<Pick<CaptureDraft, "createdAt" | "updatedAt">>;

export interface CaptureStatusRecord {
  id: string;
  draftId: string;
  status: DeliveryState;
  updatedAt: number;
  nextAttemptAt: number;
  attemptCount: number;
  lastError: DeliveryErrorMetadata | null;
  remote: RemoteTarget | null;
  destination: Pick<CaptureDestination, "destinationName" | "destinationUrl" | "managedDestination"> | null;
}

export interface RecentItem {
  id: string;
  source: "draft" | "note" | "notion" | "notion-local";
  pageId?: string;
  title: string;
  preview: string;
  sources?: CaptureSource[];
  destinationName: string;
  status: string;
  mode?: "new" | "edit";
  updatedAt: number;
  remoteUrl: string;
  remotePageId?: string;
  editable: boolean;
  icon?: string;
}

export interface StorageDiagnostics {
  profile: "regular" | "incognito";
  backend: string;
  schemaVersion: number;
  migrationStatus: string;
  migrationError: string;
  lastMaintenanceAt: number;
  persistent: boolean;
  chromeStorage: { area: "local" | "session"; usedBytes: number; quotaBytes: number };
  captureStorage: { logicalBytes: number; drafts: number; queued: number; delivered: number };
  originStorage: { usedBytes: number; quotaBytes: number };
}

export type QuickSettings = Pick<Settings, "destinationName" | "includeSource" | "aiEnabled" | "aiSuggestTitle" | "aiExtractTodos"> & {
  connected: boolean;
  configured: boolean;
} & Partial<Pick<Settings, "authType">>;

export type RuntimeRequest =
  | EmptyRequest<"GET_QUICK_SETTINGS" | "LIST_CAPTURE_ACTIVITY" | "DELETE_DELIVERED_HISTORY" | "GET_STORAGE_DIAGNOSTICS" | "ENSURE_DEFAULT_DATABASE" | "GET_PENDING_COUNT" | "VALIDATE_CONNECTION" | "OPEN_SETTINGS" | "OPEN_ACTIVITY">
  | { type: "GET_OR_CREATE_DRAFT"; draftId?: string; tabId?: number; context?: CaptureContext; includeSource?: boolean; sessionId?: string }
  | { type: "UPSERT_DRAFT"; draft: CaptureDraftInput; expectedRevision?: number }
  | IdRequest<"DISCARD_DRAFT" | "CONVERT_EDIT_TO_NEW_DRAFT" | "DELETE_CAPTURE">
  | { type: "OPEN_CAPTURE_RESULT"; id: string; url?: string }
  | { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE"; draftId: string; capture: { document: CaptureDocument; sources?: CaptureSource[]; pageTitle?: string; url?: string; includeSource?: boolean; selection?: string }; context?: CaptureContext }
  | { type: "GET_CAPTURE_STATUS"; id?: string; draftId?: string }
  | { type: "LIST_RECENT_NOTES"; query?: string; limit?: number }
  | { type: "LOAD_RECENT_NOTE"; id: string; tabId?: number; sessionId?: string; reloadLatest?: boolean }
  | { type: "LOAD_NOTION_PAGE"; pageId: string; title?: string; url?: string; tabId?: number; sessionId?: string; reloadLatest?: boolean }
  | { type: "ACTIVATE_DRAFT"; id: string; returnDraftId?: string; sessionId?: string }
  | { type: "RELEASE_COMPOSER_SURFACE"; sessionId: string }
  | { type: "GET_PANEL_DRAFT"; draftId?: string; tabId?: number; sessionId?: string }
  | { type: "RETRY_CAPTURE" | "RETARGET_CAPTURE"; id: string; force?: boolean }
  | { type: "MARK_CAPTURE_DELIVERED"; id: string; remote: RemoteTarget }
  | { type: "EXPORT_CAPTURE_RECOVERY"; format: "json" | "markdown" }
  | { type: "OPEN_COMPOSER_FALLBACK"; draftId: string }
  | { type: "SEARCH_DESTINATIONS"; query?: string }
  | { type: "VALIDATE_DESTINATION"; destination: Destination }
  | { type: "DISCONNECT_NOTION"; confirmed?: boolean };

export interface FailureResponse {
  ok: false;
  error: string;
  code?: string;
  metadata?: DeliveryErrorMetadata;
  status?: number;
  kind?: string;
  retryAfter?: number;
  reconnect?: boolean;
  ready?: false;
}

export interface DisconnectConfirmationResponse {
  ok: false;
  requiresConfirmation: true;
  pendingCount: number;
}

type SuccessResponse<T extends object = Record<never, never>> = { ok: true } & T;

export interface RuntimeResponseMap {
  GET_QUICK_SETTINGS: SuccessResponse<QuickSettings>;
  GET_OR_CREATE_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  UPSERT_DRAFT: SuccessResponse<{ draft: CaptureDraft | null; discarded: boolean }>;
  DISCARD_DRAFT: SuccessResponse<{ discarded: boolean }>;
  ENQUEUE_CAPTURE: SuccessResponse<{ accepted: boolean; record: CaptureStatusRecord; reconciled?: boolean }>;
  SAVE_CAPTURE: RuntimeResponseMap["ENQUEUE_CAPTURE"];
  GET_CAPTURE_STATUS: SuccessResponse<{ record: CaptureStatusRecord | null }>;
  LIST_CAPTURE_ACTIVITY: SuccessResponse<{ incognito: boolean; drafts: CaptureDraft[]; queued: CaptureRecord[]; delivered: CaptureRecord[] }>;
  LIST_RECENT_NOTES: SuccessResponse<{ drafts: RecentItem[]; notes: RecentItem[]; notionPages: RecentItem[]; notionError: string }>;
  LOAD_RECENT_NOTE: SuccessResponse<{ draft: CaptureDraft; returnDraftId: string; conflict: boolean }>;
  LOAD_NOTION_PAGE: RuntimeResponseMap["LOAD_RECENT_NOTE"];
  CONVERT_EDIT_TO_NEW_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  ACTIVATE_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  RELEASE_COMPOSER_SURFACE: SuccessResponse;
  GET_PANEL_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  RETRY_CAPTURE: SuccessResponse<{ record: CaptureRecord }>;
  RETARGET_CAPTURE: SuccessResponse<{ record: CaptureRecord }>;
  MARK_CAPTURE_DELIVERED: SuccessResponse<{ record: CaptureRecord }>;
  DELETE_CAPTURE: SuccessResponse<{ deleted: boolean }>;
  DELETE_DELIVERED_HISTORY: SuccessResponse<{ deleted: number }>;
  GET_STORAGE_DIAGNOSTICS: SuccessResponse<{ diagnostics: StorageDiagnostics }>;
  EXPORT_CAPTURE_RECOVERY: SuccessResponse<{ export: RecoveryFile }>;
  OPEN_CAPTURE_RESULT: SuccessResponse;
  OPEN_ACTIVITY: SuccessResponse;
  OPEN_COMPOSER_FALLBACK: SuccessResponse;
  SEARCH_DESTINATIONS: SuccessResponse<{ destinations: Destination[] }>;
  VALIDATE_DESTINATION: SuccessResponse<{ ready: true }>;
  ENSURE_DEFAULT_DATABASE: SuccessResponse<{ destination: Destination; outcome: string }>;
  GET_PENDING_COUNT: SuccessResponse<{ count: number }>;
  DISCONNECT_NOTION: SuccessResponse<{ warning?: string }> | DisconnectConfirmationResponse;
  VALIDATE_CONNECTION: SuccessResponse<{ ready: true }>;
  OPEN_SETTINGS: SuccessResponse;
}

export type RuntimeResponse<T extends RuntimeRequest> = RuntimeResponseMap[T["type"]] | FailureResponse;

const MESSAGE_TYPE_VALUES = [
  "GET_QUICK_SETTINGS", "GET_OR_CREATE_DRAFT", "UPSERT_DRAFT", "DISCARD_DRAFT", "ENQUEUE_CAPTURE", "SAVE_CAPTURE",
  "GET_CAPTURE_STATUS", "LIST_CAPTURE_ACTIVITY", "LIST_RECENT_NOTES", "LOAD_RECENT_NOTE", "LOAD_NOTION_PAGE", "CONVERT_EDIT_TO_NEW_DRAFT",
  "ACTIVATE_DRAFT", "RELEASE_COMPOSER_SURFACE", "GET_PANEL_DRAFT", "RETRY_CAPTURE", "RETARGET_CAPTURE",
  "MARK_CAPTURE_DELIVERED", "DELETE_CAPTURE", "DELETE_DELIVERED_HISTORY", "GET_STORAGE_DIAGNOSTICS",
  "EXPORT_CAPTURE_RECOVERY", "OPEN_CAPTURE_RESULT", "OPEN_ACTIVITY", "OPEN_COMPOSER_FALLBACK", "SEARCH_DESTINATIONS",
  "VALIDATE_DESTINATION", "ENSURE_DEFAULT_DATABASE", "GET_PENDING_COUNT", "DISCONNECT_NOTION", "VALIDATE_CONNECTION", "OPEN_SETTINGS"
] as const satisfies readonly RuntimeRequest["type"][];

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!isRecord(value) || typeof value.type !== "string" || !isRuntimeMessageType(value.type)) return false;
  switch (value.type) {
    case "GET_QUICK_SETTINGS":
    case "LIST_CAPTURE_ACTIVITY":
    case "DELETE_DELIVERED_HISTORY":
    case "GET_STORAGE_DIAGNOSTICS":
    case "ENSURE_DEFAULT_DATABASE":
    case "GET_PENDING_COUNT":
    case "VALIDATE_CONNECTION":
    case "OPEN_SETTINGS":
    case "OPEN_ACTIVITY":
      return true;
    case "GET_OR_CREATE_DRAFT":
      return isOptionalString(value.draftId)
        && isOptionalInteger(value.tabId)
        && (value.context === undefined || isCaptureContext(value.context))
        && isOptionalBoolean(value.includeSource)
        && isOptionalString(value.sessionId);
    case "UPSERT_DRAFT":
      return isCaptureDraft(value.draft) && isOptionalInteger(value.expectedRevision);
    case "ENQUEUE_CAPTURE":
    case "SAVE_CAPTURE":
      return isNonEmptyString(value.draftId)
        && isCaptureRequest(value.capture)
        && (value.context === undefined || isCaptureContext(value.context));
    case "DISCARD_DRAFT":
    case "CONVERT_EDIT_TO_NEW_DRAFT":
    case "RETRY_CAPTURE":
    case "RETARGET_CAPTURE":
    case "DELETE_CAPTURE":
      return isNonEmptyString(value.id) && isOptionalBoolean(value.force);
    case "LOAD_RECENT_NOTE":
      return isNonEmptyString(value.id) && isOptionalInteger(value.tabId) && isOptionalString(value.sessionId) && isOptionalBoolean(value.reloadLatest);
    case "LOAD_NOTION_PAGE":
      return isNonEmptyString(value.pageId) && isOptionalString(value.title) && isOptionalString(value.url)
        && isOptionalInteger(value.tabId) && isOptionalString(value.sessionId) && isOptionalBoolean(value.reloadLatest);
    case "ACTIVATE_DRAFT":
      return isNonEmptyString(value.id) && isOptionalString(value.returnDraftId) && isOptionalString(value.sessionId);
    case "OPEN_CAPTURE_RESULT":
      return typeof value.id === "string" && isOptionalString(value.url) && (value.id.length > 0 || Boolean(value.url));
    case "MARK_CAPTURE_DELIVERED":
      return isNonEmptyString(value.id) && isRemoteTarget(value.remote);
    case "RELEASE_COMPOSER_SURFACE":
      return isNonEmptyString(value.sessionId);
    case "GET_PANEL_DRAFT":
      return isOptionalString(value.draftId) && isOptionalInteger(value.tabId) && isOptionalString(value.sessionId);
    case "GET_CAPTURE_STATUS":
      return isOptionalString(value.id) && isOptionalString(value.draftId) && Boolean(value.id || value.draftId);
    case "LIST_RECENT_NOTES":
      return isOptionalString(value.query) && isOptionalInteger(value.limit);
    case "OPEN_COMPOSER_FALLBACK":
      return isNonEmptyString(value.draftId);
    case "SEARCH_DESTINATIONS":
      return isOptionalString(value.query);
    case "DISCONNECT_NOTION":
      return isOptionalBoolean(value.confirmed);
    case "EXPORT_CAPTURE_RECOVERY":
      return value.format === "json" || value.format === "markdown";
    case "VALIDATE_DESTINATION":
      return isDestination(value.destination);
    default:
      return assertNever(value.type);
  }
}

export function isRuntimeResponse<T extends RuntimeRequest>(request: T, value: unknown): value is RuntimeResponse<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    if (request.type === "DISCONNECT_NOTION" && value.requiresConfirmation === true) {
      return Number.isInteger(value.pendingCount) && Number(value.pendingCount) >= 0;
    }
    return typeof value.error === "string";
  }
  switch (request.type) {
    case "GET_QUICK_SETTINGS":
      return typeof value.destinationName === "string" && typeof value.includeSource === "boolean"
        && typeof value.aiEnabled === "boolean" && typeof value.aiSuggestTitle === "boolean"
        && typeof value.aiExtractTodos === "boolean" && typeof value.connected === "boolean" && typeof value.configured === "boolean"
        && (value.authType === undefined || value.authType === "oauth" || value.authType === "token");
    case "GET_OR_CREATE_DRAFT":
    case "CONVERT_EDIT_TO_NEW_DRAFT":
    case "ACTIVATE_DRAFT":
    case "GET_PANEL_DRAFT":
      return isCompleteCaptureDraft(value.draft);
    case "UPSERT_DRAFT":
      return (value.draft === null || isCompleteCaptureDraft(value.draft)) && typeof value.discarded === "boolean";
    case "DISCARD_DRAFT":
      return typeof value.discarded === "boolean";
    case "ENQUEUE_CAPTURE":
    case "SAVE_CAPTURE":
      return typeof value.accepted === "boolean" && isCaptureStatusRecord(value.record) && isOptionalBoolean(value.reconciled);
    case "GET_CAPTURE_STATUS":
      return value.record === null || isCaptureStatusRecord(value.record);
    case "LIST_CAPTURE_ACTIVITY":
      return typeof value.incognito === "boolean" && isDraftArray(value.drafts)
        && isCaptureRecordArray(value.queued) && isCaptureRecordArray(value.delivered);
    case "LIST_RECENT_NOTES":
      return isRecentItemArray(value.drafts) && isRecentItemArray(value.notes) && isRecentItemArray(value.notionPages)
        && typeof value.notionError === "string";
    case "LOAD_RECENT_NOTE":
    case "LOAD_NOTION_PAGE":
      return isCompleteCaptureDraft(value.draft) && typeof value.returnDraftId === "string" && typeof value.conflict === "boolean";
    case "RELEASE_COMPOSER_SURFACE":
    case "OPEN_CAPTURE_RESULT":
    case "OPEN_ACTIVITY":
    case "OPEN_COMPOSER_FALLBACK":
    case "DISCONNECT_NOTION":
    case "OPEN_SETTINGS":
      return true;
    case "DELETE_CAPTURE":
      return typeof value.deleted === "boolean";
    case "DELETE_DELIVERED_HISTORY":
      return Number.isInteger(value.deleted) && Number(value.deleted) >= 0;
    case "RETRY_CAPTURE":
    case "RETARGET_CAPTURE":
    case "MARK_CAPTURE_DELIVERED":
      return isCaptureRecord(value.record);
    case "GET_STORAGE_DIAGNOSTICS":
      return isStorageDiagnostics(value.diagnostics);
    case "EXPORT_CAPTURE_RECOVERY":
      return isRecord(value.export) && typeof value.export.filename === "string"
        && (value.export.mimeType === "application/json" || value.export.mimeType === "text/markdown")
        && typeof value.export.content === "string";
    case "SEARCH_DESTINATIONS":
      return Array.isArray(value.destinations) && value.destinations.every(isDestination);
    case "VALIDATE_DESTINATION":
    case "VALIDATE_CONNECTION":
      return value.ready === true;
    case "ENSURE_DEFAULT_DATABASE":
      return isDestination(value.destination) && typeof value.outcome === "string";
    case "GET_PENDING_COUNT":
      return Number.isInteger(value.count) && Number(value.count) >= 0;
    default:
      return assertNever(request);
  }
}

function isRuntimeMessageType(value: string): value is RuntimeRequest["type"] {
  return MESSAGE_TYPE_VALUES.some((type) => type === value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalInteger(value: unknown): boolean {
  return value === undefined || Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function isEditorNode(value: unknown): value is EditorNode {
  return isRecord(value)
    && isNonEmptyString(value.type)
    && isOptionalString(value.text)
    && (value.attrs === undefined || (isRecord(value.attrs) && Object.values(value.attrs).every(isJsonValue)))
    && (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every((mark) => isRecord(mark)
      && isNonEmptyString(mark.type)
      && (mark.attrs === undefined || (isRecord(mark.attrs) && Object.values(mark.attrs).every(isJsonValue))))))
    && (value.content === undefined || (Array.isArray(value.content) && value.content.every(isEditorNode)));
}

function isCaptureContext(value: unknown): value is CaptureContext {
  return isRecord(value) && value.version === 1 && typeof value.title === "string" && typeof value.url === "string"
    && typeof value.selection === "string" && typeof value.capturedAt === "number" && Number.isFinite(value.capturedAt)
    && isOptionalString(value.frameUrl);
}

function isCaptureSource(value: unknown): value is CaptureSource {
  return isRecord(value) && typeof value.title === "string" && typeof value.url === "string"
    && typeof value.selection === "string" && typeof value.capturedAt === "number" && Number.isFinite(value.capturedAt);
}

function isRemoteTarget(value: unknown): value is RemoteTarget {
  return isRecord(value) && ["page", "section", "legacy_section"].includes(String(value.kind))
    && isNonEmptyString(value.id) && typeof value.url === "string" && isNonEmptyString(value.pageId)
    && isOptionalString(value.lastEditedTime) && isStringArray(value.blockIds) && typeof value.fingerprint === "string";
}

function isDestinationProperties(value: unknown): value is Record<string, DestinationProperty> {
  return isRecord(value) && Object.values(value).every((property) => isRecord(property)
    && typeof property.id === "string" && typeof property.name === "string");
}

function isDestination(value: unknown): value is Destination {
  return isRecord(value) && isNonEmptyString(value.id) && (value.type === "page" || value.type === "database")
    && typeof value.name === "string" && isOptionalString(value.url) && isOptionalString(value.icon) && isOptionalString(value.databaseId)
    && isOptionalString(value.titleProperty) && isOptionalBoolean(value.managedDestination)
    && (value.schemaVersion === undefined || typeof value.schemaVersion === "number") && isOptionalString(value.marker)
    && (value.properties === undefined || isDestinationProperties(value.properties));
}

function isCaptureDraft(value: unknown): value is CaptureDraftInput {
  return isRecord(value) && value.version === 2 && isNonEmptyString(value.id)
    && (value.tabId === null || Number.isInteger(value.tabId)) && isCaptureContext(value.context)
    && (value.mode === "new" || value.mode === "edit") && typeof value.targetRecordId === "string"
    && Array.isArray(value.sources) && value.sources.every(isCaptureSource) && isStringArray(value.dismissedSourceUrls)
    && Number.isInteger(value.revision) && typeof value.sessionId === "string" && typeof value.returnDraftId === "string"
    && typeof value.title === "string" && typeof value.includeSource === "boolean" && isEditorNode(value.doc)
    && (value.remote === null || isRemoteTarget(value.remote)) && typeof value.baseFingerprint === "string"
    && (value.createdAt === undefined || typeof value.createdAt === "number")
    && (value.updatedAt === undefined || typeof value.updatedAt === "number");
}

export function isCompleteCaptureDraft(value: unknown): value is CaptureDraft {
  return isCaptureDraft(value) && typeof value.createdAt === "number" && typeof value.updatedAt === "number";
}

function isDraftArray(value: unknown): value is CaptureDraft[] {
  return Array.isArray(value) && value.every(isCompleteCaptureDraft);
}

export function isCaptureStatusRecord(value: unknown): value is CaptureStatusRecord {
  return isRecord(value) && isNonEmptyString(value.id) && typeof value.draftId === "string"
    && isDeliveryState(value.status) && typeof value.updatedAt === "number" && typeof value.nextAttemptAt === "number"
    && typeof value.attemptCount === "number" && (value.lastError === null || isDeliveryErrorMetadata(value.lastError))
    && (value.remote === null || isRemoteTarget(value.remote))
    && (value.destination === null || isCaptureStatusDestination(value.destination));
}

function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!isRecord(value) || value.version !== 2 || !isNonEmptyString(value.id) || typeof value.draftId !== "string"
    || (value.scope !== "regular" && value.scope !== "incognito") || !isCapturePayload(value.capture)
    || (value.syncedCapture !== null && !isCapturePayload(value.syncedCapture))
    || (value.pendingCapture !== null && !isCapturePayload(value.pendingCapture))
    || (value.operation !== "" && value.operation !== "create" && value.operation !== "update")
    || !isCaptureContext(value.context) || (value.destination !== null && !isCaptureDestination(value.destination))
    || typeof value.connectionId !== "string" || !isFiniteNumber(value.attemptCount) || !isFiniteNumber(value.firstAttemptAt)
    || !isFiniteNumber(value.lastAttemptAt) || !isFiniteNumber(value.nextAttemptAt) || !isFiniteNumber(value.createdAt)
    || !isFiniteNumber(value.updatedAt) || typeof value.forceRetry !== "boolean" || typeof value.baseFingerprint !== "string"
    || (value.syncJournal !== null && !isSyncJournal(value.syncJournal)) || typeof value.importedFromNotion !== "boolean"
    || !isDeliveryState(value.status) || !isFiniteNumber(value.deliveredAt)) return false;
  if (value.status === "delivered") {
    return value.deliveredAt > 0 && value.lastError === null && isRemoteTarget(value.remote);
  }
  if (value.status === "pending" || value.status === "sending") {
    return value.deliveredAt === 0 && (value.lastError === null || isDeliveryErrorMetadata(value.lastError))
      && (value.remote === null || isRemoteTarget(value.remote));
  }
  return value.deliveredAt === 0 && isDeliveryErrorMetadata(value.lastError)
    && (value.remote === null || isRemoteTarget(value.remote));
}

function isCaptureRecordArray(value: unknown): value is CaptureRecord[] {
  return Array.isArray(value) && value.every(isCaptureRecord);
}

export function isRecentItemArray(value: unknown): value is RecentItem[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && isNonEmptyString(item.id)
    && typeof item.source === "string" && ["draft", "note", "notion", "notion-local"].includes(item.source)
    && isOptionalString(item.pageId) && typeof item.title === "string" && typeof item.preview === "string"
    && (item.sources === undefined || (Array.isArray(item.sources) && item.sources.every(isCaptureSource)))
    && typeof item.destinationName === "string" && typeof item.status === "string" && typeof item.updatedAt === "number"
    && (item.mode === undefined || item.mode === "new" || item.mode === "edit")
    && typeof item.remoteUrl === "string" && isOptionalString(item.remotePageId)
    && typeof item.editable === "boolean" && isOptionalString(item.icon));
}

function isStorageDiagnostics(value: unknown): value is StorageDiagnostics {
  return isRecord(value) && (value.profile === "regular" || value.profile === "incognito") && typeof value.backend === "string"
    && typeof value.schemaVersion === "number" && isRecord(value.captureStorage) && typeof value.captureStorage.logicalBytes === "number"
    && typeof value.captureStorage.drafts === "number" && typeof value.captureStorage.queued === "number"
    && typeof value.captureStorage.delivered === "number" && isRecord(value.chromeStorage) && isRecord(value.originStorage);
}

const DELIVERY_STATES: readonly string[] = [
  "pending", "sending", "delivered", "blocked_setup", "blocked_auth", "blocked_destination", "blocked_conflict", "uncertain"
];

function isDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === "string" && DELIVERY_STATES.includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDeliveryErrorMetadata(value: unknown): value is DeliveryErrorMetadata {
  return isRecord(value) && isDeliveryErrorKind(value.kind) && typeof value.message === "string"
    && (value.status === undefined || isFiniteNumber(value.status)) && isOptionalString(value.code)
    && (value.retryAfter === undefined || isFiniteNumber(value.retryAfter));
}

const DELIVERY_ERROR_KINDS: readonly string[] = [
  "authentication", "auth", "setup", "destination", "conflict", "remote_conflict", "connection_changed", "rate_limited",
  "retryable", "ambiguous", "ambiguous_managed", "ambiguous_manual", "interrupted", "attention_required", "timeout",
  "timeout_manual", "offline", "delivery", "unknown"
];

function isDeliveryErrorKind(value: unknown): value is DeliveryErrorKind {
  return typeof value === "string" && DELIVERY_ERROR_KINDS.includes(value);
}

function isCaptureStatusDestination(value: unknown): boolean {
  return isRecord(value) && isOptionalString(value.destinationName) && isOptionalString(value.destinationUrl)
    && isOptionalBoolean(value.managedDestination);
}

function isCaptureDestination(value: unknown): value is CaptureDestination {
  return isRecord(value) && isOptionalString(value.destinationId) && isOptionalString(value.destinationDatabaseId)
    && isOptionalString(value.destinationName) && isOptionalString(value.destinationUrl)
    && (value.destinationType === undefined || value.destinationType === "page" || value.destinationType === "database")
    && isOptionalString(value.titleProperty) && isOptionalBoolean(value.managedDestination)
    && (value.destinationSchemaVersion === undefined || isFiniteNumber(value.destinationSchemaVersion))
    && isOptionalString(value.destinationMarker)
    && (value.destinationProperties === undefined || isDestinationProperties(value.destinationProperties))
    && isOptionalString(value.destinationConnectionId);
}

function isCapturePayload(value: unknown): value is CapturePayload {
  return isRecord(value) && isRecord(value.document) && value.document.version === 1
    && typeof value.document.title === "string" && isEditorNode(value.document.doc) && typeof value.captureId === "string"
    && Array.isArray(value.sources) && value.sources.every(isCaptureSource) && typeof value.includeSource === "boolean";
}

function isSyncJournal(value: unknown): value is SyncJournal {
  return isRecord(value) && Object.values(value).every((entry) => entry === undefined || isJsonValue(entry));
}

function isCaptureRequest(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.document) || value.document.version !== 1
    || typeof value.document.title !== "string" || !isEditorNode(value.document.doc)) return false;
  return (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(isCaptureSource)))
    && isOptionalString(value.pageTitle) && isOptionalString(value.url)
    && isOptionalBoolean(value.includeSource) && isOptionalString(value.selection);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${String(value)}`);
}

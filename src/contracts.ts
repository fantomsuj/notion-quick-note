export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EditorMark {
  type: string;
  attrs?: Record<string, JsonValue>;
}

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
}

export interface CaptureSource {
  title: string;
  url: string;
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
  url: string;
  titleProperty?: string;
  managedDestination?: boolean;
  schemaVersion?: number;
  marker?: string;
  properties?: Record<string, DestinationProperty>;
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
  marker: string;
  connectionId: string;
  status: "pending" | "uncertain";
  attemptedAt: number;
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
  | "destination"
  | "conflict"
  | "rate_limited"
  | "retryable"
  | "ambiguous"
  | "interrupted"
  | "unknown";

export interface DeliveryErrorMetadata {
  kind: DeliveryErrorKind;
  message: string;
  status?: number;
  code?: string;
  retryAfter?: number;
}

export interface RemoteTarget {
  id: string;
  url: string;
  lastEditedTime?: string;
  blockIds?: string[];
  fingerprint?: string;
}

export interface SyncJournal {
  version: 1;
  phase: "inserting" | "archiving";
  insertedBlockIds: string[];
  archivedBlockIds: string[];
  replacementFingerprint: string;
}

export interface CaptureDraft {
  version: 2;
  id: string;
  tabId: number | null;
  context: CaptureContext;
  mode: "new" | "edit";
  targetRecordId: string;
  sources: CaptureSource[];
  revision: number;
  sessionId: string;
  returnDraftId: string;
  title: string;
  includeSource: boolean;
  doc: EditorNode;
  createdAt: number;
  updatedAt: number;
}

interface CaptureRecordBase {
  version: 2;
  id: string;
  draftId: string;
  document: CaptureDocument;
  destination: Destination | null;
  connectionId: string;
  sources: CaptureSource[];
  attemptCount: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: DeliveryErrorMetadata | null;
  remote: RemoteTarget | null;
  syncJournal?: SyncJournal;
}

export type CaptureRecord = CaptureRecordBase & (
  | { status: "pending" | "sending"; deliveredAt: 0 }
  | { status: "delivered"; deliveredAt: number; remote: RemoteTarget }
  | { status: "blocked_setup" | "blocked_auth" | "blocked_destination" | "blocked_conflict" | "uncertain"; deliveredAt: 0; lastError: DeliveryErrorMetadata }
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
  migrationStatus: "pending" | "complete" | "failed";
  migrationError: string;
  lastMaintenanceAt: number;
}

export interface RecoveryExport {
  version: 1;
  exportedAt: string;
  captures: CaptureRecord[];
  drafts: CaptureDraft[];
}

export interface KeyValueStoragePort {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

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
  getCapture(id: string): Promise<CaptureRecord | null>;
  listCaptures(options?: { statuses?: DeliveryState[] }): Promise<CaptureRecord[]>;
  listDrafts(): Promise<CaptureDraft[]>;
  upsertDraft(draft: CaptureDraft, expectedRevision?: number): Promise<CaptureDraft | null>;
}

type EmptyRequest<T extends string> = T extends string ? { type: T } : never;
type IdRequest<T extends string> = T extends string ? { type: T; id: string } : never;

export type RuntimeRequest =
  | EmptyRequest<"GET_QUICK_SETTINGS" | "LIST_CAPTURE_ACTIVITY" | "DELETE_DELIVERED_HISTORY" | "GET_STORAGE_DIAGNOSTICS" | "ENSURE_DEFAULT_DATABASE" | "GET_PENDING_COUNT" | "VALIDATE_CONNECTION" | "OPEN_SETTINGS" | "OPEN_ACTIVITY">
  | { type: "GET_OR_CREATE_DRAFT"; draftId?: string; tabId?: number; context?: CaptureContext; includeSource?: boolean; sessionId?: string }
  | { type: "UPSERT_DRAFT"; draft: CaptureDraft; expectedRevision?: number }
  | IdRequest<"DISCARD_DRAFT" | "CONVERT_EDIT_TO_NEW_DRAFT" | "OPEN_CAPTURE_RESULT" | "DELETE_CAPTURE">
  | { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE"; draftId: string; capture: { document: CaptureDocument; pageTitle?: string; url?: string; includeSource?: boolean }; context?: CaptureContext }
  | { type: "GET_CAPTURE_STATUS"; id?: string; draftId?: string }
  | { type: "LIST_RECENT_NOTES"; query?: string; limit?: number }
  | { type: "LOAD_RECENT_NOTE"; id: string; tabId?: number; sessionId?: string }
  | { type: "ACTIVATE_DRAFT"; id: string; returnDraftId?: string }
  | { type: "RELEASE_COMPOSER_SURFACE"; sessionId: string }
  | { type: "GET_PANEL_DRAFT"; draftId?: string; sessionId?: string }
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
}

type SuccessResponse<T extends object = Record<never, never>> = { ok: true } & T;

export interface RuntimeResponseMap {
  GET_QUICK_SETTINGS: SuccessResponse<Partial<Settings>>;
  GET_OR_CREATE_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  UPSERT_DRAFT: SuccessResponse<{ draft: CaptureDraft | null; discarded: boolean }>;
  DISCARD_DRAFT: SuccessResponse<{ discarded: boolean }>;
  ENQUEUE_CAPTURE: SuccessResponse<{ accepted: boolean; record: CaptureRecord; reconciled?: boolean }>;
  SAVE_CAPTURE: RuntimeResponseMap["ENQUEUE_CAPTURE"];
  GET_CAPTURE_STATUS: SuccessResponse<{ record: CaptureRecord | null }>;
  LIST_CAPTURE_ACTIVITY: SuccessResponse<{ drafts: CaptureDraft[]; captures: CaptureRecord[] }>;
  LIST_RECENT_NOTES: SuccessResponse<{ notes: CaptureRecord[] }>;
  LOAD_RECENT_NOTE: SuccessResponse<{ draft: CaptureDraft }>;
  CONVERT_EDIT_TO_NEW_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  ACTIVATE_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  RELEASE_COMPOSER_SURFACE: SuccessResponse;
  GET_PANEL_DRAFT: SuccessResponse<{ draft: CaptureDraft }>;
  RETRY_CAPTURE: SuccessResponse<{ record: CaptureRecord }>;
  RETARGET_CAPTURE: SuccessResponse<{ record: CaptureRecord }>;
  MARK_CAPTURE_DELIVERED: SuccessResponse<{ record: CaptureRecord }>;
  DELETE_CAPTURE: SuccessResponse;
  DELETE_DELIVERED_HISTORY: SuccessResponse;
  GET_STORAGE_DIAGNOSTICS: SuccessResponse<{ diagnostics: Record<string, JsonValue> }>;
  EXPORT_CAPTURE_RECOVERY: SuccessResponse<{ export: RecoveryExport | string }>;
  OPEN_CAPTURE_RESULT: SuccessResponse;
  OPEN_ACTIVITY: SuccessResponse;
  OPEN_COMPOSER_FALLBACK: SuccessResponse;
  SEARCH_DESTINATIONS: SuccessResponse<{ destinations: Destination[] }>;
  VALIDATE_DESTINATION: SuccessResponse<{ destination: Destination }>;
  ENSURE_DEFAULT_DATABASE: SuccessResponse<{ destination: Destination; outcome: string }>;
  GET_PENDING_COUNT: SuccessResponse<{ count: number }>;
  DISCONNECT_NOTION: SuccessResponse;
  VALIDATE_CONNECTION: SuccessResponse<{ connected: boolean }>;
  OPEN_SETTINGS: SuccessResponse;
}

export type RuntimeResponse<T extends RuntimeRequest> = RuntimeResponseMap[T["type"]] | FailureResponse;

const MESSAGE_TYPES: ReadonlySet<RuntimeRequest["type"]> = new Set([
  "GET_QUICK_SETTINGS", "GET_OR_CREATE_DRAFT", "UPSERT_DRAFT", "DISCARD_DRAFT", "ENQUEUE_CAPTURE", "SAVE_CAPTURE",
  "GET_CAPTURE_STATUS", "LIST_CAPTURE_ACTIVITY", "LIST_RECENT_NOTES", "LOAD_RECENT_NOTE", "CONVERT_EDIT_TO_NEW_DRAFT",
  "ACTIVATE_DRAFT", "RELEASE_COMPOSER_SURFACE", "GET_PANEL_DRAFT", "RETRY_CAPTURE", "RETARGET_CAPTURE",
  "MARK_CAPTURE_DELIVERED", "DELETE_CAPTURE", "DELETE_DELIVERED_HISTORY", "GET_STORAGE_DIAGNOSTICS",
  "EXPORT_CAPTURE_RECOVERY", "OPEN_CAPTURE_RESULT", "OPEN_ACTIVITY", "OPEN_COMPOSER_FALLBACK", "SEARCH_DESTINATIONS",
  "VALIDATE_DESTINATION", "ENSURE_DEFAULT_DATABASE", "GET_PENDING_COUNT", "DISCONNECT_NOTION", "VALIDATE_CONNECTION", "OPEN_SETTINGS"
]);

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!isRecord(value) || typeof value.type !== "string" || !MESSAGE_TYPES.has(value.type as RuntimeRequest["type"])) return false;
  switch (value.type) {
    case "UPSERT_DRAFT":
      return isRecord(value.draft) && typeof value.draft.id === "string";
    case "ENQUEUE_CAPTURE":
    case "SAVE_CAPTURE":
      return typeof value.draftId === "string" && isRecord(value.capture) && isRecord(value.capture.document);
    case "DISCARD_DRAFT":
    case "CONVERT_EDIT_TO_NEW_DRAFT":
    case "LOAD_RECENT_NOTE":
    case "RETRY_CAPTURE":
    case "RETARGET_CAPTURE":
    case "DELETE_CAPTURE":
    case "OPEN_CAPTURE_RESULT":
      return typeof value.id === "string" && value.id.length > 0;
    case "MARK_CAPTURE_DELIVERED":
      return typeof value.id === "string" && isRecord(value.remote) && typeof value.remote.id === "string" && typeof value.remote.url === "string";
    case "RELEASE_COMPOSER_SURFACE":
      return typeof value.sessionId === "string";
    case "OPEN_COMPOSER_FALLBACK":
      return typeof value.draftId === "string";
    case "EXPORT_CAPTURE_RECOVERY":
      return value.format === "json" || value.format === "markdown";
    case "VALIDATE_DESTINATION":
      return isRecord(value.destination) && typeof value.destination.id === "string" && (value.destination.type === "page" || value.destination.type === "database");
    default:
      return true;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${String(value)}`);
}

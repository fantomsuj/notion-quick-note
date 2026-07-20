import {
  isCaptureStatusRecord,
  isCompleteCaptureDraft,
  isRecentItemArray,
  isRecord,
  isRuntimeResponse,
  type RuntimeRequest,
  type RuntimeResponse
} from "./contracts.js";

export type ContentRuntimeRequest = Extract<RuntimeRequest, {
  type:
    | "GET_QUICK_SETTINGS"
    | "GET_OR_CREATE_DRAFT"
    | "UPSERT_DRAFT"
    | "DISCARD_DRAFT"
    | "ENQUEUE_CAPTURE"
    | "SAVE_CAPTURE"
    | "GET_CAPTURE_STATUS"
    | "LIST_RECENT_NOTES"
    | "LOAD_RECENT_NOTE"
    | "LOAD_NOTION_PAGE"
    | "CONVERT_EDIT_TO_NEW_DRAFT"
    | "ACTIVATE_DRAFT"
    | "RELEASE_COMPOSER_SURFACE"
    | "GET_PANEL_DRAFT"
    | "OPEN_CAPTURE_RESULT"
    | "OPEN_ACTIVITY"
    | "OPEN_COMPOSER_FALLBACK"
    | "OPEN_SETTINGS"
}>;

export function isContentRuntimeResponse<T extends ContentRuntimeRequest>(request: T, value: unknown): value is RuntimeResponse<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string";
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
      return typeof value.accepted === "boolean" && isCaptureStatusRecord(value.record)
        && (value.reconciled === undefined || typeof value.reconciled === "boolean");
    case "GET_CAPTURE_STATUS":
      return value.record === null || isCaptureStatusRecord(value.record);
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
    case "OPEN_SETTINGS":
      return true;
    default: {
      const unexpected: never = request;
      return Boolean(unexpected);
    }
  }
}

export const RUNTIME_MESSAGE_TIMEOUT_MS = 5_000;

export class RuntimeMessageTimeoutError extends Error {
  readonly code = "runtime_message_timeout" as const;

  constructor(message = "Quick Note did not receive a response from the extension.") {
    super(message);
    this.name = "RuntimeMessageTimeoutError";
  }
}

interface TimerOverrides {
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimer?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export function withRuntimeMessageDeadline<T>(
  promise: PromiseLike<T> | T,
  timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS,
  {
    setTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer = (handle) => globalThis.clearTimeout(handle)
  }: TimerOverrides = {}
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimer(() => reject(new RuntimeMessageTimeoutError()), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer !== undefined) clearTimer(timer);
  });
}

export async function sendRuntimeRequest<T extends RuntimeRequest>(message: T): Promise<RuntimeResponse<T>> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (!isRuntimeResponse(message, response)) throw new Error(`Quick Note received a malformed response for ${message.type}.`);
  return response;
}

type EnqueueRequest = Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }>;
type CaptureStatusRequest = Extract<RuntimeRequest, { type: "GET_CAPTURE_STATUS" }>;

interface ReconciliationOptions {
  send: (message: EnqueueRequest | CaptureStatusRequest) => Promise<RuntimeResponse<EnqueueRequest> | RuntimeResponse<CaptureStatusRequest>>;
  message: EnqueueRequest;
  draftId: string;
}

export async function enqueueWithReconciliation({
  send,
  message,
  draftId
}: ReconciliationOptions): Promise<RuntimeResponse<EnqueueRequest>> {
  try {
    const response = await send(message);
    if (!response.ok || "accepted" in response) return response;
    throw new Error("Quick Note received a mismatched enqueue response.");
  } catch (error: unknown) {
    if (!(error instanceof RuntimeMessageTimeoutError)) throw error;
    const status = await send({ type: "GET_CAPTURE_STATUS", draftId }).catch(() => null);
    if (status?.ok && !("accepted" in status) && status.record) {
      const reconciled: RuntimeResponse<EnqueueRequest> = { ok: true, accepted: true, record: status.record, reconciled: true };
      return reconciled;
    }
    throw error;
  }
}

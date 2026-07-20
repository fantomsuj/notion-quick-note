import type {
  CaptureDraft,
  CaptureRecord,
  CaptureRepositoryPort,
  DeliveryErrorMetadata,
  NotionColorName,
  PanelContextMessage,
  PanelNavigationMessage,
  PanelRegistrationMessage,
  PanelToWorkerMessage,
  RuntimeRequest,
  RuntimeResponse,
  WorkerToPanelMessage
} from "../../src/contracts.js";
import { isPanelRegistrationMessage } from "../../src/contracts.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type PendingRecord = CaptureRecord & { status: "pending" };
type DeliveredRecord = Extract<CaptureRecord, { status: "delivered" }>;
type TerminalRecord = CaptureRecord & { status: "uncertain" };
type _PendingHasZeroDeliveredAt = Expect<Equal<PendingRecord["deliveredAt"], 0>>;
type _DeliveredHasRemote = Expect<Equal<DeliveredRecord["remote"], NonNullable<DeliveredRecord["remote"]>>>;
type _TerminalHasTypedError = Expect<Equal<TerminalRecord["lastError"], DeliveryErrorMetadata>>;
type _GetCaptureReturnsRecord = Expect<Equal<ReturnType<CaptureRepositoryPort["getCapture"]>, Promise<CaptureRecord | null>>>;
type _UpdateCaptureReturnsRecord = Expect<Equal<ReturnType<CaptureRepositoryPort["updateCapture"]>, Promise<CaptureRecord | null>>>;
type _DraftDismissalsAreNormalizedUrls = Expect<Equal<CaptureDraft["dismissedSourceUrls"], string[]>>;
type _NotionColorNamesAreExact = Expect<Equal<NotionColorName,
  "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red"
>>;

type SettingsRequest = Extract<RuntimeRequest, { type: "GET_QUICK_SETTINGS" }>;
type SettingsResponse = RuntimeResponse<SettingsRequest>;
type _SettingsResponseCorrelates = Expect<Equal<Extract<SettingsResponse, { ok: true }>["authType"], "oauth" | "token" | undefined>>;

type _RepositoryPortIsAvailable = CaptureRepositoryPort;

type _PanelToWorkerIsRegistration = Expect<Equal<PanelToWorkerMessage, PanelRegistrationMessage>>;
type _PanelNavigationCommands = Expect<Equal<PanelNavigationMessage,
  | { type: "SHOW_COMPOSER"; draftId?: string; tabId?: number }
  | { type: "SHOW_ACTIVITY" }
>>;
type _PanelContextCommand = Expect<Equal<PanelContextMessage,
  { type: "ACTIVE_PAGE_CONTEXT"; tabId: number; page: import("../../src/contracts.js").CaptureContext }
>>;
type _WorkerToPanelMessages = Expect<Equal<WorkerToPanelMessage, PanelNavigationMessage | PanelContextMessage>>;

declare const possibleRegistration: unknown;
if (isPanelRegistrationMessage(possibleRegistration)) {
  const _windowId: number = possibleRegistration.windowId;
  const _registration: PanelRegistrationMessage = possibleRegistration;
}

// @ts-expect-error A navigation message cannot use a string tab ID.
const _InvalidPanelNavigation: PanelNavigationMessage = { type: "SHOW_COMPOSER", tabId: "12" };

// @ts-expect-error Active page context requires a tab ID.
const _InvalidPanelContext: PanelContextMessage = { type: "ACTIVE_PAGE_CONTEXT", page: {} };

// @ts-expect-error A response type can only be requested for a valid runtime request.
type _InvalidRequest = RuntimeResponse<{ type: "NOT_A_MESSAGE" }>;

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ContentRuntimeRequest,
  enqueueWithReconciliation,
  isContentRuntimeResponse,
  RuntimeMessageTimeoutError,
  sendRuntimeRequest,
  withRuntimeMessageDeadline
} from "../src/runtime-message.js";
import { isRuntimeRequest, isRuntimeResponse, type CaptureDraft, type CaptureStatusRecord, type RuntimeRequest } from "../src/contracts.js";

const captureStatus: CaptureStatusRecord = {
  id: "capture-1",
  draftId: "draft-1",
  status: "sending",
  updatedAt: 1,
  nextAttemptAt: 0,
  attemptCount: 1,
  lastError: null,
  remote: null,
  destination: null
};

const enqueueMessage: Extract<RuntimeRequest, { type: "ENQUEUE_CAPTURE" | "SAVE_CAPTURE" }> = {
  type: "ENQUEUE_CAPTURE",
  draftId: "draft-1",
  capture: {
    document: {
      version: 1,
      title: "Note",
      doc: { type: "doc", content: [{ type: "paragraph" }] }
    }
  }
};

const context = {
  version: 1,
  title: "Example",
  url: "https://example.com",
  selection: "Selected",
  capturedAt: 1
} as const;
const doc = { type: "doc", content: [{ type: "paragraph" }] };
const document = { version: 1, title: "Note", doc } as const;
const remote = {
  kind: "page",
  id: "page",
  url: "https://notion.so/page",
  pageId: "page",
  blockIds: [],
  fingerprint: "fingerprint"
} as const;
const draft: CaptureDraft = {
  version: 2,
  id: "draft",
  tabId: null,
  context,
  mode: "new",
  targetRecordId: "",
  sources: [],
  dismissedSourceUrls: [],
  revision: 1,
  sessionId: "session",
  returnDraftId: "",
  title: "Note",
  includeSource: true,
  doc,
  remote: null,
  baseFingerprint: "",
  createdAt: 1,
  updatedAt: 1
};
const capture = { document, captureId: "capture", sources: [], includeSource: true };
const captureRecord = {
  version: 2,
  id: "capture",
  draftId: "draft",
  scope: "regular",
  capture,
  syncedCapture: null,
  pendingCapture: capture,
  operation: "",
  context,
  destination: null,
  connectionId: "connection",
  attemptCount: 0,
  firstAttemptAt: 0,
  lastAttemptAt: 0,
  nextAttemptAt: 0,
  createdAt: 1,
  updatedAt: 1,
  forceRetry: false,
  baseFingerprint: "",
  syncJournal: null,
  importedFromNotion: false,
  status: "pending",
  deliveredAt: 0,
  lastError: null,
  remote: null
} as const;

const contentResponseCases: Array<{
  request: ContentRuntimeRequest;
  valid: unknown;
  invalid: unknown;
}> = [
  { request: { type: "GET_QUICK_SETTINGS" }, valid: { ok: true, destinationName: "Inbox", includeSource: true, aiEnabled: false, aiSuggestTitle: false, aiExtractTodos: false, connected: true, configured: true }, invalid: { ok: true, destinationName: "Inbox" } },
  { request: { type: "GET_OR_CREATE_DRAFT" }, valid: { ok: true, draft }, invalid: { ok: true, draft: { ...draft, updatedAt: "now" } } },
  { request: { type: "UPSERT_DRAFT", draft }, valid: { ok: true, draft, discarded: false }, invalid: { ok: true, draft, discarded: "no" } },
  { request: { type: "DISCARD_DRAFT", id: "draft" }, valid: { ok: true, discarded: true }, invalid: { ok: true } },
  { request: enqueueMessage, valid: { ok: true, accepted: true, record: captureStatus }, invalid: { ok: true, accepted: true, record: { ...captureStatus, attemptCount: "one" } } },
  { request: { ...enqueueMessage, type: "SAVE_CAPTURE" }, valid: { ok: true, accepted: true, record: captureStatus }, invalid: { ok: true, accepted: "yes", record: captureStatus } },
  { request: { type: "GET_CAPTURE_STATUS", id: "capture" }, valid: { ok: true, record: captureStatus }, invalid: { ok: true, record: { id: "capture" } } },
  { request: { type: "LIST_RECENT_NOTES" }, valid: { ok: true, drafts: [], notes: [], notionPages: [], notionError: "" }, invalid: { ok: true, drafts: [], notes: [], notionPages: [] } },
  { request: { type: "LOAD_RECENT_NOTE", id: "note" }, valid: { ok: true, draft, returnDraftId: "return", conflict: false }, invalid: { ok: true, draft, returnDraftId: "return" } },
  { request: { type: "LOAD_NOTION_PAGE", pageId: "page" }, valid: { ok: true, draft, returnDraftId: "return", conflict: false }, invalid: { ok: true, draft: null, returnDraftId: "return", conflict: false } },
  { request: { type: "CONVERT_EDIT_TO_NEW_DRAFT", id: "draft" }, valid: { ok: true, draft }, invalid: { ok: true, draft: { ...draft, doc: null } } },
  { request: { type: "ACTIVATE_DRAFT", id: "draft" }, valid: { ok: true, draft }, invalid: { ok: true } },
  { request: { type: "RELEASE_COMPOSER_SURFACE", sessionId: "session" }, valid: { ok: true }, invalid: { ok: "yes" } },
  { request: { type: "GET_PANEL_DRAFT" }, valid: { ok: true, draft }, invalid: { ok: true, draft: null } },
  { request: { type: "OPEN_CAPTURE_RESULT", id: "capture" }, valid: { ok: true }, invalid: null },
  { request: { type: "OPEN_ACTIVITY" }, valid: { ok: true }, invalid: { ok: false } },
  { request: { type: "OPEN_COMPOSER_FALLBACK", draftId: "draft" }, valid: { ok: true }, invalid: [] },
  { request: { type: "OPEN_SETTINGS" }, valid: { ok: true }, invalid: { ok: "yes" } }
];

test("content runtime response guards validate every correlated content request", () => {
  assert.deepEqual(contentResponseCases.map(({ request }) => request.type).sort(), [
    "ACTIVATE_DRAFT", "CONVERT_EDIT_TO_NEW_DRAFT", "DISCARD_DRAFT", "ENQUEUE_CAPTURE", "GET_CAPTURE_STATUS",
    "GET_OR_CREATE_DRAFT", "GET_PANEL_DRAFT", "GET_QUICK_SETTINGS", "LIST_RECENT_NOTES", "LOAD_NOTION_PAGE",
    "LOAD_RECENT_NOTE", "OPEN_ACTIVITY", "OPEN_CAPTURE_RESULT", "OPEN_COMPOSER_FALLBACK", "OPEN_SETTINGS",
    "RELEASE_COMPOSER_SURFACE", "SAVE_CAPTURE", "UPSERT_DRAFT"
  ]);
  for (const { request, valid, invalid } of contentResponseCases) {
    assert.equal(isContentRuntimeResponse(request, valid), true, `${request.type} valid response`);
    assert.equal(isContentRuntimeResponse(request, invalid), false, `${request.type} malformed response`);
  }
  assert.equal(isContentRuntimeResponse({ type: "OPEN_SETTINGS" }, { ok: false, error: "No receiver" }), true);
  assert.equal(isContentRuntimeResponse({ type: "OPEN_SETTINGS" }, { ok: false, error: 7 }), false);
  assert.equal(isContentRuntimeResponse({ type: "LIST_RECENT_NOTES" }, {
    ok: true,
    drafts: [],
    notes: [{ id: "note", source: "unknown", title: "Note", preview: "", destinationName: "Inbox", status: "delivered", updatedAt: 1, remoteUrl: "", editable: true }],
    notionPages: [],
    notionError: ""
  }), false);
});

test("runtime message guards reject malformed and unknown requests before dispatch", () => {
  assert.equal(isRuntimeRequest(null), false);
  assert.equal(isRuntimeRequest({ type: "NOT_A_MESSAGE" }), false);
  assert.equal(isRuntimeRequest({ type: "UPSERT_DRAFT", draft: null }), false);
  assert.equal(isRuntimeRequest({ type: "EXPORT_CAPTURE_RECOVERY", format: "xml" }), false);
  assert.equal(isRuntimeRequest({ type: "MARK_CAPTURE_DELIVERED", id: "capture", remote: { id: "page" } }), false);
  assert.equal(isRuntimeRequest({ type: "GET_PENDING_COUNT" }), true);
});

test("runtime message guards reject malformed nested payloads", () => {
  assert.equal(isRuntimeRequest({ type: "GET_OR_CREATE_DRAFT", context: { ...context, capturedAt: "now" } }), false);
  assert.equal(isRuntimeRequest({ type: "UPSERT_DRAFT", draft }), true);
  assert.equal(isRuntimeRequest({ type: "UPSERT_DRAFT", draft: { ...draft, doc: { type: "doc", content: [null] } } }), false);
  assert.equal(isRuntimeRequest({ type: "ENQUEUE_CAPTURE", draftId: "draft", capture: { document } }), true);
  assert.equal(isRuntimeRequest({ type: "ENQUEUE_CAPTURE", draftId: "draft", capture: { document: { ...document, doc: { type: 7 } } } }), false);
  assert.equal(isRuntimeRequest({ type: "MARK_CAPTURE_DELIVERED", id: "capture", remote }), true);
  assert.equal(isRuntimeRequest({ type: "MARK_CAPTURE_DELIVERED", id: "capture", remote: { ...remote, blockIds: [7] } }), false);
  assert.equal(isRuntimeRequest({ type: "VALIDATE_DESTINATION", destination: { id: "destination", type: "page", name: "Inbox", url: "https://notion.so/inbox" } }), true);
  assert.equal(isRuntimeRequest({ type: "VALIDATE_DESTINATION", destination: { id: "destination", type: "page", name: 7, url: "https://notion.so/inbox" } }), false);
  assert.equal(isRuntimeRequest({ type: "LOAD_NOTION_PAGE", pageId: "page", title: "Page", url: "https://notion.so/page" }), true);
  assert.equal(isRuntimeRequest({ type: "LOAD_NOTION_PAGE", pageId: 7 }), false);
  assert.equal(isRuntimeRequest({ type: "OPEN_CAPTURE_RESULT", id: "capture", url: "https://notion.so/page" }), true);
  assert.equal(isRuntimeRequest({ type: "OPEN_CAPTURE_RESULT", id: "capture", url: 7 }), false);
});

test("runtime request guards reject every missing required payload", () => {
  const malformed: Array<{ label: string; request: unknown }> = [
    { label: "upsert draft", request: { type: "UPSERT_DRAFT" } },
    { label: "enqueue draft ID", request: { type: "ENQUEUE_CAPTURE", capture: { document } } },
    { label: "enqueue capture", request: { type: "ENQUEUE_CAPTURE", draftId: "draft" } },
    { label: "save draft ID", request: { type: "SAVE_CAPTURE", capture: { document } } },
    { label: "capture status identity", request: { type: "GET_CAPTURE_STATUS" } },
    { label: "discard ID", request: { type: "DISCARD_DRAFT" } },
    { label: "recent-note ID", request: { type: "LOAD_RECENT_NOTE" } },
    { label: "Notion page ID", request: { type: "LOAD_NOTION_PAGE" } },
    { label: "convert ID", request: { type: "CONVERT_EDIT_TO_NEW_DRAFT" } },
    { label: "activate ID", request: { type: "ACTIVATE_DRAFT" } },
    { label: "release session", request: { type: "RELEASE_COMPOSER_SURFACE" } },
    { label: "retry ID", request: { type: "RETRY_CAPTURE" } },
    { label: "retarget ID", request: { type: "RETARGET_CAPTURE" } },
    { label: "mark-delivered ID", request: { type: "MARK_CAPTURE_DELIVERED", remote } },
    { label: "mark-delivered remote", request: { type: "MARK_CAPTURE_DELIVERED", id: "capture" } },
    { label: "delete ID", request: { type: "DELETE_CAPTURE" } },
    { label: "open-result identity", request: { type: "OPEN_CAPTURE_RESULT", id: "" } },
    { label: "recovery format", request: { type: "EXPORT_CAPTURE_RECOVERY" } },
    { label: "fallback draft", request: { type: "OPEN_COMPOSER_FALLBACK" } },
    { label: "destination", request: { type: "VALIDATE_DESTINATION" } }
  ];
  for (const { label, request } of malformed) assert.equal(isRuntimeRequest(request), false, label);

  assert.equal(isRuntimeRequest({ type: "GET_CAPTURE_STATUS", draftId: "draft" }), true);
  assert.equal(isRuntimeRequest({ type: "OPEN_CAPTURE_RESULT", id: "", url: "https://notion.so/page" }), true);
});

test("runtime response guards accept disconnect confirmation and reject incomplete correlated successes", () => {
  assert.equal(isRuntimeResponse(
    { type: "DISCONNECT_NOTION" },
    { ok: false, requiresConfirmation: true, pendingCount: 2 }
  ), true);
  assert.equal(isRuntimeResponse({ type: "DISCONNECT_NOTION" }, { ok: false, requiresConfirmation: true }), false);
  assert.equal(isRuntimeResponse({ type: "DELETE_CAPTURE", id: "capture" }, { ok: true }), false);
  assert.equal(isRuntimeResponse({ type: "DELETE_CAPTURE", id: "capture" }, { ok: true, deleted: true }), true);
  assert.equal(isRuntimeResponse({ type: "DELETE_DELIVERED_HISTORY" }, { ok: true }), false);
  assert.equal(isRuntimeResponse({ type: "DELETE_DELIVERED_HISTORY" }, { ok: true, deleted: 2 }), true);
  assert.equal(isRuntimeResponse({ type: "GET_CAPTURE_STATUS", id: "capture" }, {
    ok: true,
    record: { id: "capture", draftId: "draft", status: "pending", updatedAt: 1, nextAttemptAt: 0, attemptCount: 0, remote: null }
  }), false);
  assert.equal(isRuntimeResponse({ type: "GET_CAPTURE_STATUS", id: "capture" }, { ok: true, record: captureStatus }), true);
  assert.equal(isRuntimeResponse({ type: "LIST_CAPTURE_ACTIVITY" }, {
    ok: true,
    incognito: false,
    drafts: [],
    queued: [{ ...captureRecord, connectionId: undefined }],
    delivered: []
  }), false);
  assert.equal(isRuntimeResponse({ type: "LIST_CAPTURE_ACTIVITY" }, {
    ok: true,
    incognito: false,
    drafts: [],
    queued: [captureRecord],
    delivered: []
  }), true);
});

test("sendRuntimeRequest returns typed disconnect confirmation control responses", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { sendMessage: async () => ({ ok: false, requiresConfirmation: true, pendingCount: 3 }) } }
  });
  try {
    const response = await sendRuntimeRequest({ type: "DISCONNECT_NOTION" });
    assert.equal(response.ok, false);
    assert.equal("requiresConfirmation" in response && response.requiresConfirmation, true);
    assert.equal("pendingCount" in response && response.pendingCount, 3);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("sendRuntimeRequest rejects malformed correlated Chrome responses", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { sendMessage: async () => ({ ok: true }) } }
  });
  try {
    await assert.rejects(sendRuntimeRequest({ type: "DELETE_CAPTURE", id: "capture" }), /malformed response/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("runtime messages reject at the five-second deadline without waiting for the sender", async () => {
  let callback: ((value: unknown) => void) | undefined;
  const pending = new Promise<unknown>((resolve) => { callback = resolve; });
  let scheduledDelay = 0;
  await assert.rejects(
    withRuntimeMessageDeadline(pending, 5_000, {
      setTimer(fn, delay) {
        scheduledDelay = delay;
        fn();
        return setTimeout(() => undefined, 0);
      },
      clearTimer() {}
    }),
    (error) => error instanceof RuntimeMessageTimeoutError && error.code === "runtime_message_timeout"
  );
  assert.equal(scheduledDelay, 5_000);
  callback?.({ ok: true });
});

test("a timed-out enqueue reconciles by draft ID before exposing retry", async () => {
  const calls: RuntimeRequest[] = [];
  const response = await enqueueWithReconciliation({
    draftId: "draft-1",
    message: enqueueMessage,
    async send(message) {
      calls.push(message);
      if (message.type === "ENQUEUE_CAPTURE") throw new RuntimeMessageTimeoutError();
      return { ok: true, record: captureStatus };
    }
  });
  assert.deepEqual(calls.map((message) => message.type), ["ENQUEUE_CAPTURE", "GET_CAPTURE_STATUS"]);
  assert.deepEqual(response, {
    ok: true,
    accepted: true,
    record: captureStatus,
    reconciled: true
  });
});

test("a timed-out enqueue remains retryable only after reconciliation finds no capture", async () => {
  await assert.rejects(
    enqueueWithReconciliation({
      draftId: "draft-1",
      message: enqueueMessage,
      async send(message) {
        if (message.type === "ENQUEUE_CAPTURE") throw new RuntimeMessageTimeoutError();
        return { ok: true, record: null };
      }
    }),
    (error) => error instanceof RuntimeMessageTimeoutError && error.code === "runtime_message_timeout"
  );
});

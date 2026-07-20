import assert from "node:assert/strict";
import test from "node:test";
import { quickSettingsResponse, requiredCaptureRecordResponse, validatedRuntimeResponse } from "../src/background-dispatch.js";
import type { CaptureRecord, QuickSettings } from "../src/contracts.js";

const settings: QuickSettings = {
  destinationName: "Quick Notes",
  includeSource: true,
  aiEnabled: true,
  aiSuggestTitle: true,
  aiExtractTodos: false,
  connected: true,
  configured: true,
  authType: "oauth"
};

const record: CaptureRecord = {
  version: 2,
  id: "capture-1",
  draftId: "draft-1",
  scope: "regular",
  capture: {
    document: { version: 1, title: "Dispatch contract", doc: { type: "doc", content: [] } },
    captureId: "capture-1",
    sources: [],
    includeSource: true
  },
  syncedCapture: null,
  pendingCapture: null,
  operation: "create",
  context: { version: 1, title: "Source", url: "https://example.com/", selection: "", capturedAt: 1 },
  destination: null,
  connectionId: "connection-1",
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
};

test("GET_QUICK_SETTINGS dispatch wraps the public settings in a correlated success response", () => {
  assert.deepEqual(quickSettingsResponse(settings), { ok: true, ...settings });
});

test("capture mutation dispatch returns its required record for every correlated action", async () => {
  for (const type of ["RETRY_CAPTURE", "RETARGET_CAPTURE", "MARK_CAPTURE_DELIVERED"] as const) {
    assert.deepEqual(await requiredCaptureRecordResponse(type, Promise.resolve(record)), { ok: true, record });
  }
});

test("capture mutation dispatch rejects a missing record instead of emitting success with null", async () => {
  for (const type of ["RETRY_CAPTURE", "RETARGET_CAPTURE", "MARK_CAPTURE_DELIVERED"] as const) {
    await assert.rejects(
      requiredCaptureRecordResponse(type, Promise.resolve(null)),
      new RegExp(`${type} did not return a capture record`)
    );
  }
});

test("the shared dispatcher boundary rejects responses that violate their request-specific contract", () => {
  assert.throws(
    () => validatedRuntimeResponse({ type: "GET_QUICK_SETTINGS" }, settings),
    /malformed response for GET_QUICK_SETTINGS/
  );
  for (const type of ["RETRY_CAPTURE", "RETARGET_CAPTURE"] as const) {
    assert.throws(
      () => validatedRuntimeResponse({ type, id: "capture-1" }, { ok: true, record: null }),
      new RegExp(`malformed response for ${type}`)
    );
  }
  assert.throws(
    () => validatedRuntimeResponse(
      { type: "MARK_CAPTURE_DELIVERED", id: "capture-1", remote: { kind: "page", id: "remote-1", pageId: "remote-1", url: "https://www.notion.so/remote-1", blockIds: [], fingerprint: "fingerprint" } },
      { ok: true, record: null }
    ),
    /malformed response for MARK_CAPTURE_DELIVERED/
  );
});

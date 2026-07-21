import assert from "node:assert/strict";
import test from "node:test";
import { createUnavailableNotice } from "../src/unavailable-notice.js";

test("shows a native unavailable notification with a stable tab ID", async () => {
  const calls: unknown[] = [];
  const show = createUnavailableNotice({
    async create(id, options) { calls.push({ id, options }); return id; }
  } as Pick<typeof chrome.notifications, "create">);

  await show(17, "Quick Note can only open on regular web pages, not browser pages or PDFs.");

  assert.deepEqual(calls, [{
    id: "notion-quick-note-unavailable-17",
    options: {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Quick Note unavailable",
      message: "Quick Note couldn't open on this page. Try again or use another page."
    }
  }]);
});

test("never includes caller-provided page details in a native notification", async () => {
  const calls: unknown[] = [];
  const show = createUnavailableNotice({
    async create(id, options) { calls.push({ id, options }); return id; }
  } as Pick<typeof chrome.notifications, "create">);
  const unsafeDetail = "Cannot inject into https://example.test/private?token=super-secret; selection: personal note; password=hunter2";

  await show(17, unsafeDetail);

  assert.deepEqual(calls, [{
    id: "notion-quick-note-unavailable-17",
    options: {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Quick Note unavailable",
      message: "Quick Note couldn't open on this page. Try again or use another page."
    }
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /example\.test|super-secret|personal note|hunter2/);
});

test("resolves when the native unavailable notification is rejected", async () => {
  const show = createUnavailableNotice({
    async create() { throw new Error("notifications unavailable"); }
  } as Pick<typeof chrome.notifications, "create">);

  await show(17, "Quick Note can only open on regular web pages, not browser pages or PDFs.");
});

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = new URL("../fixtures/media-page.html", import.meta.url).href;
const contentScript = path.resolve(here, "../../dist/content.js");

test.beforeEach(async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.addScriptTag({ path: contentScript });
});

async function openQuickNote(page, overrides) {
  await page.evaluate((pageOverrides) => window.openQuickNote(pageOverrides), overrides);
  await expect(page.locator("#notion-quick-note-root[open] .ProseMirror")).toBeFocused();
}

async function mediaEvents(page) {
  return page.evaluate(() => window.mediaEvents);
}

test("typing and player hotkeys stay inside Quick Note", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.pressSequentially("a b");
  await expect(editor).toHaveText("a b");

  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "j", "k", "l", "f", "m"]) {
    await editor.press(key);
  }
  const title = page.locator("#notion-quick-note-root .page-title");
  await title.focus();
  await title.press("Space");
  const more = page.locator("#notion-quick-note-root .more");
  await more.focus();
  await more.press("m");
  expect(await mediaEvents(page)).toEqual([]);
});

test("editing, composition, Tab trapping, Escape, and save shortcuts still work", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("ac");
  await editor.press("ArrowLeft");
  await editor.press("b");
  await expect(editor).toHaveText("abc");

  await editor.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      composed: true,
      isComposing: true
    }));
  });
  await expect(page.locator("#notion-quick-note-root")).toHaveAttribute("open", "");

  await editor.focus();
  await editor.press("Tab");
  await expect(page.locator("#notion-quick-note-root .more")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editor).toBeFocused();

  await editor.focus();
  await editor.press("Control+Shift+Enter");
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(true);

  await editor.press("Escape");
  await expect(page.locator("#notion-quick-note-root[open]")).toHaveCount(0);
});

test("focus is immediate and delayed draft hydration cannot overwrite early typing", async ({ page }) => {
  await page.evaluate(() => {
    window.holdDraft = true;
    window.savedSession[`draft:${location.href}`] = {
      version: 1,
      title: "Old title",
      includeSource: true,
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old draft" }] }] }
    };
    window.openQuickNote();
  });

  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await expect(editor).toBeFocused();
  await editor.pressSequentially("new");
  await page.evaluate(() => window.releaseDraft());
  await expect(editor).toHaveText("new");
});

test("closing a title-only composer does not retain a local draft", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".page-title").fill("A title without body content");
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "UPSERT_DRAFT"))).toBe(true);
  await root.locator(".close").click();
  await expect(root).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.savedSession[`draft:${location.href}`] === undefined)).toBe(true);
});

test("Recent stashes the current draft, loads a saved note, and exposes attached sources", async ({ page }) => {
  await page.evaluate(() => {
    window.recentNotes = [{
      id: "capture-recent",
      title: "Recently saved",
      preview: "A compact preview of the saved note body",
      destinationName: "Test Inbox",
      status: "delivered",
      updatedAt: Date.now(),
      remoteUrl: "https://notion.so/recent"
    }];
    window.remoteDraft = {
      version: 2,
      id: "edit-draft",
      tabId: 1,
      sessionId: "session-test",
      revision: 1,
      mode: "edit",
      targetRecordId: "capture-recent",
      returnDraftId: "draft-test",
      title: "Recently saved",
      sources: [
        { title: "First source", url: "https://first.example/article" },
        { title: "Second source", url: "https://second.example/video" }
      ],
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Live Notion content" }] }] }
    };
  });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ProseMirror").fill("Unsaved local thought");
  await root.locator(".recent").click();
  await expect(root.locator(".recent-edit")).toContainText("Recently saved");
  await expect(root.locator(".recent-preview")).toHaveText("A compact preview of the saved note body");
  await root.locator(".recent-edit").click();
  await expect(root.locator(".page-title")).toHaveValue("Recently saved");
  await expect(root.locator(".ProseMirror")).toHaveText("Live Notion content");
  await expect(root.locator(".edit-banner")).toContainText("draft is stashed");

  await root.locator(".more").click();
  await expect(root.locator(".source-count")).toHaveText("2 attached");
  await root.locator(".manage-sources").click();
  await expect(root.locator(".source-row")).toHaveCount(2);
  await expect(root.locator(".source-row").first()).toContainText("Primary");
  await root.locator(".source-row").nth(1).locator(".source-remove").click();
  await expect(root.locator(".source-row")).toHaveCount(1);

  const messages = await page.evaluate(() => window.runtimeMessages);
  expect(messages.some((message) => message.type === "UPSERT_DRAFT" && message.draft.doc.content[0]?.content?.[0]?.text === "Unsaved local thought")).toBe(true);
  expect(messages.some((message) => message.type === "LOAD_RECENT_NOTE" && message.id === "capture-recent")).toBe(true);
});

test("closing restores page focus and media shortcuts immediately", async ({ page }) => {
  const player = page.locator("#player-focus");
  await player.focus();
  await openQuickNote(page);
  await page.keyboard.press("Escape");
  await expect(player).toBeFocused();

  await page.keyboard.press("Space");
  expect(await mediaEvents(page)).toEqual([
    { type: "keydown", key: " " },
    { type: "keyup", key: " " }
  ]);
});

test("Quick Note remains topmost when opened before or after fullscreen", async ({ page }) => {
  await page.locator("#enter-fullscreen").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await openQuickNote(page);
  await expect.poll(() => page.evaluate(() => {
    const dialog = document.querySelector("#notion-quick-note-root");
    const rect = dialog.getBoundingClientRect();
    return dialog.open && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === dialog;
  })).toBe(true);

  // Browsers reserve Escape while native fullscreen is active, so close through
  // the visible control here; keyboard close is covered in the test above.
  await page.locator("#notion-quick-note-root[open] .close").click();
  await page.evaluate(() => document.exitFullscreen());
  await openQuickNote(page);
  await page.evaluate(() => { window.fullscreenOnNextClick = true; });
  await page.locator("#notion-quick-note-root[open] .more").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.locator("#notion-quick-note-root[open]")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const dialog = document.querySelector("#notion-quick-note-root[open]");
    const surface = dialog?.querySelector("div");
    return Boolean(dialog?.contains(document.activeElement) && surface?.shadowRoot?.activeElement);
  })).toBe(true);
});

test("rapid close and reopen cannot remove the newest popup", async ({ page }) => {
  await openQuickNote(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.openQuickNote());
  await page.waitForTimeout(220);

  await expect(page.locator("#notion-quick-note-root")).toHaveCount(1);
  await expect(page.locator("#notion-quick-note-root")).toHaveAttribute("open", "");
  await expect(page.locator("#notion-quick-note-root .ProseMirror")).toBeFocused();
});

test("reinjection disposes the stale runtime and restores the last autosaved draft", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Survives extension reload");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Survives extension reload");

  await page.evaluate(() => {
    const orphan = document.createElement("div");
    orphan.id = "notion-quick-note-root";
    document.body.append(orphan);
  });
  await page.addScriptTag({ path: contentScript });
  expect(await page.evaluate(() => window.activeRuntimeListeners())).toBe(1);
  await expect(page.locator("[data-notion-quick-note-owned='true']")).toHaveCount(0);
  await expect(page.locator("#notion-quick-note-root")).toHaveCount(1);

  await page.evaluate(() => window.openQuickNote());
  const restored = page.locator("[data-notion-quick-note-owned='true'][open]");
  await expect(restored.locator(".ProseMirror")).toBeFocused();
  await expect(restored.locator(".ProseMirror")).toHaveText("Survives extension reload");
  await expect(restored).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test("routine autosaving stays quiet and only surfaces unusually slow local writes", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  const status = page.locator("#notion-quick-note-root .status");

  await editor.fill("Quiet local backup");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Quiet local backup");
  await expect(status).toHaveText("");

  await page.evaluate(() => { window.holdDraftSave = true; });
  await editor.fill("A slower local backup");
  await expect(status).toHaveText("Saving locally…", { timeout: 1_500 });
  await page.evaluate(() => window.releaseDraftSave());
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("A slower local backup");
  await expect(status).toHaveText("");
});

test("rapid edits are coalesced through one revision-ordered autosave writer", async ({ page }) => {
  await page.evaluate(() => { window.manualDraftSaves = true; });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");

  await editor.fill("First revision");
  await expect.poll(() => page.evaluate(() => window.draftWrites.length)).toBe(1);
  await editor.fill("Intermediate revision");
  await editor.fill("Latest revision");

  await expect.poll(() => page.evaluate(() => ({
    writes: window.draftWrites.length,
    active: window.activeDraftWrites,
    maximum: window.maxConcurrentDraftWrites
  }))).toEqual({ writes: 1, active: 1, maximum: 1 });

  await page.evaluate(() => window.releaseNextDraftSave());
  await expect.poll(() => page.evaluate(() => window.draftWrites.length)).toBe(2);
  const followUp = await page.evaluate(() => window.draftWrites[1]);
  expect(followUp.expectedRevision).toBe(2);
  expect(followUp.draft.doc.content[0].content[0].text).toBe("Latest revision");
  expect(await page.evaluate(() => window.maxConcurrentDraftWrites)).toBe(1);

  await page.evaluate(() => window.releaseNextDraftSave());
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Latest revision");
  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("");
});

test("Save waits for the single-flight autosave drain and sends its latest snapshot", async ({ page }) => {
  await page.evaluate(() => { window.manualDraftSaves = true; });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");

  await editor.fill("Initial save payload");
  await expect.poll(() => page.evaluate(() => window.draftWrites.length)).toBe(1);
  await editor.fill("Final save payload");
  await editor.press("Control+Shift+Enter");

  await page.evaluate(() => window.releaseNextDraftSave());
  await expect.poll(() => page.evaluate(() => window.draftWrites.length)).toBe(2);
  expect(await page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(false);

  await page.evaluate(() => window.releaseNextDraftSave());
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(true);
  const capture = await page.evaluate(() => window.runtimeMessages.find((message) => message.type === "ENQUEUE_CAPTURE"));
  expect(capture.capture.document.doc.content[0].content[0].text).toBe("Final save payload");
  expect(await page.evaluate(() => window.maxConcurrentDraftWrites)).toBe(1);
});

test("invalidated runtime stops autosaving without an unhandled rejection", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await page.evaluate(() => {
    window.runtimeError = new Error("Extension context invalidated.");
  });
  await editor.fill("Still available to copy");

  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Quick Note was updated. Reopen it to continue.");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.locator("#notion-quick-note-root .toast")).toHaveText("Quick Note was updated. Reopen it to continue.");
  expect(pageErrors).toEqual([]);
});

test("storage-context failures use the same copy-only recovery state", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  await page.evaluate(() => {
    window.runtimeError = new Error("Access to storage is not allowed from this context.");
  });
  await page.locator("#notion-quick-note-root .page-title").fill("Trigger storage failure");

  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Quick Note was updated. Reopen it to continue.");
  await expect(page.locator("#notion-quick-note-root .page-title")).toHaveAttribute("readonly", "");
  expect(pageErrors).toEqual([]);
});

test("ProseMirror receives the required white-space style before stylesheet loading", async ({ page }) => {
  const warnings = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await expect(editor).toHaveCSS("white-space", "pre-wrap");
  expect(await editor.evaluate((element) => element.style.whiteSpace)).toBe("pre-wrap");
  expect(warnings.filter((message) => /white-space/i.test(message))).toEqual([]);
});

test("save failure retains the draft and restores the save button", async ({ page }) => {
  await page.evaluate(() => {
    window.saveResponse = { ok: false, error: "Notion is unavailable" };
  });
  await openQuickNote(page);

  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Keep this draft");
  await editor.press("Control+Shift+Enter");
  const save = page.locator("#notion-quick-note-root .save");
  await expect(save).toBeEnabled();
  await expect(save).toContainText("Save");
  await expect(page.locator("#notion-quick-note-root .toast")).toHaveText("Notion is unavailable");
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.savedSession[`draft:${location.href}`]))).toContain("Keep this draft");
});

test("confirmed delivery keeps the composer open until Notion reports delivered", async ({ page }) => {
  await page.evaluate(() => {
    window.captureStatus = { id: "capture-test", status: "sending", lastError: null };
  });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Wait for remote confirmation");
  await editor.press("Control+Shift+Enter");
  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Sending to Notion…");
  await expect(page.locator("#notion-quick-note-root .close")).toBeDisabled();

  await page.evaluate(() => {
    window.captureStatus = { id: "capture-test", status: "delivered", lastError: null };
  });
  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Saved to Notion");
  await expect(page.locator("#notion-quick-note-root .toast")).toHaveText("Saved to Notion");
});

test("slow delivery offers Close safely after ten seconds and retains the local queue", async ({ page }) => {
  test.setTimeout(20_000);
  await page.evaluate(() => {
    window.captureStatus = { id: "capture-test", status: "sending", lastError: null };
  });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Safe even when Notion is slow");
  await editor.press("Control+Shift+Enter");
  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Safe locally—Notion is taking longer", { timeout: 12_500 });
  const closeSafely = page.locator("#notion-quick-note-root .save");
  await expect(closeSafely).toHaveText("Close safely");
  await closeSafely.click();
  await expect(page.locator("#notion-quick-note-root[open]")).toHaveCount(0);
  expect(await page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(true);
});

test("blocked delivery states expose reconnect and destination-permission actions", async ({ page }) => {
  await page.evaluate(() => {
    window.captureStatus = { id: "capture-test", status: "blocked_auth", lastError: { kind: "auth" } };
  });
  await openQuickNote(page);
  await page.locator("#notion-quick-note-root .ProseMirror").fill("Reconnect action");
  await page.locator("#notion-quick-note-root .save").click();
  await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Saved locally—reconnect Notion to send");
  await expect(page.locator("#notion-quick-note-root .save")).toHaveText("Reconnect");
  await page.locator("#notion-quick-note-root .save").click();
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "OPEN_SETTINGS"))).toBe(true);
  await page.locator("#notion-quick-note-root .safe-close").click();
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    window.currentDraft = null;
    window.captureStatus = { id: "capture-two", status: "blocked_destination", lastError: { kind: "destination" } };
  });
  await openQuickNote(page);
  await page.locator("#notion-quick-note-root .ProseMirror").fill("Permission action");
  await page.locator("#notion-quick-note-root .save").click();
  await expect(page.locator("#notion-quick-note-root .status")).toContainText("allow Insert Content or reshare");
  await expect(page.locator("#notion-quick-note-root .save")).toHaveText("Check access");
});

test("rate limits and uncertain manual delivery use accurate local-safe language", async ({ page }) => {
  await page.evaluate(() => {
    window.captureStatus = { id: "capture-test", status: "pending", lastError: { kind: "rate_limited" } };
  });
  await openQuickNote(page);
  await page.locator("#notion-quick-note-root .ProseMirror").fill("Rate limited capture");
  await page.locator("#notion-quick-note-root .save").click();
  await expect(page.locator("#notion-quick-note-root .status")).toContainText("Notion rate limited delivery");
  await expect(page.locator("#notion-quick-note-root .save")).toHaveText("Close safely");
  await page.locator("#notion-quick-note-root .save").click();
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    window.currentDraft = null;
    window.captureStatus = { id: "capture-uncertain", status: "uncertain", lastError: { kind: "ambiguous_manual" } };
  });
  await openQuickNote(page);
  await page.locator("#notion-quick-note-root .ProseMirror").fill("Possible manual duplicate");
  await page.locator("#notion-quick-note-root .save").click();
  await expect(page.locator("#notion-quick-note-root .status")).toContainText("may have received it; review before retrying");
  await expect(page.locator("#notion-quick-note-root .save")).toHaveText("Review");
});

test("a runtime-message hang reconciles by draft and preserves content before retry", async ({ page }) => {
  test.setTimeout(12_000);
  await page.evaluate(() => {
    window.saveDelay = 10_000;
    window.captureStatus = null;
  });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Still here after a message hang");
  await editor.press("Control+Shift+Enter");
  await expect(page.locator("#notion-quick-note-root .toast")).toContainText("did not acknowledge delivery", { timeout: 7_000 });
  await expect(page.locator("#notion-quick-note-root .save")).toBeEnabled();
  await expect(editor).toHaveText("Still here after a message hang");
  const messages = await page.evaluate(() => window.runtimeMessages.map((message) => message.type));
  expect(messages).toContain("GET_CAPTURE_STATUS");
});

test("Markdown rules, slash commands, and the selection toolbar create native editor nodes", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");

  await editor.pressSequentially("# Heading ");
  await expect(editor.locator("h1")).toHaveText("Heading");

  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("/");
  const slash = page.locator("#notion-quick-note-root .slash-menu");
  await expect(slash).toBeVisible();
  await expect(slash.locator("button").first()).toHaveAttribute("aria-selected", "true");
  await editor.press("ArrowDown");
  await editor.press("Enter");
  await editor.pressSequentially("Section");
  await expect(editor.locator("h1").last()).toHaveText("Section");

  await editor.locator("h1").last().selectText();
  await expect(page.locator("#notion-quick-note-root .bubble")).toBeVisible();
  await page.locator("#notion-quick-note-root .bubble [data-command=bold]").click();
  await expect(editor.locator("strong")).toHaveText("Section");
});

test("slash commands stay inside the composer near its left and bottom edges", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill(Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"));
  await editor.press("End");
  await editor.press("Enter");
  await editor.press("/");

  const slash = page.locator("#notion-quick-note-root .slash-menu");
  await expect(slash).toBeVisible();
  await expect(slash).toHaveAttribute("data-placement", "above");

  const bounds = await slash.evaluate((menu) => {
    const menuRect = menu.getBoundingClientRect();
    const sheetRect = menu.closest(".sheet").getBoundingClientRect();
    return {
      menu: { left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom },
      sheet: { left: sheetRect.left, top: sheetRect.top, right: sheetRect.right, bottom: sheetRect.bottom }
    };
  });
  expect(bounds.menu.left).toBeGreaterThanOrEqual(bounds.sheet.left);
  expect(bounds.menu.top).toBeGreaterThanOrEqual(bounds.sheet.top);
  expect(bounds.menu.right).toBeLessThanOrEqual(bounds.sheet.right);
  expect(bounds.menu.bottom).toBeLessThanOrEqual(bounds.sheet.bottom);
});

test("Control+Enter checks a to-do without saving; Control+Shift+Enter saves", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.pressSequentially("[] Task ");
  await expect(editor.locator('ul[data-type="taskList"]')).toBeVisible();

  await editor.press("Control+Enter");
  await expect(editor.locator('input[type="checkbox"]')).toBeChecked();
  expect(await page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(false);

  await editor.press("Control+Shift+Enter");
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(true);
});

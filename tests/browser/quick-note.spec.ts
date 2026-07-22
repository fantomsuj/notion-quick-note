import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CaptureDraft } from "../../src/contracts.js";

interface LanguageModelCreateOptions {
  monitor?: (monitor: { addEventListener(type: string, listener: EventListener): void }) => void;
}

interface LanguageModelPromptOptions {
  signal: AbortSignal;
  [key: string]: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = new URL("../fixtures/media-page.html", import.meta.url).href;
const contentScript = path.resolve(here, "../../dist/content.js");

test.beforeEach(async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.addScriptTag({ path: contentScript });
});

async function openQuickNote(page: Page, overrides: Parameters<Window["openQuickNote"]>[0] = {}) {
  await page.evaluate((pageOverrides) => window.openQuickNote(pageOverrides), overrides);
  await expect(page.locator("#notion-quick-note-root .ProseMirror")).toBeFocused();
}

test("composer leaves the page clickable while containing its focused keyboard events", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await expect.poll(() => root.evaluate((host) => ({
    tagName: host.tagName,
    role: host.getAttribute("role"),
    ariaModal: host.getAttribute("aria-modal"),
    open: host.matches(":popover-open"),
    focused: host.shadowRoot?.activeElement?.classList.contains("ProseMirror") === true
  }))).toEqual({ tagName: "DIV", role: "dialog", ariaModal: null, open: true, focused: true });

  const pageButton = page.locator("#player-focus");
  const box = await pageButton.boundingBox();
  if (!box) throw new Error("Expected the underlying page button.");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.underlyingPointerEvents)).toBe(1);
  await expect(pageButton).toBeFocused();
  await root.locator(".ProseMirror").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => window.mediaEvents)).toEqual([]);
  await page.locator("#underlying-input").focus();
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => window.mediaEvents)).toEqual([{ type: "keydown", key: "k" }, { type: "keyup", key: "k" }]);
});

test.describe("on a touch page", () => {
  test.use({ hasTouch: true });

  test("the underlying page receives touch interaction while the composer is open", async ({ page }) => {
    await openQuickNote(page);
    const input = page.locator("#underlying-input");
    const box = await input.boundingBox();
    if (!box) throw new Error("Expected the underlying page input.");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => window.underlyingTouchEvents)).toBe(1);
    await expect.poll(() => page.locator("#notion-quick-note-root").evaluate((host) => host.matches(":popover-open"))).toBe(true);
  });
});

test("composer verifies the bundled NotionInter face before it becomes visible", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await expect(root).toHaveAttribute("data-font-status", "loaded");
  await expect.poll(() => page.evaluate(() => document.fonts.check('15px "NotionInter"'))).toBe(true);
  await expect(root).toHaveCSS("font-family", /NotionInter/);
  await expect(root.locator(".sheet")).toHaveCSS("opacity", "1");
});

async function composerBounds(page: Page) {
  return page.locator("#notion-quick-note-root").evaluate((host) => {
    const { left, top, width, height, right, bottom } = host.getBoundingClientRect();
    return { left, top, width, height, right, bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
}

test("dragging moves the composer while keeping it inside the viewport margin", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const dragRegion = root.locator("[data-composer-drag-region]");
  const before = await composerBounds(page);
  const dragBox = await dragRegion.boundingBox();
  if (!dragBox) throw new Error("Expected the composer drag region.");
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x - 120, dragBox.y - 90, { steps: 5 });
  await page.mouse.up();
  const moved = await composerBounds(page);
  expect(moved.left).toBeLessThan(before.left);
  expect(moved.top).toBeLessThan(before.top);

  const movedDragBox = await dragRegion.boundingBox();
  if (!movedDragBox) throw new Error("Expected the moved composer drag region.");
  await page.mouse.move(movedDragBox.x + 10, movedDragBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(-1000, -1000, { steps: 4 });
  await page.mouse.up();
  const clamped = await composerBounds(page);
  expect(clamped.left).toBeGreaterThanOrEqual(16);
  expect(clamped.top).toBeGreaterThanOrEqual(16);
  expect(clamped.right).toBeLessThanOrEqual(clamped.viewportWidth - 16);
  expect(clamped.bottom).toBeLessThanOrEqual(clamped.viewportHeight - 16);
});

test("resizing persists bounds and safely clamps them after the viewport shrinks", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const handle = root.locator("[data-composer-resize-handle]");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("Expected the composer resize handle.");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 1000, handleBox.y + 1000, { steps: 6 });
  await page.mouse.up();
  const expanded = await composerBounds(page);
  expect(expanded.width).toBeLessThanOrEqual(720);
  expect(expanded.height).toBeLessThanOrEqual(720);

  const expandedHandle = await handle.boundingBox();
  if (!expandedHandle) throw new Error("Expected the resized composer handle.");
  await page.mouse.move(expandedHandle.x + 8, expandedHandle.y + 8);
  await page.mouse.down();
  await page.mouse.move(expandedHandle.x - 1000, expandedHandle.y - 1000, { steps: 6 });
  await page.mouse.up();
  const minimized = await composerBounds(page);
  expect(minimized.width).toBeGreaterThanOrEqual(320);
  expect(minimized.height).toBeGreaterThanOrEqual(260);

  await root.locator(".close").click();
  await expect(root).toHaveCount(0);
  await openQuickNote(page);
  await expect.poll(() => composerBounds(page)).toMatchObject({ width: minimized.width, height: minimized.height });

  await page.setViewportSize({ width: 420, height: 340 });
  await expect.poll(() => composerBounds(page)).toMatchObject({ left: 84, top: 16, width: 320, height: 260 });
  const stored = await page.evaluate(() => chrome.storage.local.get("quickNoteComposerBounds"));
  expect(stored.quickNoteComposerBounds).toEqual({ left: 84, top: 16, width: 320, height: 260 });
});

async function rememberEditorNode(page: Page) {
  await page.locator("#notion-quick-note-root .ProseMirror").evaluate((node) => {
    window.rememberedQuickNoteEditor = node;
  });
}

async function expectRememberedEditorNode(page: Page) {
  await expect.poll(() => page.locator("#notion-quick-note-root .ProseMirror").evaluate((node) => (
    node === window.rememberedQuickNoteEditor
  ))).toBe(true);
}

async function selectedEditorText(page: Page): Promise<string> {
  return page.locator("#notion-quick-note-root .ProseMirror").evaluate((node) => {
    const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
    return (root.getSelection?.() ?? document.getSelection())?.toString() || "";
  });
}

async function corruptRequiredTemplateElement(page: Page, selector: string): Promise<void> {
  await page.evaluate((requiredSelector) => {
    const descriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "innerHTML");
    if (!descriptor?.get || !descriptor.set) throw new Error("ShadowRoot.innerHTML is unavailable.");
    Object.defineProperty(ShadowRoot.prototype, "innerHTML", {
      configurable: true,
      get(this: ShadowRoot) { return descriptor.get?.call(this) as string; },
      set(this: ShadowRoot, value: string) {
        descriptor.set?.call(this, value);
        const original = this.querySelector(requiredSelector);
        if (!original) throw new Error(`Test could not find ${requiredSelector}.`);
        const invalid = document.createElement("div");
        for (const attribute of original.attributes) invalid.setAttribute(attribute.name, attribute.value);
        invalid.innerHTML = original.innerHTML;
        original.replaceWith(invalid);
      }
    });
  }, selector);
}

test("composer reveals when its stylesheet finishes during host attachment", async ({ page }) => {
  await page.evaluate(() => {
    const append = Element.prototype.append;
    Element.prototype.append = function (...nodes: (Node | string)[]) {
      append.call(this, ...nodes);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || node.dataset.notionQuickNoteOwned !== "true") continue;
        const stylesheet = node.shadowRoot?.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
        if (!stylesheet) continue;
        stylesheet.dispatchEvent(new Event("load"));
        const addEventListener = stylesheet.addEventListener.bind(stylesheet);
        stylesheet.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type !== "load") addEventListener(type, listener, options);
        }) as typeof stylesheet.addEventListener;
      }
    };
  });

  await page.evaluate(() => window.openQuickNote());
  await expect.poll(() => page.locator("#notion-quick-note-root").evaluate((host) => {
    const sheet = host.shadowRoot?.querySelector<HTMLElement>(".sheet");
    return sheet ? { visible: sheet.classList.contains("visible"), opacity: getComputedStyle(sheet).opacity } : null;
  })).toEqual({ visible: true, opacity: "1" });
});

function draftFixture(id: string, body: string): CaptureDraft {
  return {
    version: 2,
    id,
    tabId: 1,
    context: {
      version: 1,
      title: `${id} source`,
      url: `https://${id}.example/article`,
      selection: "",
      capturedAt: 1
    },
    mode: "new",
    targetRecordId: "",
    sources: [{ title: `${id} source`, url: `https://${id}.example/article`, selection: "", capturedAt: 1 }],
    dismissedSourceUrls: [],
    revision: 1,
    sessionId: `session-${id}`,
    returnDraftId: "",
    title: "",
    includeSource: true,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
    remote: null,
    baseFingerprint: "",
    createdAt: 1,
    updatedAt: 1
  };
}

async function mediaEvents(page: Page): Promise<Array<{ type: string; key: string }>> {
  return page.evaluate(() => window.mediaEvents);
}

test("composer template validation rejects a required singleton with the wrong concrete class", async ({ page }) => {
  await corruptRequiredTemplateElement(page, ".page-title");

  const failure = await page.evaluate(async () => {
    try {
      await window.openQuickNote();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failure).toContain(".page-title");
  await expect(page.locator("#notion-quick-note-root")).toHaveCount(0);
});

test("composer template validation rejects a required list member with the wrong concrete class", async ({ page }) => {
  await corruptRequiredTemplateElement(page, ".format-menu [data-block]");

  const failure = await page.evaluate(async () => {
    try {
      await window.openQuickNote();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failure).toContain(".format-menu [data-block]");
  await expect(page.locator("#notion-quick-note-root")).toHaveCount(0);
});

test("composer template validation eagerly checks every mapped singleton", async ({ page }) => {
  await corruptRequiredTemplateElement(page, ".recent-search");

  const failure = await page.evaluate(async () => {
    try {
      await window.openQuickNote();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failure).toContain(".recent-search");
  await expect(page.locator("#notion-quick-note-root")).toHaveCount(0);
});

test("composer template validation eagerly checks every mapped list", async ({ page }) => {
  await corruptRequiredTemplateElement(page, ".color-swatch");

  const failure = await page.evaluate(async () => {
    try {
      await window.openQuickNote();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failure).toContain(".color-swatch");
  await expect(page.locator("#notion-quick-note-root")).toHaveCount(0);
});

async function installLanguageModel(
  page: Page,
  options: { availability?: string; mode?: "success" | "error" | "empty-tasks" | "pending" } = {}
): Promise<void> {
  await page.evaluate(({ availability, mode }) => {
    window.aiPrompts = [];
    window.aiDestroyed = 0;
    Object.defineProperty(window, "LanguageModel", {
      configurable: true,
      value: {
        async availability() { return availability; },
        async create(options: LanguageModelCreateOptions) {
          options.monitor?.({ addEventListener() {} });
          return {
            async prompt(prompt: string, promptOptions: LanguageModelPromptOptions) {
              window.aiPrompts.push({ prompt, promptOptions });
              if (mode === "error") throw new Error("Model stopped unexpectedly");
              if (mode === "empty-tasks") return JSON.stringify({ tasks: [] });
              if (mode === "pending") {
                return new Promise((_resolve, reject) => promptOptions.signal.addEventListener("abort", () => {
                  reject(new DOMException("Cancelled", "AbortError"));
                }, { once: true }));
              }
              return prompt.startsWith("Suggest one short")
                ? JSON.stringify({ title: "Review launch plan" })
                : JSON.stringify({ tasks: ["Email Sam", "Review the draft Friday"] });
            },
            destroy() { window.aiDestroyed += 1; }
          };
        }
      }
    });
  }, { availability: options.availability || "available", mode: options.mode || "success" });
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

test("setup status refreshes while the composer remains open", async ({ page }) => {
  await page.evaluate(() => {
    window.settingsResponse = {
      ...window.settingsResponse,
      connected: false,
      configured: false
    };
  });
  await openQuickNote(page);
  const setup = page.locator("#notion-quick-note-root .setup");
  await expect(setup).toBeVisible();
  await expect(setup.locator("strong")).toHaveText("One minute of setup");

  await page.evaluate(() => window.dispatchRuntimeMessage({
    type: "QUICK_SETTINGS_CHANGED",
    settings: { connected: true, configured: false, destinationName: "Quick Notes" }
  }));
  await expect(setup.locator("strong")).toHaveText("Finish setup");
  await expect(setup).toContainText("Your token is connected");

  await setup.click();
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "OPEN_SETTINGS"))).toBe(true);

  await page.evaluate(() => window.dispatchRuntimeMessage({
    type: "QUICK_SETTINGS_CHANGED",
    settings: { connected: true, configured: true, destinationName: "Quick Notes" }
  }));
  await expect(setup).toBeHidden();
});

test("mounted composer tracks active page context and keeps dismissed pages suppressed", async ({ page }) => {
  await openQuickNote(page, { title: "First page", url: "https://first.example/article", selection: "" });
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".more").click();
  await root.locator(".manage-sources").click();
  await expect(root.locator(".source-row")).toHaveCount(1);

  await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
    page: { version: 1, title: "Second page", url: "https://second.example/path", selection: "", capturedAt: 1 },
    tabId: 2,
    explicit: false
  }));
  await expect(root.locator(".source-row")).toHaveCount(2);
  await expect(root.locator(".source-list")).toContainText("Second page");

  await root.locator(".source-row").filter({ hasText: "First page" }).locator(".source-remove").click();
  await expect(root.locator(".source-list")).not.toContainText("First page");

  await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
    page: { version: 1, title: "First page revisited", url: "https://first.example/article#section", selection: "", capturedAt: 1 },
    tabId: 1,
    explicit: false
  }));
  await expect(root.locator(".source-list")).not.toContainText("First page revisited");

  await root.locator(".add-current-source").click();
  await expect(root.locator(".source-row")).toHaveCount(2);
  await expect(root.locator(".source-list")).toContainText("First page revisited");
});

test("same draft command preserves the mounted composer node and unsaved text", async ({ page }) => {
  await openQuickNote(page);
  const stalePanelDraft = await page.evaluate(() => {
    if (!window.currentDraft) throw new Error("Expected the current draft to be hydrated.");
    return structuredClone(window.currentDraft);
  });
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Unsaved local thought");
  await editor.press("ArrowLeft");
  await rememberEditorNode(page);
  await expect.poll(() => page.evaluate(() => window.currentDraft?.revision || 0)).toBeGreaterThan(stalePanelDraft.revision);

  await page.evaluate((draftJson: string) => {
    const draft = JSON.parse(draftJson) as CaptureDraft;
    return window.__notionQuickNoteOpen?.({
      draft,
      page: draft.context,
      draftId: draft.id,
      tabId: draft.tabId,
      sessionId: draft.sessionId,
      revision: draft.revision
    });
  }, JSON.stringify(stalePanelDraft));

  await expectRememberedEditorNode(page);
  await expect(editor).toHaveText("Unsaved local thought");
  await expect(editor).toBeFocused();
  await editor.fill("Still editable after repeated reveal");
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.currentDraft?.doc || {}))).toContain("Still editable after repeated reveal");
});

test("different draft command updates content in the mounted composer node", async ({ page }) => {
  await openQuickNote(page);
  await page.locator("#notion-quick-note-root .ProseMirror").fill("First draft edits");
  await rememberEditorNode(page);

  await page.evaluate((draftJson: string) => {
    const draft = JSON.parse(draftJson) as CaptureDraft;
    return window.__notionQuickNoteOpen?.({
      draft,
      page: draft.context,
      draftId: draft.id,
      tabId: draft.tabId,
      sessionId: draft.sessionId,
      revision: draft.revision
    });
  }, JSON.stringify(draftFixture("second-draft", "Second draft body")));

  await expectRememberedEditorNode(page);
  await expect(page.locator("#notion-quick-note-root .ProseMirror")).toHaveText("Second draft body");
});

test("activated different draft adopts its new revision and remains writable", async ({ page }) => {
  await openQuickNote(page);
  const loadedDraft = draftFixture("activated-draft", "Loaded before activation");
  await page.evaluate((draftJson: string) => {
    const draft = JSON.parse(draftJson) as CaptureDraft;
    return window.__notionQuickNoteOpen?.({ draft });
  }, JSON.stringify(loadedDraft));

  const activatedDraft = { ...loadedDraft, revision: loadedDraft.revision + 1, sessionId: "activated-session" };
  await page.evaluate((draftJson: string) => {
    const draft = JSON.parse(draftJson) as CaptureDraft;
    window.currentDraft = structuredClone(draft);
    return window.__notionQuickNoteOpen?.({ draft, replaceWithoutPersist: true });
  }, JSON.stringify(activatedDraft));

  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Writable after activation");
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.currentDraft?.doc || {}))).toContain("Writable after activation");
  await expect(page.locator("#notion-quick-note-root .stale-banner")).toBeHidden();
});

test("Activity suspension and resume preserve the mounted composer node and content", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Keep this while viewing Activity");
  await rememberEditorNode(page);
  await root.evaluate((host) => { window.rememberedQuickNoteHost = host; });

  await page.evaluate(() => window.__notionQuickNoteSuspend?.());
  await expect.poll(() => root.evaluate((host) => !host.matches(":popover-open"))).toBe(true);
  await expect.poll(() => root.evaluate((element: HTMLElement) => element.hidden)).toBe(true);
  await page.locator("#player-focus").click();
  await expect(page.locator("#player-focus")).toBeFocused();
  await page.evaluate(() => window.__notionQuickNoteResume?.());

  await expect.poll(() => root.evaluate((host) => host.matches(":popover-open"))).toBe(true);
  await expect.poll(() => root.evaluate((element: HTMLElement) => element.hidden)).toBe(false);
  await expect.poll(() => root.evaluate((host) => host === window.rememberedQuickNoteHost)).toBe(true);
  await expectRememberedEditorNode(page);
  await expect(editor).toHaveText("Keep this while viewing Activity");
});

test("discarding the suspended current draft cancels autosave and disposes its mounted editor", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ProseMirror").fill("Discard this suspended draft");
  await page.evaluate(() => window.__notionQuickNoteSuspend?.());

  const result = await page.evaluate(async () => {
    const draftId = window.currentDraft?.id;
    if (!draftId) throw new Error("Expected a current draft before discard.");
    const messageIndex = window.runtimeMessages.length;
    const prepared = await window.__notionQuickNotePrepareDiscard?.(draftId);
    const response = await window.chrome.runtime.sendMessage({ type: "DISCARD_DRAFT", id: draftId });
    window.__notionQuickNoteFinishDiscard?.(draftId, Boolean(response?.ok && response.discarded));
    return { draftId, messageIndex, prepared, response };
  });

  expect(result.prepared).toBe(true);
  expect(result.response).toMatchObject({ ok: true, discarded: true });
  await expect(root).toHaveCount(0);
  await page.waitForTimeout(300);
  const messagesAfterDiscard = await page.evaluate((messageIndex) => window.runtimeMessages.slice(messageIndex), result.messageIndex);
  expect(messagesAfterDiscard.filter((message) => message.type === "UPSERT_DRAFT" && message.draft?.id === result.draftId)).toEqual([]);
  expect(await page.evaluate(() => window.currentDraft)).toBeNull();
});

test("failed discard restores the mounted composer and autosave without losing the draft", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.evaluate(() => { window.discardResponse = { ok: true, discarded: false }; });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Keep this local draft");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Keep this local draft");

  await root.locator(".more").click();
  await root.locator(".discard-draft").click();

  await expect(root).toHaveCount(1);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(root.locator(".toast")).toHaveText("Couldn’t discard this draft.");
  await editor.fill("Autosave resumed");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Autosave resumed");
  expect(pageErrors).toEqual([]);
});

test("discard runtime rejection reconciles a retained draft and restores autosave", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Retain after rejected discard");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Retain after rejected discard");
  await page.evaluate(() => { window.discardError = new Error("Discard response channel failed"); });

  await root.locator(".more").click();
  await root.locator(".discard-draft").click();

  await expect(root).toHaveCount(1);
  await expect(root.locator(".toast")).toHaveText("Discard response channel failed");
  await editor.fill("Autosave resumed after rejection");
  await expect.poll(() => page.evaluate(() => window.currentDraft?.doc?.content?.[0]?.content?.[0]?.text)).toBe("Autosave resumed after rejection");
  expect(pageErrors).toEqual([]);
});

test("discard runtime rejection preserves the composer when the extension cannot verify deletion", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ProseMirror").fill("Delete before the response is lost");
  await expect.poll(() => page.evaluate(() => Boolean(window.currentDraft))).toBe(true);
  await page.evaluate(() => {
    window.discardError = new Error("Discard response channel failed after deletion");
    window.discardDeletesBeforeError = true;
  });

  await root.locator(".more").click();
  await root.locator(".discard-draft").click();

  await expect(root).toHaveCount(1);
  await expect(root.locator(".toast")).toHaveText("Discard response channel failed after deletion");
  expect(await page.evaluate(() => window.currentDraft)).toBeNull();
  expect(pageErrors).toEqual([]);
});

test("event-launched runtime rejection is surfaced without an unhandled rejection", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openQuickNote(page);
  await page.evaluate(() => { window.runtimeError = new Error("Settings route unavailable"); });

  const root = page.locator("#notion-quick-note-root");
  await root.locator(".more").click();
  await root.locator(".open-settings").click();

  await expect(root.locator(".toast")).toHaveText("Settings route unavailable");
  expect(pageErrors).toEqual([]);
});

test("mounted composer context updates sources without replacing the editor node", async ({ page }) => {
  await openQuickNote(page, { title: "First source", url: "https://first.example/article" });
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Context-safe content");
  await rememberEditorNode(page);

  await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
    page: { version: 1, title: "Second source", url: "https://second.example/article", selection: "", capturedAt: 2 },
    tabId: 2,
    explicit: false
  }));
  await root.locator(".more").click();
  await root.locator(".manage-sources").click();

  await expect(root.locator(".source-list")).toContainText("Second source");
  await expectRememberedEditorNode(page);
  await expect(editor).toHaveText("Context-safe content");
});

test("explicit selection context appends a quote without remounting the composer", async ({ page }) => {
  await openQuickNote(page, { title: "First source", url: "https://first.example/article" });
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Existing thought");
  await rememberEditorNode(page);

  await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
    page: {
      version: 1,
      title: "Quoted source",
      url: "https://quoted.example/article",
      selection: "A selected passage",
      capturedAt: 3
    },
    tabId: 3,
    explicit: true
  }));

  await expectRememberedEditorNode(page);
  await expect(editor).toContainText("Existing thought");
  await expect(root.locator(".ProseMirror blockquote")).toContainText("A selected passage");
});

test("failed different draft switch preserves the mounted draft and restarts autosave", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await page.evaluate(() => { window.runtimeError = new Error("storage unavailable"); });
  await editor.fill("Unsaved draft that must survive");
  await rememberEditorNode(page);

  const error = await page.evaluate(async (draftJson: string) => {
    const draft = JSON.parse(draftJson) as CaptureDraft;
    try {
      await window.__notionQuickNoteOpen?.({
        draft,
        page: draft.context,
        draftId: draft.id,
        tabId: draft.tabId,
        sessionId: draft.sessionId,
        revision: draft.revision
      });
      return "";
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }, JSON.stringify(draftFixture("switch-target", "Replacement content")));

  expect(error).toContain("storage unavailable");
  await expectRememberedEditorNode(page);
  await expect(editor).toHaveText("Unsaved draft that must survive");

  await page.evaluate(() => { window.runtimeError = null; });
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => (
    message.type === "UPSERT_DRAFT"
    && JSON.stringify(message.draft?.doc).includes("Unsaved draft that must survive")
  )))).toBe(true);
});

test("automatic tab context does not alter a draft that is editing an existing note", async ({ page }) => {
  const editDraft: CaptureDraft = {
    ...draftFixture("edit-draft", "Existing body"),
    mode: "edit",
    targetRecordId: "capture-existing",
    title: "Existing note",
    sources: [{ title: "Original source", url: "https://original.example/page", selection: "", capturedAt: 1 }]
  };
  await page.evaluate((draftJson: string) => {
    window.currentDraft = JSON.parse(draftJson) as CaptureDraft;
  }, JSON.stringify(editDraft));
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".more").click();
  await root.locator(".manage-sources").click();

  await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
    page: { version: 1, title: "Unrelated tab", url: "https://unrelated.example/path", selection: "", capturedAt: 1 },
    tabId: 2,
    explicit: false
  }));
  await expect(root.locator(".source-row")).toHaveCount(1);
  await expect(root.locator(".source-list")).not.toContainText("Unrelated tab");
});

test("on-device AI keeps title and to-dos in editable previews until explicitly applied", async ({ page }) => {
  await installLanguageModel(page);
  await openQuickNote(page, { title: "Launch source", url: "https://example.com/launch", selection: "" });
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("I should email Sam and review the draft Friday.");

  await root.locator(".ai").evaluate((button) => button.addEventListener("click", (event) => {
    window.aiClickWasTrusted = event.isTrusted;
  }, { once: true }));
  await root.locator(".ai").click();
  expect(await page.evaluate(() => window.aiClickWasTrusted)).toBe(true);
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="title"]').click();
  await expect(root.locator(".ai-preview-title")).toHaveValue("Review launch plan");
  await expect(root.locator(".page-title")).toHaveValue("");
  await root.locator(".ai-preview-title").fill("Launch follow-ups");
  await root.locator(".ai-apply-title").click();
  await expect(root.locator(".page-title")).toHaveValue("Launch follow-ups");

  await root.locator(".ai").click();
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="todos"]').click();
  await expect(root.locator(".ai-preview-todos")).toHaveValue("Email Sam\nReview the draft Friday");
  await expect(root.locator('.ProseMirror ul[data-type="taskList"] > li')).toHaveCount(0);
  await root.locator(".ai-preview-todos").fill("Email Sam\nReview launch draft next Friday");
  await root.locator(".ai-insert-todos").click();
  await expect(root.locator('.ProseMirror ul[data-type="taskList"] > li')).toHaveCount(2);
  await expect(root.locator('.ProseMirror ul[data-type="taskList"] > li').nth(1)).toContainText("Review launch draft next Friday");
  await expect(editor).toContainText("I should email Sam and review the draft Friday.");
  expect(await page.evaluate(() => window.aiPrompts.length)).toBe(2);
});

test("AI preferences hide individual actions or the complete sparkle menu", async ({ page }) => {
  await installLanguageModel(page);
  await page.evaluate(() => {
    window.settingsResponse.aiSuggestTitle = false;
    window.settingsResponse.aiExtractTodos = true;
  });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await expect(root.locator(".ai")).toBeVisible();
  await root.locator(".ai").click();
  await expect(root.locator('[data-ai-action="title"]')).toBeHidden();
  await expect(root.locator('[data-ai-action="todos"]')).toBeVisible();

  await page.evaluate(() => { window.settingsResponse.aiEnabled = false; });
  await root.locator('[data-ai-action="todos"]').click();
  await expect(root.locator(".toast")).toHaveText("This AI action is turned off in Settings.");
  expect(await page.evaluate(() => window.aiPrompts.length)).toBe(0);

  await root.locator(".more").focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(root).toHaveCount(0);
  await page.evaluate(() => {
    window.settingsResponse.aiEnabled = false;
    window.currentDraft = null;
  });
  await openQuickNote(page);
  await expect(page.locator("#notion-quick-note-root .ai")).toBeHidden();
});

test("AI actions fail closed when the note is blank or the local model is unavailable", async ({ page }) => {
  await installLanguageModel(page);
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ai").click();
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="title"]').click();
  await expect(root.locator(".toast")).toHaveText("Write something before using an AI action.");
  expect(await page.evaluate(() => window.aiPrompts.length)).toBe(0);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await installLanguageModel(page, { availability: "unavailable" });
  await page.evaluate(() => { window.currentDraft = null; });
  await openQuickNote(page);
  const reopened = page.locator("#notion-quick-note-root");
  await reopened.locator(".ProseMirror").fill("A note that remains editable.");
  await reopened.locator(".ai").click();
  await expect(reopened.locator(".ai-status")).toContainText("isn’t available");
  await expect(reopened.locator('[data-ai-action="title"]')).toBeDisabled();
  await expect(reopened.locator(".ProseMirror")).toContainText("A note that remains editable.");
});

test("AI action errors and empty extraction results leave the note unchanged", async ({ page }) => {
  await installLanguageModel(page, { mode: "error" });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("Keep this original note.");
  await root.locator(".ai").click();
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="title"]').click();
  await expect(root.locator(".ai-status")).toHaveText("Model stopped unexpectedly");
  await expect(root.locator(".page-title")).toHaveValue("");
  await expect(editor).toContainText("Keep this original note.");

  await installLanguageModel(page, { mode: "empty-tasks" });
  await root.locator('[data-ai-action="todos"]').click();
  await expect(root.locator(".ai-status")).toHaveText("No clear action items found. Nothing changed.");
  await expect(root.locator('.ProseMirror ul[data-type="taskList"] > li')).toHaveCount(0);
  await expect(editor).toContainText("Keep this original note.");
});

test("AI to-dos cannot exceed the note limit or mutate a stale draft", async ({ page }) => {
  await installLanguageModel(page);
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("x".repeat(7_950));
  await root.locator(".ai").click();
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="todos"]').click();
  await expect(root.locator(".ai-preview-todos")).toBeVisible();
  await root.locator(".ai-preview-todos").fill("y".repeat(100));
  await root.locator(".ai-insert-todos").click();
  await expect(root.locator(".toast")).toContainText("8,000-character note limit");
  await expect(root.locator('.ProseMirror ul[data-type="taskList"] > li')).toHaveCount(0);

  await root.locator(".ai-review-back").click();
  await page.evaluate(() => {
    if (!window.currentDraft) throw new Error("Expected an AI draft.");
    window.currentDraft.revision += 10;
  });
  await editor.pressSequentially(" stale");
  await expect(root.locator(".stale-banner")).toBeVisible();
  await expect(root.locator(".ai")).toBeDisabled();
  await root.locator('[data-ai-action="title"]').evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(() => window.aiPrompts.length)).toBe(1);
});

test("dismissing the AI panel aborts hidden model work", async ({ page }) => {
  await installLanguageModel(page, { mode: "pending" });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ProseMirror").fill("A note with pending model work.");
  await root.locator(".ai").click();
  await expect(root.locator(".ai-status")).toHaveText("Ready on this device.");
  await root.locator('[data-ai-action="title"]').click();
  await expect(root.locator(".ai-status")).toHaveText("Suggesting a title…");
  await root.locator(".more").focus();
  await page.keyboard.press("Escape");
  await expect(root.locator(".ai-panel")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.aiDestroyed)).toBe(1);
});

test("editing, composition, Escape, and save shortcuts still work", async ({ page }) => {
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
  await expect(page.locator("#notion-quick-note-root")).toHaveAttribute("popover", "manual");

  await editor.focus();
  await editor.press("Control+Shift+Enter");
  await expect.poll(() => page.evaluate(() => window.runtimeMessages.some((message) => message.type === "ENQUEUE_CAPTURE"))).toBe(true);

  await editor.press("Escape");
  await expect.poll(() => page.locator("#notion-quick-note-root").count()).toBe(0);
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
  const remoteDraft: CaptureDraft = {
    ...draftFixture("edit-draft", "Live Notion content"),
    mode: "edit",
    targetRecordId: "capture-recent",
    returnDraftId: "draft-test",
    title: "Recently saved",
    sources: [
      { title: "First source", url: "https://first.example/article", selection: "", capturedAt: 1 },
      { title: "Second source", url: "https://second.example/video", selection: "", capturedAt: 1 }
    ]
  };
  await page.evaluate((draftJson: string) => {
    window.recentNotes = [{
      id: "capture-recent",
      source: "note",
      title: "Recently saved",
      preview: "A compact preview of the saved note body",
      destinationName: "Test Inbox",
      status: "delivered",
      updatedAt: Date.now(),
      remoteUrl: "https://notion.so/recent",
      editable: true
    }];
    window.remoteDraft = JSON.parse(draftJson) as CaptureDraft;
  }, JSON.stringify(remoteDraft));
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".ProseMirror").fill("Unsaved local thought");
  await root.locator(".recent").click();
  await expect(root.locator(".recent-section").first()).toContainText("Saved notes");
  await expect(root.locator(".recent-edit")).toContainText("Recently saved");
  await expect(root.locator(".recent-preview")).toHaveText("A compact preview of the saved note body");
  await root.locator(".recent-edit").click();
  await expect(root.locator(".page-title")).toHaveValue("Recently saved");
  await expect(root.locator(".ProseMirror")).toHaveText("Live Notion content");
  await expect(root.locator(".edit-banner")).toContainText("draft is stashed");
  await expect(root.locator(".status")).toHaveText("");

  await root.locator(".more").click();
  await expect(root.locator(".source-count")).toHaveText("2 attached");
  await root.locator(".manage-sources").click();
  await expect(root.locator(".source-row")).toHaveCount(2);
  await expect(root.locator(".source-row").first()).toContainText("Primary");
  await root.locator(".source-row").nth(1).locator(".source-remove").click();
  await expect(root.locator(".source-row")).toHaveCount(1);

  const messages = await page.evaluate(() => window.runtimeMessages);
  expect(messages.some((message) => message.type === "UPSERT_DRAFT" && message.draft?.doc.content?.[0]?.content?.[0]?.text === "Unsaved local thought")).toBe(true);
  expect(messages.some((message) => message.type === "LOAD_RECENT_NOTE" && message.id === "capture-recent")).toBe(true);
});

test("Recent buckets drafts above Notion pages and can pull a Notion doc into the composer", async ({ page }) => {
  const stashedDraft = { ...draftFixture("draft-stashed", "Keep this thought nearby"), revision: 2, title: "Stashed draft" };
  const notionDraft: CaptureDraft = {
    ...draftFixture("edit-notion", "Pulled from Notion"),
    mode: "edit",
    targetRecordId: "imported-notion",
    returnDraftId: "draft-test",
    title: "Workspace spec"
  };
  await page.evaluate(({ stashedJson, notionJson }: { stashedJson: string; notionJson: string }) => {
    window.recentDrafts = [{
      id: "draft-stashed",
      source: "draft",
      title: "Stashed draft",
      preview: "Keep this thought nearby",
      destinationName: "Local draft",
      status: "draft",
      mode: "new",
      updatedAt: Date.now(),
      editable: true
    }];
    window.recentNotes = [{
      id: "capture-recent",
      source: "note",
      title: "Extension note",
      preview: "Delivered from Quick Note",
      destinationName: "Quick Notes",
      status: "delivered",
      updatedAt: Date.now() - 60_000,
      remoteUrl: "https://www.notion.so/extension-note",
      editable: true
    }];
    window.recentNotionPages = [{
      id: "notionpageid000000000000000000",
      source: "notion",
      pageId: "notionpageid000000000000000000",
      title: "Workspace spec",
      preview: "",
      destinationName: "Notion",
      status: "notion",
      updatedAt: Date.now() - 120_000,
      remoteUrl: "https://www.notion.so/Workspace-spec",
      editable: true
    }];
    window.recentDraftBodies = {
      "draft-stashed": JSON.parse(stashedJson) as CaptureDraft
    };
    window.notionPageDraft = JSON.parse(notionJson) as CaptureDraft;
  }, { stashedJson: JSON.stringify(stashedDraft), notionJson: JSON.stringify(notionDraft) });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  await root.locator(".recent").click();
  await expect(root.locator(".recent-section")).toHaveCount(3);
  await expect(root.locator(".recent-section").nth(0)).toContainText("Drafts");
  await expect(root.locator(".recent-section").nth(1)).toContainText("Saved notes");
  await expect(root.locator(".recent-section").nth(2)).toContainText("From Notion");
  await expect(root.locator('.recent-row[data-source="draft"] .recent-edit')).toContainText("Stashed draft");
  await expect(root.locator('.recent-row[data-source="note"] .recent-edit')).toContainText("Extension note");
  await expect(root.locator('.recent-row[data-source="notion"] .recent-edit')).toContainText("Workspace spec");

  await root.locator('.recent-row[data-source="notion"] .recent-edit').click();
  await expect(root.locator(".page-title")).toHaveValue("Workspace spec");
  await expect(root.locator(".ProseMirror")).toHaveText("Pulled from Notion");
  await expect(root.locator(".edit-banner")).toContainText("Editing a recent note");

  const messages = await page.evaluate(() => window.runtimeMessages);
  expect(messages.some((message) => (
    message.type === "LOAD_NOTION_PAGE" && message.pageId === "notionpageid000000000000000000"
  ))).toBe(true);
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
    const host = document.querySelector<HTMLElement>("#notion-quick-note-root");
    if (!host) return false;
    const rect = host.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return host.matches(":popover-open") && Boolean(target && host.contains(target));
  })).toBe(true);

  // Browsers reserve Escape while native fullscreen is active, so close through
  // the visible control here; keyboard close is covered in the test above.
  await page.locator("#notion-quick-note-root .close").click();
  await page.evaluate(() => document.exitFullscreen());
  await openQuickNote(page);
  await page.evaluate(() => { window.fullscreenOnNextClick = true; });
  await page.locator("#notion-quick-note-root .more").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect.poll(() => page.locator("#notion-quick-note-root").evaluate((host) => host.matches(":popover-open"))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>("#notion-quick-note-root");
    return Boolean(host?.matches(":popover-open") && host.contains(document.activeElement) && host.shadowRoot?.activeElement);
  })).toBe(true);
});

test("rapid close and reopen cannot remove the newest popup", async ({ page }) => {
  await openQuickNote(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.openQuickNote());
  await page.waitForTimeout(220);

  await expect(page.locator("#notion-quick-note-root")).toHaveCount(1);
  await expect(page.locator("#notion-quick-note-root")).toHaveAttribute("popover", "manual");
  await expect(page.locator("#notion-quick-note-root .ProseMirror")).toBeFocused();
});

test("reinjection disposes the stale runtime and restores the last autosaved draft", async ({ page }) => {
  const pageErrors: string[] = [];
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
  const restored = page.locator("[data-notion-quick-note-owned='true'][popover='manual']");
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
  const followUp = await page.evaluate(() => {
    const message = window.draftWrites[1];
    const text = message?.draft.doc.content?.[0]?.content?.[0]?.text;
    if (!message || typeof text !== "string") throw new Error("Expected the coalesced draft write.");
    return { expectedRevision: message.expectedRevision, text };
  });
  expect(followUp.expectedRevision).toBe(2);
  expect(followUp.text).toBe("Latest revision");
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
  const capturedText = await page.evaluate(() => {
    const capture = window.runtimeMessages.find((message) => message.type === "ENQUEUE_CAPTURE");
    const text = capture?.capture?.document.doc.content?.[0]?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error("Expected the enqueue capture payload.");
    return text;
  });
  expect(capturedText).toBe("Final save payload");
  expect(await page.evaluate(() => window.maxConcurrentDraftWrites)).toBe(1);
});

test("invalidated runtime stops autosaving without an unhandled rejection", async ({ page }) => {
  const pageErrors: string[] = [];
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
  const pageErrors: string[] = [];
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
  const warnings: string[] = [];
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
  await expect.poll(() => page.locator("#notion-quick-note-root").count()).toBe(0);
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

test("select all scopes the first press to a non-empty block and the second to the document", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("First block\nSecond block\nThird block");
  await editor.locator(":scope > p").nth(1).click();

  await editor.press("Control+a");
  await expect.poll(() => selectedEditorText(page)).toBe("Second block");
  await root.locator(".bubble [data-command=bold]").click();
  await expect(editor.locator(":scope > p").nth(1).locator("strong")).toHaveText("Second block");
  await expect(editor.locator(":scope > p").first().locator("strong")).toHaveCount(0);
  await expect(editor.locator(":scope > p").nth(2).locator("strong")).toHaveCount(0);

  await editor.press("Control+a");
  await expect.poll(() => selectedEditorText(page)).toBe("Second block");
  await editor.press("Control+a");
  await expect.poll(async () => (await selectedEditorText(page)).replace(/\s+/g, " ").trim()).toBe(
    "First block Second block Third block"
  );

  await editor.locator(":scope > p").nth(2).click();
  await editor.press("Meta+a");
  await expect.poll(() => selectedEditorText(page)).toBe("Third block");
});

test("select all chooses the complete document immediately from an empty block", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("First block\n\nThird block");
  await editor.locator(":scope > p").nth(1).click();

  await editor.press("Control+a");
  await expect.poll(async () => (await selectedEditorText(page)).replace(/\s+/g, " ").trim()).toBe(
    "First block Third block"
  );
});

test("block commands stay scoped to the block-first selection", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("First block\nSecond block\nThird block");
  await editor.locator(":scope > p").nth(1).click();
  await editor.press("Control+a");

  await root.locator(".block-type").click();
  await root.locator('.format-menu [data-block="heading2"]').click();
  await expect(editor.locator(":scope > h2")).toHaveText("Second block");
  await expect(editor.locator(":scope > p")).toHaveText(["First block", "Third block"]);
});

test("adjacent block types use compact relationship-aware spacing", async ({ page }) => {
  const draft = draftFixture("rhythm", "");
  draft.doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Primary" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Secondary" }] },
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
      { type: "orderedList", attrs: { start: 1, type: null }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }] }] }
    ]
  };
  await page.evaluate((draftJson: string) => { window.currentDraft = JSON.parse(draftJson) as CaptureDraft; }, JSON.stringify(draft));
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");

  await expect(editor.locator(":scope > h2")).toHaveCSS("margin-top", "10px");
  await expect(editor.locator(":scope > h2 + p")).toHaveCSS("margin-top", "0px");
  await expect(editor.locator(":scope > ul + ol")).toHaveCSS("margin-top", "0px");
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
  await expect(slash.locator(".slash-group-label")).toHaveText(["Suggested", "Basic blocks", "Advanced blocks"]);
  await expect(slash.locator(".slash-footer")).toContainText("Type '/' on the page");
  await expect(slash.locator(".slash-footer")).toContainText("esc");
  await expect(slash.locator("small")).toHaveCount(0);
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

test("selection toolbar uses the Balanced hierarchy, SVG affordances, and fits a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 520 });
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.fill("Balanced toolbar");
  await editor.selectText();

  const bubble = page.locator("#notion-quick-note-root .bubble");
  await expect(bubble).toBeVisible();
  expect(await bubble.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => (
    button.getAttribute("aria-label") || button.textContent.trim()
  )))).toEqual(["Text", "Add link", "Bold", "Italic", "Underline", "More formatting"]);
  await expect(bubble.locator(":scope > [data-command=strike], :scope > [data-command=code]")).toHaveCount(0);
  for (const label of ["Add link", "More formatting"]) {
    await expect(bubble.getByRole("button", { name: label }).locator("svg")).toHaveCount(1);
  }

  const bounds = await bubble.evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    const sheetRect = toolbar.closest(".sheet")!.getBoundingClientRect();
    return { toolbarLeft: toolbarRect.left, toolbarRight: toolbarRect.right, sheetLeft: sheetRect.left, sheetRight: sheetRect.right };
  });
  expect(bounds.toolbarLeft).toBeGreaterThanOrEqual(bounds.sheetLeft);
  expect(bounds.toolbarRight).toBeLessThanOrEqual(bounds.sheetRight);

  const overflowButton = bubble.getByRole("button", { name: "More formatting" });
  await overflowButton.click();
  await expect(overflowButton).toHaveAttribute("aria-expanded", "true");
  const overflow = page.locator("#notion-quick-note-root .format-overflow");
  await expect(overflow).toBeVisible();
  await expect(overflow.getByRole("menuitem")).toHaveText(["Strikethrough", "Inline code", "Text color", "Highlight"]);
  for (const label of ["Inline code", "Text color", "Highlight"]) {
    await expect(overflow.getByRole("menuitem", { name: label }).locator("svg")).toHaveCount(1);
  }
  const menuBounds = await overflow.evaluate((menu) => {
    const menuRect = menu.getBoundingClientRect();
    const sheetRect = menu.closest(".sheet")!.getBoundingClientRect();
    return { menuLeft: menuRect.left, menuRight: menuRect.right, sheetLeft: sheetRect.left, sheetRight: sheetRect.right };
  });
  expect(menuBounds.menuLeft).toBeGreaterThanOrEqual(menuBounds.sheetLeft);
  expect(menuBounds.menuRight).toBeLessThanOrEqual(menuBounds.sheetRight);
});

test("toolbar toggles expose active states and link changes preserve the chosen range", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("chosen range");

  for (const [label, tag] of [["Bold", "strong"], ["Italic", "em"], ["Underline", "u"]] as const) {
    await editor.selectText();
    const button = root.locator(".bubble").getByRole("button", { name: label });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(editor.locator(tag)).toHaveText("chosen range");
    await button.click();
  }

  for (const [label, tag] of [["Strikethrough", "s"], ["Inline code", "code"]] as const) {
    await editor.selectText();
    await root.locator(".bubble").getByRole("button", { name: "More formatting" }).click();
    const item = root.locator(`.format-overflow [data-command="${label === "Strikethrough" ? "strike" : "code"}"]`);
    await item.click();
    await expect(item).toHaveAttribute("aria-pressed", "true");
    await expect(editor.locator(tag)).toHaveText("chosen range");
    await root.locator(".bubble").getByRole("button", { name: "More formatting" }).click();
    await item.click();
  }

  await editor.selectText();
  await root.locator(".bubble").getByRole("button", { name: "Add link" }).click();
  await root.locator(".link-input").fill("example.com/chosen");
  await root.locator(".apply-link").click();
  await expect(editor.locator("a")).toHaveAttribute("href", "https://example.com/chosen");
  await expect(editor.locator("a")).toHaveText("chosen range");

  await editor.locator("a").selectText();
  await root.locator(".bubble").getByRole("button", { name: "Edit link" }).click();
  await root.locator(".link-input").fill("");
  await root.locator(".apply-link").click();
  await expect(editor.locator("a")).toHaveCount(0);
  await expect(editor).toHaveText("chosen range");
});

test("text and highlight palettes store every exact Notion color and replace each other", async ({ page }) => {
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  const colors = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  await editor.fill("palette");

  const chooseColor = async (menuLabel: "Text color" | "Highlight", color: string) => {
    await editor.selectText();
    await root.locator(".bubble").getByRole("button", { name: "More formatting" }).click();
    await root.locator(".format-overflow").getByRole("menuitem", { name: menuLabel }).click();
    const palette = root.locator(`.color-palette[data-palette="${menuLabel === "Text color" ? "text" : "highlight"}"]`);
    await expect(palette).toBeVisible();
    await palette.getByRole("menuitemradio", { name: color === "default" ? "Default" : new RegExp(`^${color}$`, "i") }).click();
  };

  for (const color of colors.slice(1)) {
    await chooseColor("Text color", color);
    await expect(editor.locator("span[data-notion-color]")).toHaveAttribute("data-notion-color", color);
  }
  await chooseColor("Text color", "default");
  await expect(editor.locator("span[data-notion-color]")).toHaveCount(0);

  for (const color of colors.slice(1)) {
    await chooseColor("Highlight", color);
    await expect(editor.locator("span[data-notion-color]")).toHaveAttribute("data-notion-color", `${color}_background`);
  }
  await chooseColor("Text color", "blue");
  await expect(editor.locator("span[data-notion-color]")).toHaveAttribute("data-notion-color", "blue");
  await chooseColor("Highlight", "yellow");
  await expect(editor.locator("span[data-notion-color]")).toHaveAttribute("data-notion-color", "yellow_background");
  await chooseColor("Highlight", "default");
  await expect(editor.locator("span[data-notion-color]")).toHaveCount(0);
});

test("toolbar menus preserve selection, close topmost with Escape, dismiss outside, and keep focus treatment scoped", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openQuickNote(page);
  const root = page.locator("#notion-quick-note-root");
  const editor = root.locator(".ProseMirror");
  await editor.fill("keyboard palette");
  await editor.selectText();
  const overflowButton = root.locator(".bubble").getByRole("button", { name: "More formatting" });
  await overflowButton.focus();
  await overflowButton.press("Enter");
  const textColor = root.locator(".format-overflow").getByRole("menuitem", { name: "Text color" });
  await textColor.focus();
  await textColor.press("Enter");
  const palette = root.locator('.color-palette[data-palette="text"]');
  await expect(palette).toBeVisible();
  await expect(textColor).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(textColor).toBeFocused();
  await expect(root.locator(".format-overflow")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(root.locator(".format-overflow")).toBeHidden();
  await expect(overflowButton).toBeFocused();

  await overflowButton.press("Enter");
  await root.locator(".topbar").click({ position: { x: 2, y: 2 } });
  await expect(root.locator(".format-overflow")).toBeHidden();

  await editor.selectText();
  await overflowButton.click();
  await root.locator(".format-overflow").getByRole("menuitem", { name: "Highlight" }).click();
  const backgrounds = await root.locator('.color-palette[data-palette="highlight"] .color-swatch:not([data-color="default"])').evaluateAll((swatches) => (
    swatches.map((swatch) => getComputedStyle(swatch).getPropertyValue("--swatch-color").trim())
  ));
  expect(new Set(backgrounds).size).toBe(9);

  const title = root.locator(".page-title");
  await title.focus();
  const titleStyle = await title.evaluate((element) => getComputedStyle(element));
  expect(titleStyle.outlineColor).not.toBe("rgb(35, 131, 226)");
  await root.locator(".save").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(root.locator(".save")).toBeFocused();
  expect(await root.locator(".save").evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(35, 131, 226)");
});

test("slash command filtering resets selection and removes unfiltered groups", async ({ page }) => {
  await openQuickNote(page);
  const editor = page.locator("#notion-quick-note-root .ProseMirror");
  await editor.pressSequentially("/");
  await editor.press("ArrowDown");
  await editor.pressSequentially("quo");

  const slash = page.locator("#notion-quick-note-root .slash-menu");
  await expect(slash.locator(".slash-group-label")).toHaveCount(0);
  await expect(slash.locator("button")).toHaveCount(1);
  await expect(slash.locator("button")).toHaveText("Quote\"");
  await expect(slash.locator("button")).toHaveAttribute("aria-selected", "true");
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
    const sheet = menu.closest(".sheet");
    if (!sheet) throw new Error("Expected the slash menu sheet.");
    const sheetRect = sheet.getBoundingClientRect();
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

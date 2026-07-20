import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixtureUrl = new URL("../fixtures/media-page.html", import.meta.url).href;
const contentScript = path.resolve(here, "../../dist/content.js");
let staticServer: Server;
let extensionBaseUrl: string;

type Viewport = NonNullable<BrowserContextOptions["viewport"]>;
type ColorScheme = NonNullable<BrowserContextOptions["colorScheme"]>;
type CapturePage = Parameters<Window["openQuickNote"]>[0];

interface PopupPageOptions {
  colorScheme?: ColorScheme;
  viewport?: Viewport;
  settings?: Record<string, unknown>;
  page?: CapturePage;
}

interface OptionsPageOptions {
  colorScheme?: ColorScheme;
  mode?: "connect" | "loading" | "error" | "ready";
  settings?: Record<string, unknown>;
  shortcut?: string;
  shortcutError?: boolean;
  tabCreateError?: boolean;
  viewport?: Viewport;
}

interface OptionsInitState {
  initialSettings: Record<string, unknown>;
  initialShortcut: string;
  shouldFailShortcut: boolean;
  shouldFailTabCreate: boolean;
  stateMode: NonNullable<OptionsPageOptions["mode"]>;
}

test.beforeAll(async () => {
  staticServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const filePath = path.resolve(repoRoot, `.${pathname}`);
      if (filePath !== repoRoot && !filePath.startsWith(`${repoRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(filePath);
      const extension = path.extname(filePath);
      const contentTypes: Record<string, string> = {
        ".css": "text/css",
        ".html": "text/html",
        ".js": "text/javascript",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2"
      };
      response.writeHead(200, { "Content-Type": contentTypes[extension] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  const address = staticServer.address();
  if (address === null || typeof address === "string") throw new Error("Visual test server did not bind to a TCP port.");
  extensionBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => staticServer.close((error?: Error) => error ? reject(error) : resolve()));
});

async function popupPage(browser: Browser, { colorScheme = "light", viewport = { width: 1280, height: 800 }, settings, page: capturePage }: PopupPageOptions = {}) {
  const context = await browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  if (settings) await page.evaluate((value) => { Object.assign(window.settingsResponse, value); }, settings);
  await page.addScriptTag({ path: contentScript });
  await page.evaluate((value) => window.openQuickNote(value), capturePage);
  const sheet = page.locator("#notion-quick-note-root .sheet");
  await expect(sheet).toHaveClass(/visible/);
  return { context, page, sheet };
}

async function expectPopupSnapshot(browser: Browser, name: string, options: PopupPageOptions, prepare?: (page: Page) => void | Promise<void>) {
  const state = await popupPage(browser, options);
  try {
    await prepare?.(state.page);
    await expect(state.sheet).toHaveScreenshot(`${name}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  } finally {
    await state.context.close();
  }
}

test("popup visual states", async ({ browser }) => {
  await expectPopupSnapshot(browser, "popup-light", {}, async (page) => {
    await page.locator("#notion-quick-note-root .ProseMirror").fill("A quiet place for the thought in front of you.");
  });

  await expectPopupSnapshot(browser, "popup-slash-menu", {}, async (page) => {
    await page.locator("#notion-quick-note-root .ProseMirror").press("/");
    await expect(page.locator("#notion-quick-note-root .slash-menu")).toBeVisible();
  });

  await expectPopupSnapshot(browser, "popup-dark-selection", {
    colorScheme: "dark",
    page: { selection: "Selected source text remains editable inside a quote block." }
  });

  await expectPopupSnapshot(browser, "popup-narrow-long", {
    colorScheme: "dark",
    viewport: { width: 390, height: 720 }
  }, async (page) => {
    await page.locator("#notion-quick-note-root .page-title").fill("A longer working note");
    await page.locator("#notion-quick-note-root .ProseMirror").fill(Array.from({ length: 14 }, (_, index) => `Paragraph ${index + 1}: a calm, readable line of captured context.`).join("\n\n"));
  });

  await expectPopupSnapshot(browser, "popup-disconnected", {
    settings: { configured: false, destinationName: "Notion Inbox", includeSource: true }
  });

  await expectPopupSnapshot(browser, "popup-recent-dark", { colorScheme: "dark" }, async (page) => {
    await page.evaluate(() => {
      window.recentDrafts = [
        { id: "draft-one", source: "draft", title: "Half-written thought", preview: "Keep the local draft nearby", destinationName: "Local draft", status: "draft", mode: "new", updatedAt: Date.now(), remoteUrl: "", editable: true }
      ];
      window.recentNotes = [
        { id: "one", source: "note", title: "Questions from the research", preview: "", destinationName: "Quick Notes", status: "delivered", updatedAt: Date.now() - 60_000, remoteUrl: "https://notion.so/one", editable: true },
        { id: "two", source: "note", title: "Video ideas", preview: "", destinationName: "Creative Inbox", status: "delivered", updatedAt: Date.now() - 3_600_000, remoteUrl: "https://notion.so/two", editable: true }
      ];
      window.recentNotionPages = [
        { id: "notionone", source: "notion", pageId: "notionone", title: "Workspace kickoff", preview: "", destinationName: "Notion", status: "notion", updatedAt: Date.now() - 7_200_000, remoteUrl: "https://www.notion.so/kickoff", editable: true }
      ];
    });
    await page.locator("#notion-quick-note-root .recent").click();
    await expect(page.locator("#notion-quick-note-root .recent-section")).toHaveCount(3);
    await expect(page.locator("#notion-quick-note-root .recent-row")).toHaveCount(4);
  });

  await expectPopupSnapshot(browser, "popup-conflict-narrow", { viewport: { width: 390, height: 720 } }, async (page) => {
    await page.evaluate(() => {
      window.recentConflict = true;
      window.recentNotes = [{ id: "conflict", source: "note", title: "Project brief", preview: "", destinationName: "Quick Notes", status: "blocked_conflict", updatedAt: Date.now(), remoteUrl: "https://notion.so/conflict", editable: true }];
      window.remoteDraft = {
        version: 2,
        id: "edit-conflict",
        tabId: 1,
        context: { version: 1, title: "Launch document", url: "https://example.com/launch", selection: "", capturedAt: 1 },
        revision: 1,
        sessionId: "session-test",
        mode: "edit",
        targetRecordId: "conflict",
        returnDraftId: "draft-test",
        title: "Project brief",
        sources: [{ title: "Launch document", url: "https://example.com/launch", selection: "", capturedAt: 1 }],
        dismissedSourceUrls: [],
        includeSource: true,
        remote: null,
        baseFingerprint: "",
        createdAt: 1,
        updatedAt: 1,
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "The local edit is still safe." }] }] }
      };
    });
    await page.locator("#notion-quick-note-root .recent").click();
    await page.locator("#notion-quick-note-root .recent-edit").click();
    await expect(page.locator("#notion-quick-note-root .conflict-actions")).toBeVisible();
  });

  await expectPopupSnapshot(browser, "popup-saving", {}, async (page) => {
    await page.evaluate(() => { window.saveDelay = 10_000; });
    const editor = page.locator("#notion-quick-note-root .ProseMirror");
    await editor.fill("A note on its way to Notion");
    await editor.press("Control+Shift+Enter");
    await expect(page.locator("#notion-quick-note-root .save")).toHaveText("Saving locally…");
  });

  await expectPopupSnapshot(browser, "popup-slow", {}, async (page) => {
    test.setTimeout(20_000);
    await page.evaluate(() => {
      window.captureStatus = { id: "capture-test", status: "sending", lastError: null };
    });
    const editor = page.locator("#notion-quick-note-root .ProseMirror");
    await editor.fill("This note is safe locally while Notion takes longer.");
    await editor.press("Control+Shift+Enter");
    await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Safe locally—Notion is taking longer", { timeout: 12_500 });
  });

  await expectPopupSnapshot(browser, "popup-success", {}, async (page) => {
    const editor = page.locator("#notion-quick-note-root .ProseMirror");
    await editor.fill("Confirmed in Notion");
    await editor.press("Control+Shift+Enter");
    await expect(page.locator("#notion-quick-note-root .status")).toHaveText("Saved to Notion");
  });

  await expectPopupSnapshot(browser, "popup-error", {}, async (page) => {
    await page.evaluate(() => { window.saveResponse = { ok: false, error: "Notion is unavailable" }; });
    const editor = page.locator("#notion-quick-note-root .ProseMirror");
    await editor.fill("This draft stays here if Notion cannot save it.");
    await editor.press("Control+Shift+Enter");
    await expect(page.locator("#notion-quick-note-root .toast")).toHaveText("Notion is unavailable");
  });
});

async function optionsPage(browser: Browser, {
  colorScheme = "light",
  mode = "connect",
  settings = {},
  shortcut = "Command+Shift+Space",
  shortcutError = false,
  tabCreateError = false,
  viewport = { width: 1280, height: 900 }
}: OptionsPageOptions = {}) {
  const context = await browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(({ initialSettings, initialShortcut, shouldFailShortcut, shouldFailTabCreate, stateMode }: OptionsInitState) => {
    const state = { ...initialSettings };
    window.__settingsState = state;
    window.__shortcut = initialShortcut;
    window.__shortcutError = shouldFailShortcut;
    window.__tabCreateError = shouldFailTabCreate;
    const chromeFixture = {
      storage: {
        local: {
          get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...state }),
          set: async (values: Record<string, unknown>) => { Object.assign(state, values); },
          remove: async (keys: string | string[]) => {
            for (const key of typeof keys === "string" ? [keys] : keys) delete state[key];
          },
          clear: async () => Object.keys(state).forEach((key) => delete state[key])
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
      },
      runtime: {
        id: "test-extension-id",
        getManifest: () => ({ version: "0.1.0" }),
        sendMessage: async (message: { type?: string }) => {
          if (message.type === "ENSURE_DEFAULT_DATABASE") {
            if (stateMode === "loading") return new Promise(() => {});
            if (stateMode === "error") {
              return { ok: false, kind: "transient", error: "Gateway timed out" };
            }
            Object.assign(state, {
              destinationType: "database",
              destinationId: "data-source-id",
              destinationDatabaseId: "database-id",
              destinationName: "Quick Notes",
              destinationUrl: "https://notion.so/quick-notes",
              titleProperty: "Name",
              managedDestination: true,
              destinationSchemaVersion: 3,
              onboardingComplete: true,
              databaseProvisioning: null
            });
            return { ok: true, outcome: "created" };
          }
          if (message.type === "SEARCH_DESTINATIONS") return { ok: true, destinations: [] };
          if (message.type === "VALIDATE_CONNECTION") return { ok: true, ready: true };
          if (message.type === "DISCONNECT_NOTION") {
            Object.keys(state).forEach((key) => delete state[key]);
            return { ok: true, warning: "" };
          }
          return { ok: true };
        }
      },
      commands: {
        getAll: async () => {
          if (window.__shortcutError) throw new Error("Commands API unavailable");
          return [{ name: "_execute_action", shortcut: window.__shortcut }];
        }
      },
      permissions: { request: async () => true, remove: async () => true },
      identity: { getRedirectURL: () => "https://example.com", launchWebAuthFlow: async () => "" },
      tabs: {
        getCurrent: async () => null,
        create: async ({ url }: { url?: string }) => {
          if (url !== undefined) window.__openedShortcutUrl = url;
          if (window.__tabCreateError) throw new Error("Native page blocked");
        },
        remove: async () => {}
      }
    };
    Object.assign(window, { chrome: chromeFixture });
  }, {
    initialSettings: settings,
    initialShortcut: shortcut,
    shouldFailShortcut: shortcutError,
    shouldFailTabCreate: tabCreateError,
    stateMode: mode
  });
  await page.goto(`${extensionBaseUrl}/options/options.html`);
  await page.locator(".shell").waitFor();
  return { context, page, pageErrors };
}

async function expectOptionsSnapshot(browser: Browser, name: string, options: OptionsPageOptions, readySelector: string) {
  const state = await optionsPage(browser, options);
  try {
    await state.page.locator(readySelector).waitFor();
    await expect(state.page.locator(".shell")).toHaveScreenshot(`${name}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    expect(state.pageErrors).toEqual([]);
  } finally {
    await state.context.close();
  }
}

test("onboarding visual states", async ({ browser }) => {
  await expectOptionsSnapshot(browser, "onboarding-connect-light", {}, "#connect-panel:not([hidden])");
  await expectOptionsSnapshot(browser, "onboarding-connect-dark", { colorScheme: "dark" }, "#connect-panel:not([hidden])");
  await expectOptionsSnapshot(browser, "onboarding-loading", {
    mode: "loading",
    settings: { token: "secret", workspaceName: "Acme" }
  }, "#provisioning-state:not([hidden])");
  await expectOptionsSnapshot(browser, "onboarding-error", {
    mode: "error",
    settings: { token: "secret", workspaceName: "Acme" }
  }, "#message:not([hidden])");
  await expectOptionsSnapshot(browser, "onboarding-ready", {
    mode: "ready",
    settings: {
      token: "secret",
      workspaceName: "Acme",
      destinationId: "data-source-id",
      destinationType: "database",
      destinationName: "Quick Notes",
      destinationUrl: "https://notion.so/quick-notes",
    }
  }, "#ready-panel:not([hidden])");
});

test("keyboard shortcut settings stay live, actionable, and contained on narrow screens", async ({ browser }) => {
  const state = await optionsPage(browser);
  try {
    await expect(state.page.locator("#shortcut-assignment-status")).toHaveText("Assigned");
    await expect(state.page.locator("#shortcut-keycaps kbd")).toHaveText(["⌘", "⇧", "Space"]);

    await state.page.evaluate(() => {
      window.__shortcut = "";
      window.dispatchEvent(new Event("focus"));
    });
    await expect(state.page.locator("#shortcut-assignment-status")).toHaveText("Not assigned");
    await expect(state.page.locator("#shortcut-warning")).toBeVisible();

    await state.page.evaluate(() => {
      window.__shortcut = "Command+Alt+Y";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(state.page.locator("#shortcut-keycaps kbd")).toHaveText(["⌘", "⌥", "Y"]);

    await state.page.locator("#change-shortcut").click();
    expect(await state.page.evaluate(() => window.__openedShortcutUrl)).toBe("chrome://extensions/shortcuts");
    expect(state.pageErrors).toEqual([]);
  } finally {
    await state.context.close();
  }

  const fallback = await optionsPage(browser, {
    shortcutError: true,
    tabCreateError: true,
    viewport: { width: 390, height: 720 }
  });
  try {
    await expect(fallback.page.locator("#shortcut-assignment-status")).toHaveText("Unavailable");
    await fallback.page.locator("#change-shortcut").click();
    await expect(fallback.page.locator("#shortcut-manual-instructions")).toBeVisible();
    const sectionBox = await fallback.page.locator(".shortcut-settings").boundingBox();
    if (sectionBox === null) throw new Error("Shortcut settings did not render.");
    expect(sectionBox.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox.x + sectionBox.width).toBeLessThanOrEqual(390);
    expect(fallback.pageErrors).toEqual([]);
  } finally {
    await fallback.context.close();
  }
});

test("AI preference controls persist master and per-feature choices", async ({ browser }) => {
  const state = await optionsPage(browser, {
    mode: "ready",
    settings: {
      token: "secret",
      destinationId: "data-source-id",
      destinationType: "database",
      destinationName: "Quick Notes"
    }
  });
  try {
    const master = state.page.locator("#ai-enabled");
    const title = state.page.locator("#ai-suggest-title");
    const todos = state.page.locator("#ai-extract-todos");
    await expect(master).toBeChecked();
    await master.uncheck();
    await expect(title).toBeDisabled();
    await expect(todos).toBeDisabled();
    expect(await state.page.evaluate(() => window.__settingsState.aiEnabled)).toBe(false);

    await master.check();
    await title.uncheck();
    await todos.uncheck();
    expect(await state.page.evaluate(() => ({
      enabled: window.__settingsState.aiEnabled,
      title: window.__settingsState.aiSuggestTitle,
      todos: window.__settingsState.aiExtractTodos
    }))).toEqual({ enabled: true, title: false, todos: false });

    expect(state.pageErrors).toEqual([]);
  } finally {
    await state.context.close();
  }

  const rehydrated = await optionsPage(browser, {
    settings: { aiEnabled: true, aiSuggestTitle: false, aiExtractTodos: false }
  });
  try {
    await expect(rehydrated.page.locator("#ai-enabled")).toBeChecked();
    await expect(rehydrated.page.locator("#ai-suggest-title")).not.toBeChecked();
    await expect(rehydrated.page.locator("#ai-extract-todos")).not.toBeChecked();
    await rehydrated.page.evaluate(() => {
      chrome.storage.local.set = async () => { throw new Error("Storage unavailable"); };
    });
    await rehydrated.page.locator("#ai-enabled").click();
    await expect(rehydrated.page.locator("#ai-enabled")).toBeChecked();
    await expect(rehydrated.page.locator("#message")).toHaveText("Could not save the AI preference. Try again.");
    expect(rehydrated.pageErrors).toEqual([]);
  } finally {
    await rehydrated.context.close();
  }
});

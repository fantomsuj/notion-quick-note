// @ts-nocheck
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fixtureUrl = new URL("../fixtures/media-page.html", import.meta.url).href;
const contentScript = path.resolve(here, "../../dist/content.js");
let staticServer;
let extensionBaseUrl;

test.beforeAll(async () => {
  staticServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const filePath = path.resolve(repoRoot, `.${pathname}`);
      if (filePath !== repoRoot && !filePath.startsWith(`${repoRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(filePath);
      const extension = path.extname(filePath);
      const contentTypes = {
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
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  extensionBaseUrl = `http://127.0.0.1:${staticServer.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => staticServer.close((error) => error ? reject(error) : resolve()));
});

async function popupPage(browser, { colorScheme = "light", viewport = { width: 1280, height: 800 }, settings, page: capturePage } = {}) {
  const context = await browser.newContext({ colorScheme, viewport });
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  if (settings) await page.evaluate((value) => { window.settingsResponse = value; }, settings);
  await page.addScriptTag({ path: contentScript });
  await page.evaluate((value) => window.openQuickNote(value), capturePage);
  const sheet = page.locator("#notion-quick-note-root .sheet");
  await expect(sheet).toHaveClass(/visible/);
  return { context, page, sheet };
}

async function expectPopupSnapshot(browser, name, options, prepare) {
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
        { id: "draft-one", source: "draft", title: "Half-written thought", preview: "Keep the local draft nearby", destinationName: "Local draft", status: "draft", mode: "new", updatedAt: Date.now(), editable: true }
      ];
      window.recentNotes = [
        { id: "one", source: "note", title: "Questions from the research", destinationName: "Quick Notes", status: "delivered", updatedAt: Date.now() - 60_000, remoteUrl: "https://notion.so/one", editable: true },
        { id: "two", source: "note", title: "Video ideas", destinationName: "Creative Inbox", status: "delivered", updatedAt: Date.now() - 3_600_000, remoteUrl: "https://notion.so/two", editable: true }
      ];
      window.recentNotionPages = [
        { id: "notionone", source: "notion", pageId: "notionone", title: "Workspace kickoff", destinationName: "Notion", status: "notion", updatedAt: Date.now() - 7_200_000, remoteUrl: "https://www.notion.so/kickoff", editable: true }
      ];
    });
    await page.locator("#notion-quick-note-root .recent").click();
    await expect(page.locator("#notion-quick-note-root .recent-section")).toHaveCount(3);
    await expect(page.locator("#notion-quick-note-root .recent-row")).toHaveCount(4);
  });

  await expectPopupSnapshot(browser, "popup-conflict-narrow", { viewport: { width: 390, height: 720 } }, async (page) => {
    await page.evaluate(() => {
      window.recentConflict = true;
      window.recentNotes = [{ id: "conflict", title: "Project brief", destinationName: "Quick Notes", status: "blocked_conflict", updatedAt: Date.now(), remoteUrl: "https://notion.so/conflict" }];
      window.remoteDraft = {
        version: 2,
        id: "edit-conflict",
        revision: 1,
        sessionId: "session-test",
        mode: "edit",
        targetRecordId: "conflict",
        returnDraftId: "draft-test",
        title: "Project brief",
        sources: [{ title: "Launch document", url: "https://example.com/launch" }],
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

async function optionsPage(browser, { colorScheme = "light", mode = "connect", settings = {} } = {}) {
  const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(({ initialSettings, stateMode }) => {
    const state = { ...initialSettings };
    window.__settingsState = state;
    window.chrome = {
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...state }),
          set: async (values) => Object.assign(state, values),
          remove: async (keys) => keys.forEach((key) => delete state[key]),
          clear: async () => Object.keys(state).forEach((key) => delete state[key])
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
      },
      runtime: {
        id: "test-extension-id",
        getManifest: () => ({ version: "0.1.0" }),
        sendMessage: async (message) => {
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
      permissions: { request: async () => true, remove: async () => true },
      identity: { getRedirectURL: () => "https://example.com", launchWebAuthFlow: async () => "" },
      tabs: { getCurrent: async () => null, create: async () => {}, remove: async () => {} }
    };
  }, { initialSettings: settings, stateMode: mode });
  await page.goto(`${extensionBaseUrl}/options/options.html`);
  await page.locator(".shell").waitFor();
  return { context, page, pageErrors };
}

async function expectOptionsSnapshot(browser, name, options, readySelector) {
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

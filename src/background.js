import { sendCapture } from "./notion.js";

const DEFAULTS = {
  authType: "token",
  token: "",
  destinationType: "page",
  destinationId: "",
  destinationName: "Notion Inbox",
  titleProperty: "Name",
  includeSource: true,
  oauthClientId: "",
  oauthBrokerUrl: ""
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "notion-quick-note-selection",
    title: "Save selection to Notion Quick Note",
    contexts: ["selection"]
  });
  if (reason === "install") await chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => openQuickNote(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-quick-note") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openQuickNote(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "notion-quick-note-selection") return;
  await openQuickNote(tab, info.selectionText || "");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SAVE_CAPTURE") {
    saveCapture(message.capture).then(
      (value) => sendResponse({ ok: true, value }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message.type === "GET_QUICK_SETTINGS") {
    getSettings().then((settings) => sendResponse({
      destinationName: settings.destinationName,
      includeSource: settings.includeSource,
      configured: Boolean(settings.token && settings.destinationId)
    }));
    return true;
  }

  if (message.type === "OPEN_SETTINGS") {
    chrome.runtime.openOptionsPage();
  }
});

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function saveCapture(capture) {
  const settings = await getSettings();
  const result = await sendCapture({ token: settings.token, settings, capture });
  await chrome.storage.local.set({
    lastCapture: {
      text: capture.text,
      savedAt: new Date().toISOString(),
      destinationName: settings.destinationName
    }
  });
  return result;
}

async function openQuickNote(tab, forcedSelection = "") {
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  try {
    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: location.href,
        selection: window.getSelection()?.toString().trim() || ""
      })
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"]
    });

    await chrome.tabs.sendMessage(tab.id, {
      type: "TOGGLE_QUICK_NOTE",
      page: { ...page, selection: forcedSelection || page.selection }
    });
  } catch (error) {
    console.warn("Could not open Quick Note on this page", error);
    await chrome.runtime.openOptionsPage();
  }
}

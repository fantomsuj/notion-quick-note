export const QUICK_NOTE_PROTOCOL = 1;
export const QUICK_NOTE_BUNDLE = "dist/content.js";

export function createContentRuntimeLoader({ tabs, scripting }) {
  const installations = new Map();

  async function ping(tabId) {
    try {
      const response = await tabs.sendMessage(tabId, {
        type: "QUICK_NOTE_PING",
        protocol: QUICK_NOTE_PROTOCOL
      });
      return response?.ready === true && response.protocol === QUICK_NOTE_PROTOCOL;
    } catch {
      return false;
    }
  }

  async function install(tabId) {
    if (await ping(tabId)) return;
    await scripting.executeScript({ target: { tabId }, files: [QUICK_NOTE_BUNDLE] });
    if (!await ping(tabId)) throw new Error("Quick Note content runtime did not start.");
  }

  return async function ensureContentRuntime(tabId) {
    if (await ping(tabId)) return;
    const active = installations.get(tabId);
    if (active) return active;

    const installation = install(tabId);
    installations.set(tabId, installation);
    try {
      await installation;
    } finally {
      if (installations.get(tabId) === installation) installations.delete(tabId);
    }
  };
}

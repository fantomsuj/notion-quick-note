export const QUICK_NOTE_PROTOCOL = 1;
export const QUICK_NOTE_BUNDLE = "dist/content.js";

interface ContentRuntimePorts {
  tabs: Pick<typeof chrome.tabs, "sendMessage">;
  scripting: Pick<typeof chrome.scripting, "executeScript">;
}

interface ContentRuntimePing {
  ready?: boolean;
  protocol?: number;
}

/** Ensures the page-injected composer runtime is available exactly once per tab. */
export function createContentRuntimeLoader({ tabs, scripting }: ContentRuntimePorts): (tabId: number) => Promise<void> {
  const installations = new Map<number, Promise<void>>();

  async function ping(tabId: number): Promise<boolean> {
    try {
      const response = await tabs.sendMessage(tabId, { type: "QUICK_NOTE_PING", protocol: QUICK_NOTE_PROTOCOL }) as ContentRuntimePing | undefined;
      return response?.ready === true && response.protocol === QUICK_NOTE_PROTOCOL;
    } catch {
      return false;
    }
  }

  async function install(tabId: number): Promise<void> {
    if (await ping(tabId)) return;
    await scripting.executeScript({ target: { tabId }, files: ["dist/content.js"] });
    if (!await ping(tabId)) throw new Error("Quick Note content runtime did not start.");
  }

  return async function ensureContentRuntime(tabId: number): Promise<void> {
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

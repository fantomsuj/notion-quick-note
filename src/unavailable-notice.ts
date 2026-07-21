export function createUnavailableNotice(notifications: Pick<typeof chrome.notifications, "create">) {
  return async (tabId: number, _detail: string): Promise<void> => {
    await notifications.create(`notion-quick-note-unavailable-${tabId}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Quick Note unavailable",
      message: "Quick Note couldn't open on this page. Try again or use another page."
    }).catch(() => undefined);
  };
}

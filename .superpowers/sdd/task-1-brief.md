### Task 1: Isolate and test the native unavailable notice

**Files:**

- Create: `src/unavailable-notice.ts`
- Create: `tests/unavailable-notice.test.ts`

**Interfaces:**

- Consumes: `Pick<typeof chrome.notifications, "create">`, `tabId: number`, and a concise `detail: string`.
- Produces: `showUnavailableNotice(tabId: number, detail: string): Promise<void>` that resolves even if the browser notification API rejects.

- [ ] **Step 1: Write the failing tests**

```ts
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
      message: "Quick Note can only open on regular web pages, not browser pages or PDFs."
    }
  }]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- --test-name-pattern='native unavailable notification'`

Expected: FAIL because `src/unavailable-notice.ts` does not exist.

- [ ] **Step 3: Implement the notifier**

```ts
export function createUnavailableNotice(notifications: Pick<typeof chrome.notifications, "create">) {
  return async (tabId: number, detail: string): Promise<void> => {
    await notifications.create(`notion-quick-note-unavailable-${tabId}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Quick Note unavailable",
      message: detail
    }).catch(() => undefined);
  };
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --test-name-pattern='native unavailable notification'`

Expected: PASS.


# Restricted-Page Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Show a native Quick Note notification whenever the composer cannot open on the current page.

**Architecture:** A small background-only notifier owns the native-notification payload and failure isolation. The service worker calls it alongside the existing action badge/title update; the existing early restricted-page return remains before draft/context work.

**Tech Stack:** Manifest V3, TypeScript, Chrome Notifications API, Node test runner.

## Global Constraints

- Add only the MV3 `notifications` permission; do not add host permissions or a persistent content script.
- The notification must not include page contents, URLs, selections, credentials, or Notion data.
- A notice must be best effort: notification API rejection must not block the existing unavailable badge/title.
- Reuse a stable ID per tab so repeated clicks replace, rather than accumulate, notices.

---

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

### Task 2: Wire the notification into the MV3 worker and declare the permission

**Files:**

- Modify: `src/background.ts:56-60, 1279-1285`
- Modify: `manifest.json:11-18`
- Modify: `scripts/check-release.ts:45-47`
- Modify: `tests/design.test.ts` restricted-page/injected-composer assertions

**Interfaces:**

- Consumes: `createUnavailableNotice(chrome.notifications)` from Task 1.
- Produces: Every `markOverlayUnavailable(tabId, detail)` call displays the native notice and retains its current badge/title behavior.

- [ ] **Step 1: Write the failing manifest/design expectation**

```ts
assert.ok(manifest.permissions.includes("notifications"));
assert.match(background, /createUnavailableNotice\(chrome\.notifications\)/);
```

- [ ] **Step 2: Run the release/design checks and verify failure**

Run: `npm run check:release && npm test -- --test-name-pattern='Quick Note injects its composer'`

Expected: FAIL because the manifest does not yet grant `notifications` and the worker has no notifier wiring.

- [ ] **Step 3: Wire the minimum production change**

```ts
import { createUnavailableNotice } from "./unavailable-notice.js";

const showUnavailableNotice = createUnavailableNotice(chrome.notifications);

async function markOverlayUnavailable(tabId: number, detail: string): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b3261e" }),
    chrome.action.setTitle({ tabId, title: `Quick Note unavailable: ${detail}` }),
    showUnavailableNotice(tabId, detail)
  ]);
}
```

Add `"notifications"` to `manifest.json` permissions and the exact release-check expectation. Add a static design assertion for the worker wiring.

- [ ] **Step 4: Run the focused checks and verify they pass**

Run: `npm run check:release && npm test -- --test-name-pattern='native unavailable notification|Quick Note injects its composer'`

Expected: PASS.

### Task 3: Final validation and commit

**Files:**

- Modify: files from Tasks 1 and 2 only.

- [ ] **Step 1: Run static and automated validation**

Run: `npm run check`

Expected: all unit tests, type checks, release checks, and bundle checks pass.

- [ ] **Step 2: Run browser/MV3 validation**

Run: `npm run test:browser`

Expected: all browser and MV3 tests pass.

- [ ] **Step 3: Commit only this feature's files**

```bash
git add manifest.json src/background.ts src/unavailable-notice.ts tests/unavailable-notice.test.ts scripts/check-release.ts tests/design.test.ts docs/superpowers/specs/2026-07-20-restricted-page-notification-design.md docs/superpowers/plans/2026-07-20-restricted-page-notification.md
git commit -m "feat: notify when Quick Note cannot open"
```

Do not stage unrelated worktree changes.

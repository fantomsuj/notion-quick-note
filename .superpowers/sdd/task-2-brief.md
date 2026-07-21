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


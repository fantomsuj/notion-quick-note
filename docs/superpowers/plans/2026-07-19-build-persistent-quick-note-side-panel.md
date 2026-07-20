# Persistent Quick Note Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one toolbar click open a composer that remains usable across tab switches and automatically attaches each active page until the user dismisses it for that draft.

**Architecture:** Replace the primary in-page overlay invocation with Chrome's window-scoped side panel. The side-panel page opens a runtime port for exactly as long as it exists; the background worker observes active-tab changes for connected panel windows and forwards title/URL-only context through the port into the mounted composer. Drafts persist normalized dismissed source URLs so removed pages do not reappear during the same draft.

**Tech Stack:** Chrome Manifest V3 (`sidePanel`, `tabs`, `action`, `tabs.onActivated`, `tabs.onUpdated`), TypeScript, Tiptap, Node test runner, Playwright, esbuild.

## Global Constraints

- Preserve Manifest V3 and Chrome 116 as the minimum version.
- Automatic tracking captures page title and URL only; selected text remains an explicit command.
- Dismissal is scoped to one draft and is cleared when that draft is saved or discarded.
- Existing Notion delivery, OAuth, Incognito isolation, and extension-tab fallback behavior must remain unchanged.
- Do not add required host permissions or inject scripts continuously.
- Preserve unrelated uncommitted changes already present in the workspace.

---

### Task 1: Persist source-dismissal semantics in the draft model

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/capture-store.ts`
- Modify: `tests/capture-store.test.ts`
- Modify: `tests/types/contracts.test-d.ts`

**Interfaces:**
- Produces: `CaptureDraft.dismissedSourceUrls: string[]`.
- Produces: `normalizeDismissedSourceUrls(value: unknown): string[]` using the same fragment-free URL normalization as sources.
- Produces: `addContextToDraft(draft, context, timestamp, { explicit?: boolean })`, where automatic context skips dismissed URLs and explicit context restores a dismissed URL.

- [ ] **Step 1: Add failing repository tests**

Add tests proving that automatic context cannot reattach a removed normalized URL, explicit context restores it, fragments deduplicate, and a newly created draft starts with no dismissals:

```ts
test("automatic context respects draft-scoped source dismissals until explicit restore", () => {
  const draft = normalizeDraft({
    version: 2,
    id: "draft",
    sources: [],
    dismissedSourceUrls: ["https://example.com/article#old"],
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] }
  });
  const automatic = addContextToDraft(draft, { title: "Article", url: "https://example.com/article#new" }, 200, { explicit: false });
  assert.deepEqual(automatic.sources, []);
  const restored = addContextToDraft(automatic, { title: "Article", url: "https://example.com/article" }, 300, { explicit: true });
  assert.deepEqual(restored.sources.map((source) => source.url), ["https://example.com/article"]);
  assert.deepEqual(restored.dismissedSourceUrls, []);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx --test --test-name-pattern="source dismissals" tests/capture-store.test.ts`

Expected: FAIL because `dismissedSourceUrls` and the fourth `addContextToDraft` argument are not implemented.

- [ ] **Step 3: Implement normalized dismissal state**

Add `dismissedSourceUrls` to `CaptureDraft`, normalize it in `normalizeDraft`, initialize it to `[]`, preserve it in `upsertDraft`, and update context attachment:

```ts
export function addContextToDraft(
  draft: unknown,
  context: unknown,
  timestamp: number,
  { explicit = true }: { explicit?: boolean } = {}
): CaptureDraft {
  const next = requireDraft(draft);
  const source = sourceFromContext(context);
  if (!source) return next;
  const dismissed = new Set(normalizeDismissedSourceUrls(next.dismissedSourceUrls));
  if (!explicit && source.url && dismissed.has(source.url)) return next;
  if (explicit && source.url) dismissed.delete(source.url);
  next.dismissedSourceUrls = [...dismissed];
  const beforeSources = JSON.stringify(next.sources);
  const shouldAppendSelection = Boolean(source.selection && !documentContainsText(next.doc, source.selection));
  next.sources = normalizeSources([...next.sources, source]);
  if (shouldAppendSelection) next.doc = appendSelection(next.doc, source.selection);
  if (JSON.stringify(next.sources) !== beforeSources || shouldAppendSelection) {
    next.revision += 1;
    next.updatedAt = timestamp;
  }
  return next;
}
```

Update the contract type assertion fixture to require `dismissedSourceUrls` on normalized drafts.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npx tsx --test --test-name-pattern="source dismissals|sources normalize|one active draft" tests/capture-store.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the draft-model change**

```bash
git add src/contracts.ts src/capture-store.ts tests/capture-store.test.ts tests/types/contracts.test-d.ts
git commit -m "feat: remember dismissed quick note sources"
```

---

### Task 2: Let the mounted composer accept automatic active-page context

**Files:**
- Modify: `src/content.ts`
- Modify: `types/globals.d.ts`
- Modify: `tests/browser/quick-note.spec.ts`

**Interfaces:**
- Produces: `window.__notionQuickNoteUpdateContext({ page, tabId, explicit? }): void`.
- Consumes: `CaptureDraft.dismissedSourceUrls` from Task 1.
- Automatic calls use `explicit: false`; the existing add-current-page control uses `explicit: true`.

- [ ] **Step 1: Add a failing composer regression test**

Extend the browser fixture test to open one composer, call the new global context updater for page A and page B, remove page A, revisit page A automatically, and assert that page A stays absent while page B remains. Then invoke the existing add-current-page control and assert that page A returns once.

```ts
await page.evaluate(() => window.__notionQuickNoteUpdateContext?.({
  page: { title: "Second page", url: "https://second.example/path", selection: "" },
  tabId: 2,
  explicit: false
}));
await expect(sourceRows(page)).toContainText("Second page");
```

- [ ] **Step 2: Run the focused browser test and confirm RED**

Run: `npx playwright test tests/browser/quick-note.spec.ts --grep "tracks active page context"`

Expected: FAIL because `__notionQuickNoteUpdateContext` does not exist.

- [ ] **Step 3: Implement context merging and dismissal UI**

Add a runtime function that updates `instance.page` and `instance.tabId`, replaces metadata for an already attached normalized URL, skips automatic dismissed URLs, and schedules the existing autosave without touching title or editor content. Include `dismissedSourceUrls` in `normalizeDraft`, `applyDraftToInstance`, and `draftSnapshot`.

When `.source-remove` is clicked, append the normalized URL to `instance.dismissedSourceUrls`. When `.add-current-source` is clicked, remove the current normalized URL from that list before attaching the source. Delete the global during runtime disposal.

- [ ] **Step 4: Run the focused browser test and confirm GREEN**

Run: `npx playwright test tests/browser/quick-note.spec.ts --grep "tracks active page context"`

Expected: PASS with one composer instance, deduplicated sources, and no restored dismissed source.

- [ ] **Step 5: Commit the composer change**

```bash
git add src/content.ts types/globals.d.ts tests/browser/quick-note.spec.ts
git commit -m "feat: update composer context across tabs"
```

---

### Task 3: Make the native side panel the persistent primary surface

**Files:**
- Modify: `manifest.json`
- Modify: `src/background.ts`
- Modify: `sidepanel/sidepanel.ts`
- Modify: `sidepanel/index.html`
- Modify: `scripts/check-release.ts`
- Modify: `tests/design.test.ts`

**Interfaces:**
- Consumes: `window.__notionQuickNoteUpdateContext` from Task 2.
- Produces: `openQuickNotePanel(tab, forcedSelection?)`, which prepares the draft and opens `chrome.sidePanel.open({ windowId })`.
- Produces: a `notion-quick-note-panel` runtime port that registers the panel window while connected.
- Produces: background listeners for `chrome.tabs.onActivated` and `chrome.tabs.onUpdated` that forward context only to connected panel windows.

- [ ] **Step 1: Add failing manifest and source-shape tests**

Add assertions that the manifest includes `tabs`, the action has no popup, the toolbar handler opens a side panel by `windowId`, the background registers active-tab listeners, and the side-panel entry automatically opens Compose and connects its lifetime port.

```ts
assert.ok(manifest.permissions.includes("tabs"));
assert.match(background, /chrome\.sidePanel\.open\(\{ windowId:/);
assert.match(background, /chrome\.tabs\.onActivated\.addListener/);
assert.match(sidepanel, /chrome\.runtime\.connect\(\{ name: "notion-quick-note-panel" \}\)/);
assert.match(sidepanel, /await openComposer\(\)/);
```

- [ ] **Step 2: Run the focused design test and confirm RED**

Run: `npx tsx --test --test-name-pattern="persistent side panel" tests/design.test.ts`

Expected: FAIL because `tabs`, window-scoped opening, and side-panel listeners are missing.

- [ ] **Step 3: Implement the toolbar and shortcut surface change**

Add `tabs` to required permissions and update release checks. Change toolbar and keyboard commands to prepare the current draft, then call `chrome.sidePanel.open({ windowId: tab.windowId })`. Keep context-menu selection explicit and keep the extension-tab fallback when opening the panel fails.

Remove the primary path that injects or toggles the in-page overlay; retain its code only for compatibility with the extension-tab/side-panel composer runtime and existing fallback recovery. Register `chrome.runtime.onConnect`, `chrome.tabs.onActivated`, and `chrome.tabs.onUpdated` listeners. A connected panel posts its `windowId`; the worker forwards only supported title/URL context for that window and removes the registration when the port disconnects.

- [ ] **Step 4: Implement side-panel lifetime tracking**

On side-panel load, resolve its Chrome window with `chrome.windows.getCurrent()`, open `chrome.runtime.connect({ name: "notion-quick-note-panel" })`, post the resolved `windowId`, query that window's active tab, request the current draft, and open the composer automatically. Port messages containing supported title/URL context call `__notionQuickNoteUpdateContext`. Ignore extension pages, restricted schemes, PDFs, other windows, and events without a usable URL.

```ts
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (panelPorts.has(windowId)) void publishActivePage(windowId, tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && panelPorts.has(tab.windowId) && (changeInfo.status === "complete" || changeInfo.url || changeInfo.title)) {
    void publishActivePage(tab.windowId, tabId);
  }
});
```

- [ ] **Step 5: Run focused tests and extension build**

Run: `npx tsx --test --test-name-pattern="persistent side panel" tests/design.test.ts && npm run build`

Expected: tests PASS and esbuild exits 0.

- [ ] **Step 6: Commit the native panel change**

```bash
git add manifest.json src/background.ts sidepanel/sidepanel.ts sidepanel/index.html scripts/check-release.ts tests/design.test.ts
git commit -m "feat: keep quick note open across tabs"
```

---

### Task 4: Update product, store, and privacy-facing behavior descriptions

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/STORE_LISTING.md`
- Modify: `PRIVACY.md`
- Modify: `tests/design.test.ts`

**Interfaces:**
- Documents the required `tabs` permission and automatic active-page title/URL capture introduced by Task 3.

- [ ] **Step 1: Add a failing documentation assertion**

Assert that store copy names `tabs`, explains automatic tracking only while the panel is open, and no longer claims page details are read only on explicit invocation.

```ts
test("persistent side panel documentation matches automatic context behavior", () => {
  assert.match(storeListing, /\| `tabs` \|/);
  assert.match(storeListing, /while the Quick Note side panel is open/i);
  assert.doesNotMatch(storeListing, /reads active-page details only when you invoke it/i);
  assert.match(readme, /remains open while you switch tabs/i);
});
```

- [ ] **Step 2: Run the documentation test and confirm RED**

Run: `npx tsx --test --test-name-pattern="persistent side panel documentation" tests/design.test.ts`

Expected: FAIL against the current overlay/fallback language.

- [ ] **Step 3: Update user-facing documentation**

Describe the side panel as the primary surface, state that one initial invocation is enough while it remains open, explain removable automatic title/URL sources, and state that selected text is captured only by explicit action. Add a specific Web Store justification for `tabs`; update the `sidePanel`, `activeTab`, and `scripting` explanations to match their reduced/explicit roles.

- [ ] **Step 4: Run documentation and release checks**

Run: `npx tsx --test --test-name-pattern="persistent side panel documentation" tests/design.test.ts && npm run check:release`

Expected: PASS with manifest permissions and store explanations aligned.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/PRODUCT.md docs/STORE_LISTING.md PRIVACY.md tests/design.test.ts
git commit -m "docs: describe persistent quick note workflow"
```

---

### Task 5: Full verification and manual MV3 evidence

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Verifies the complete feature against the approved design.

- [ ] **Step 1: Run static and unit verification**

Run: `npm run typecheck && npm test && npm run check:release`

Expected: all commands exit 0 with zero test failures and zero TypeScript errors.

- [ ] **Step 2: Run browser and MV3 verification**

Run: `npm run test:browser && npm run build`

Expected: Playwright and MV3 suites pass; the production extension build exits 0.

- [ ] **Step 3: Inspect the final scoped diff**

Run: `git diff origin/main...HEAD --stat && git diff --check && git status --short`

Expected: no whitespace errors; only planned files plus pre-existing user changes appear.

- [ ] **Step 4: Record manual reload instructions**

Report that an already loaded unpacked extension must be reloaded at `chrome://extensions` before testing, then verify: click once, switch between two HTTP(S) tabs, observe both source rows, remove one, revisit its tab, and confirm it stays dismissed.

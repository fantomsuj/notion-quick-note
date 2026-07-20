# Task 2 report: mounted global side-panel composer

## Status

Implemented the Task 2 integration in the shared dirty worktree without staging, committing, resetting, restoring, or checking out files. Task 1's public coordinator and contract behavior was consumed as-is.

The extension now uses one window-scoped panel coordinator, typed panel commands, and a mounted composer adapter. Reopening the active draft reveals the existing editor without changing its DOM node, content, selection, timers, or stored draft revision. A different draft updates the existing Tiptap instance. Activity hides and resumes that instance without destroying it. Automatic active-page events update sources only.

## RED evidence

Tests were added before production changes.

1. `npx tsx --test tests/panel-coordinator.test.ts tests/design.test.ts`
   - RED: 21 passed, 1 failed.
   - Intended failure: the strengthened design test could not find `createPanelCoordinator` integration in `src/background.ts`; the background still contained `panelPorts`, `OPEN_DRAFT`, and tab-specific side-panel paths.

2. `npx playwright test tests/browser/quick-note.spec.ts --grep "same draft|different draft|Activity" --workers=1`
   - RED: 0 passed, 3 failed.
   - Same-draft and different-draft invocations replaced the remembered `.ProseMirror` DOM node.
   - Activity suspension/resume behavior was absent.

The first parallel browser RED attempt encountered Chromium launch contention. Re-running with one worker produced the behavioral failures above, distinguishing the expected product RED from the environment failure.

## Implementation

### Background and coordinator

- Replaced the local `panelPorts` map with `createPanelCoordinator()`.
- Validated panel registration with `isPanelRegistrationMessage()`.
- Registered and unregistered exact ports and published the current supported HTTP(S) page immediately after registration.
- Routed activation/navigation context only through `ACTIVE_PAGE_CONTEXT`; these events do not create drafts or navigate the panel.
- Opened toolbar/shortcut, context-menu, Activity, and saved-draft entry points only through `chrome.sidePanel.open({ windowId })`.
- Sent `SHOW_COMPOSER` or `SHOW_ACTIVITY` through the coordinator only after the open promise resolved. The coordinator covers already-connected and just-after-open registration ordering.
- Preserved extension-tab fallback behavior for failed global panel opens.
- Avoided repository/session mutation when an already-connected panel is merely revealed, preventing repeated toolbar invocation from invalidating the mounted editor's revision.
- Forwarded explicit context-menu selections into the connected mounted editor without remounting it.

### Side panel and mounted composer

- The panel lifetime port sends only `REGISTER_PANEL { windowId }`.
- Added typed handling for `SHOW_COMPOSER`, `SHOW_ACTIVITY`, and `ACTIVE_PAGE_CONTEXT`.
- Same-draft `SHOW_COMPOSER` resumes the mounted composer without fetching or reloading it.
- Different-draft `SHOW_COMPOSER` fetches the requested draft and updates the existing Tiptap instance.
- Activity suspends the composer by hiding its existing host and resumes the same host on Compose.
- Page-context updates continue to merge source metadata into the mounted draft; selected text is applied only for the explicit selection entry point.
- The global default side panel waits for the worker navigation command, avoiding an initialization race. Explicit extension-tab fallback URLs still initialize their requested view.

### Obsolete injection cleanup and documentation

- Deleted `src/content-loader.ts` and `tests/content-loader.test.ts`.
- Kept bundle syntax and size validation and changed the bundle check to reject background content-injection paths.
- Removed all `sidePanel.setOptions({ tabId })`, `sidePanel.open({ tabId })`, `OPEN_DRAFT`, `panelPorts`, and background script-injection paths.
- Kept the manifest permission set unchanged: `tabs` and `sidePanel` remain present; `activeTab` and `scripting` remain absent.
- Updated the visual guide, README reload note, and persistent-side-panel design spec to describe the extension-owned mounted panel rather than an injected webpage overlay.

## GREEN and verification evidence

Required checks on the final state:

1. `npx tsx --test tests/panel-coordinator.test.ts tests/design.test.ts`
   - PASS: 22/22.

2. `npx playwright test tests/browser/quick-note.spec.ts --grep "mounted composer|same draft|different draft|Activity"`
   - PASS: 5/5.

3. `npm run build && npm run check:bundle`
   - PASS: all four bundles built.
   - `dist/content.js`: 437,071 / 450,000 bytes.

4. `git diff --check`
   - PASS: no whitespace errors.

Additional regression check:

- `npx playwright test tests/browser/quick-note.spec.ts --workers=4`
  - PASS: 39/39.

TypeScript check:

- `npx tsc -b --force --pretty false`
  - Nonzero due to the ongoing shared strict-TypeScript migration that was already present when Task 2 began.
  - Diagnostic count on the final shared state: 332 total; 331 in `src/content.ts`, 1 in `tests/types/contracts.test-d.ts`, 0 elsewhere.
  - The worktree began with the shared removal of `// @ts-nocheck` from `src/content.ts` and broad incomplete typing changes. Task 2 necessarily adds the mounted adapter inside that same file, so a clean task-only TypeScript result cannot be isolated from the pre-existing file-wide diagnostics. No diagnostics were reported for `src/background.ts`, `sidepanel/sidepanel.ts`, `src/panel-coordinator.ts`, `src/contracts.ts`, the bundle check, or the new design/browser tests.

## Exact Task 2 files changed

- `src/background.ts`
- `sidepanel/sidepanel.ts`
- `src/content.ts`
- `types/globals.d.ts`
- `scripts/check-bundle-size.ts`
- `tests/browser/quick-note.spec.ts`
- `tests/design.test.ts`
- `README.md`
- `docs/VISUAL_GUIDE.md`
- `docs/superpowers/specs/2026-07-19-persistent-quick-note-side-panel-design.md`
- Deleted: `src/content-loader.ts`
- Deleted: `tests/content-loader.test.ts`
- Added: `.superpowers/sdd/persistent-composer/task-2-report.md`

## Concerns

- The shared strict-TypeScript migration remains incomplete as quantified above; this task does not claim a clean full-project typecheck.
- The final content bundle is within budget with 12,929 bytes of remaining headroom.

## Lifecycle follow-up — 2026-07-20

### Scope and fixes

Follow-up review identified five related lifecycle edges, all patched without staging, committing, resetting, restoring, or checking out files:

1. Activity suspension now closes the modal dialog before hiding it. This releases the panel document from modal inertness while retaining the same connected dialog host and Tiptap editor. Resume unhides the connected host and calls `showModal()` only when it is not already open.
2. A connected coordinator with no active repository draft now falls through to `getOrCreateDraft()` rather than emitting a draft-less reveal command.
3. Only the true global side-panel URL registers a lifetime port. Extension-tab fallback URLs containing an explicit `view` query no longer register and cannot replace the coordinator's real window port.
4. Explicit selection context now appends a selected passage as a blockquote and retains it on the source without remounting the editor. Explicit context is published after global open only when an existing mounted repository draft was reused; creation paths already embed the selection and therefore do not receive a duplicate context event.
5. Draft switching is transactional. The old draft persists before its autosave timer is cleared; a failed persist retains the mounted old draft, restarts autosave recovery, leaves `sidepanel.activeDraft` unchanged, and is caught by the port handler. Same-draft reuse now requires an explicit matching `draftId` and runs through the idempotent composer open adapter. A command without `draftId` always fetches `GET_PANEL_DRAFT`.

The executable routing seam is in `src/panel-lifecycle.ts`, with focused coverage in `tests/panel-lifecycle.test.ts`.

### Follow-up RED evidence

- `npx playwright test tests/browser/quick-note.spec.ts --grep "Activity suspension" --workers=1`
  - RED: 0/1. After suspension the dialog's `open` property remained `true`, proving that `hidden` alone did not release modal state.
- `npx tsx --test tests/panel-lifecycle.test.ts` against the previous routing semantics
  - RED: 0/3 for connected-without-draft creation, explicit same-draft reopen, and draft-less command fetching.
  - After adding fallback and transactional cases, the old behavior failed four intended assertions: fallback registration, connected-without-draft creation, same-draft reopen, and no-ID fetching.
- `npx playwright test tests/browser/quick-note.spec.ts --grep "explicit selection|failed different draft" --workers=1`
  - RED: 0/2. No blockquote was inserted for the selected passage, and autosave did not restart after a failed in-place switch.
- `npx tsx --test tests/panel-lifecycle.test.ts` after adding the forced-selection decision assertion
  - RED: 5/6. The old unconditional publish decision returned `true` for a newly created draft, exposing the duplicate-selection path.

### Follow-up GREEN and verification evidence

- `npx tsx --test tests/panel-coordinator.test.ts tests/panel-lifecycle.test.ts tests/design.test.ts`
  - PASS: 28/28.
- `npx playwright test tests/browser/quick-note.spec.ts --grep "mounted composer|same draft|different draft|Activity|explicit selection|failed different draft"`
  - PASS: 7/7.
- `npx playwright test tests/browser/quick-note.spec.ts --workers=4`
  - PASS: 41/41.
- `npm run build && npm run check:bundle`
  - PASS: all four bundles built.
  - `dist/content.js`: 437,504 / 450,000 bytes.
- `git diff --check`
  - PASS: no whitespace errors.
- `npx tsc -b --force --pretty false`
  - Still nonzero only because of the shared strict migration: 332 diagnostics, all in `src/content.ts`, and zero diagnostics elsewhere. The aggregate count is unchanged from the preceding Task 2 verification even though concurrent shared typing edits moved the former contract-test diagnostic into `src/content.ts`.

### Additional follow-up files

- Added: `src/panel-lifecycle.ts`
- Added: `tests/panel-lifecycle.test.ts`
- Further updated: `src/background.ts`
- Further updated: `sidepanel/sidepanel.ts`
- Further updated: `src/content.ts`
- Further updated: `tests/browser/quick-note.spec.ts`
- Further updated: `.superpowers/sdd/persistent-composer/task-2-report.md`

### Updated concern

- The final content bundle remains within budget with 12,496 bytes of headroom.

## Activation and terminal-lifecycle follow-up — 2026-07-20

### Scope and fixes

- `GET_PANEL_DRAFT` now reads an explicit `draftId` with `getDraft()` and does not mutate `activeDraftId` or the target draft. Draft-less requests still create or reuse the active composer draft.
- Explicit panel switching is transactional across repository and mounted UI state. The target is mounted only after the old editor persists, then activated. Activation failure restores the prior mounted draft without persisting the target. If the returned revision cannot be synchronized, the transaction reactivates and restores the prior draft.
- The post-activation same-ID mount is intentionally idempotent: it synchronizes `tabId`, `sessionId`, and `revision` only and does not replace editor content, selection, or the Tiptap DOM node.
- Successful enqueue emits a terminal `saved` event. The panel clears both its cached active draft and any one-shot requested draft ID, so the empty-state Open action requests a fresh draft.
- Discard uses a two-phase mounted adapter. Preparation marks the matching instance terminal, cancels timers, drains any in-flight autosave, and prevents another write. A successful repository discard then emits `discarded` and immediately destroys the suspended editor. A failed discard restores normal autosave behavior.
- The browser fixture now returns complete typed draft/status responses needed by the shared strict runtime response validator.

### TDD evidence

- Initial unit run: 20 passed, 2 failed. The successful-switch assertion showed repository `activeDraftId` remained `old-active`, and the terminal-cache helper was absent.
- Repository coverage now asserts both identifiers across the complete transaction: failed editor open, failed activation, and failed post-activation identity sync all leave repository and mounted UI on the old draft; a successful transaction puts both on the target.
- Browser coverage verifies that successful save emits the matching terminal event and that discarding a suspended current draft removes its mounted editor, cancels the scheduled autosave, and does not recreate the deleted draft.

### Final scoped verification

- `node --import tsx --test tests/panel-lifecycle.test.ts tests/capture-store.test.ts`
  - PASS: 28/28.
- Focused lifecycle browser run covering same-draft reuse, Activity suspend/resume, failed switch recovery, save terminal signaling, single-flight save, and suspended discard:
  - PASS: 6/6.
- `npm run build`
  - PASS: all four bundles built.
- `git diff --check`
  - PASS: no whitespace errors.

### Shared-worktree verification constraints

- Full `npm test` reached 178/180. The two failures are the paused Task 3 color/toolbar RED design assertions; this follow-up did not edit that work.
- The broader composer run excluding the four named Task 3 browser RED tests reached 26/42. Remaining failures are in pre-existing strict-response fixture coverage outside the Task 2 lifecycle paths (settings, AI, Recent, and delivery-state fixtures); all six scoped lifecycle/save/discard behaviors pass.
- `npm run check:bundle` currently reports `dist/content.js` at 451,159 bytes versus the 450,000-byte budget. Task 2 previously passed at 437,504 bytes; the current shared bundle includes the paused Task 3 toolbar/color implementation. This follow-up did not alter toolbar/color/focus code.

## Discard rejection reconciliation follow-up — 2026-07-20

### Fix

- The composer discard event now rolls back its terminal preparation on every definite failure, including thrown runtime errors and nonterminal successful responses.
- Ambiguous rejected or malformed discard responses are reconciled with a read-only explicit `GET_PANEL_DRAFT`. A retained draft resets `accepted`, restarts autosave, and surfaces the transport error; a confirmed missing draft emits the terminal event and disposes the editor.
- Missing explicit panel drafts now return the typed `draft_not_found` error code through the background error response, so production reconciliation does not depend on an error string.
- Activity discard uses `try/catch/finally`, always calls the mounted finish adapter, and performs the same read-only reconciliation after a rejected runtime operation.

### Tests and verification

- Added browser coverage for both ambiguous outcomes: runtime rejection with the draft retained must restore editing/autosave without a page error, while deletion followed by response-channel rejection must terminal-dispose the composer.
- `node --import tsx --test tests/panel-lifecycle.test.ts tests/capture-store.test.ts`
  - PASS: 28/28.
- `npm run build`
  - PASS: all bundles built.
- `git diff --check`
  - PASS.
- The narrow browser test is currently blocked before the discard action by paused Task 3 code: its new `ComposerRoot` wrapper does not expose `addEventListener`, so composer opening throws `TypeError: d.root.addEventListener is not a function`. The rejection tests and fixture controls are present, but this Task 2 follow-up did not modify the paused toolbar/color/focus implementation.

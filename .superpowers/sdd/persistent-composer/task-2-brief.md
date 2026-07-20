# Task 2: Integrate one mounted global side-panel composer

Integrate the Task 1 coordinator into the extension and finish the window-scoped side-panel migration. Preserve all existing user changes and do not stage, commit, reset, restore, or checkout files.

## Required interfaces

- Consume `createPanelCoordinator()` from `src/panel-coordinator.ts` and the typed messages/registration guard from `src/contracts.ts`.
- The panel sends only `REGISTER_PANEL { windowId }` to register its lifetime port.
- The worker sends `SHOW_COMPOSER`, `SHOW_ACTIVITY`, and `ACTIVE_PAGE_CONTEXT` exactly as defined in Task 1.

## Background behavior

- Replace the local `panelPorts` map with the coordinator.
- On a valid registration, register the port and immediately publish the active HTTP(S) page context for that window. On disconnect, unregister only that exact port.
- Tab activation/navigation publishes `ACTIVE_PAGE_CONTEXT` only when that window has a registered panel. It must not create a draft/session or send `SHOW_COMPOSER`.
- Toolbar, shortcut/context-menu, Activity, and saved-draft entry points must open the global panel exclusively with `chrome.sidePanel.open({ windowId })`.
- After the open promise resolves, send the appropriate navigation command through the coordinator. This ordering must handle both an already-connected panel and a panel that registers just after `open()` resolves.
- Remove every `sidePanel.setOptions({ tabId })` and `sidePanel.open({ tabId })` path. When global opening fails, open the existing extension-tab fallback URL.
- Repeated invocation for the active draft must be idempotent; it may reveal Compose but must not recreate the editor or replace unsaved editor content.

## Side-panel/composer behavior

- Handle all three typed worker messages.
- Keep one composer/Tiptap instance mounted while browser tabs change. `ACTIVE_PAGE_CONTEXT` updates only source metadata.
- `SHOW_COMPOSER` selects Compose and fetches/loads the requested draft only when its ID differs. The composer adapter must update a different draft inside the existing Tiptap instance instead of closing/destroying/recreating it.
- Make the existing composer open adapter idempotent for the same draft. A same-draft call must preserve the editor DOM node, content, selection, and draft timers.
- `SHOW_ACTIVITY` hides/suspends the composer without destroying it, selects Activity, and loads activity. Returning to Compose resumes the mounted composer. The explicit composer close/discard behavior may still destroy it.
- Preserve autosave/revision checks, dismissed sources, Incognito behavior, fallback tabs, and close/reopen recovery.

## Obsolete overlay cleanup

- Delete the unused `src/content-loader.ts` and its focused test now that the primary path never injects the composer.
- Update `scripts/check-bundle-size.ts` to retain bundle syntax/size checks and assert the background has no `scripting.executeScript`/content-injection path, without reading the deleted loader.
- Keep the public manifest permission set unchanged (`tabs` + `sidePanel`, no `activeTab` or `scripting`). Update stale design documentation that still describes an injected overlay.

## TDD and tests

- Add failing tests first and record RED before production changes.
- Extend `tests/browser/quick-note.spec.ts` to prove:
  - opening the same draft again preserves the exact editor DOM node and unsaved text;
  - loading a different draft updates content in that same DOM node;
  - suspending/resuming for Activity preserves the node and content;
  - active-page context still updates sources without remounting.
- Strengthen `tests/design.test.ts` to assert coordinator integration, typed commands, absence of any tab-specific side-panel calls, and absence of the injection loader path.
- Add or update any narrow side-panel tests needed for command routing. Avoid regex-only coverage where a behavior can be exercised through existing browser fixtures.

## Verification

- `npx tsx --test tests/panel-coordinator.test.ts tests/design.test.ts`
- `npx playwright test tests/browser/quick-note.spec.ts --grep "mounted composer|same draft|different draft|Activity"`
- `npm run build && npm run check:bundle`
- `git diff --check` for touched files.
- Run `npx tsc -b --force --pretty false`, but report pre-existing shared-worktree diagnostics separately from task-scoped diagnostics.

Write the full report with RED/GREEN evidence and exact files changed to `.superpowers/sdd/persistent-composer/task-2-report.md`. Return only status, one-line test summary, and concerns.

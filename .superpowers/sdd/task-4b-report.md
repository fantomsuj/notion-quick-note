# Task 4 Phase B report: strict content surface

Status: **DONE_WITH_CONCERNS**

## Delivered

- Made `src/content.ts` strict-clean without suppression directives or blanket `any`.
- Replaced the old intersection-based composer element scaffold with a validated shadow-root template boundary and selector-specific DOM types.
- Added concrete popup, draft, recent-item, action, timer, editor, event, and extension-surface types.
- Typed the `chrome.runtime.onMessage` boundary as `unknown`, validated every content message variant, and ignored malformed messages safely.
- Preserved the legacy `TOGGLE_QUICK_NOTE` page shape by validating it and normalizing it to a complete `CaptureContext` before opening the composer.
- Routed content-to-worker requests through the correlated `sendRuntimeRequest` guard while preserving deadline and extension-context-loss recovery behavior.
- Narrowed runtime failures and unknown errors without optional-property guessing.
- Validated Tiptap `getJSON()` through the shared editor-node guard before persisting it.
- Typed editor callbacks, keyboard and clipboard events, AI action callbacks, node views, keyboard shortcuts, and dynamic toolbar commands.
- Integrated the concurrent panel-lifecycle terminal emitter for saved and discarded drafts.
- Fixed the concurrent side-panel discard response branch so a successful-but-not-discarded response does not read a failure-only `error` field.

## Diagnostic progression

- Initial forced typecheck: 331 diagnostics, all in `src/content.ts` (Phase A baseline).
- First typed boundary/scaffolding pass: 262 diagnostics.
- Function, DOM, runtime, editor, and AI typing pass: 22 content diagnostics.
- Final content pass: 0 diagnostics in `src/content.ts`.
- Fresh full forced typecheck: exit 0, zero project diagnostics.

## Files changed in Phase B

- `src/content.ts` — primary strict refactor and content-boundary validation.
- `types/globals.d.ts` — added the real injected runtime/installed globals and aligned optional composer-open context; concurrent panel lifecycle globals remain preserved.
- `src/contracts.ts` — exported the existing `isEditorNode` guard for boundary reuse and added the exact shared `NotionColorName` union required by the current contract type test.
- `sidepanel/sidepanel.ts` — minimal response-narrowing follow-up for the concurrent discard lifecycle.

## TDD / regression evidence

RED:

- `npx tsc -b --force --pretty false` reproduced the Phase B content-only baseline.
- The focused browser smoke initially failed because the strict content message guard rejected the established legacy page fixture without `version` and `capturedAt`.

GREEN:

- The boundary now validates the legacy fields and normalizes them to a complete `CaptureContext`.
- `npx playwright test tests/browser/quick-note.spec.ts --grep 'typing and player hotkeys stay inside Quick Note' --workers=1`: 1 passed.

## Final verification

- `npx tsc -b --force --pretty false`: exit 0.
- `npx tsx --test tests/runtime-message.test.ts tests/panel-lifecycle.test.ts`: 16 tests passed, 0 failed.
- `npm run build`: exit 0; background, options, sidepanel, and content bundles built.
- `git diff --check -- src/content.ts src/contracts.ts types/globals.d.ts sidepanel/sidepanel.ts`: exit 0.
- Suppression / blanket-any scan across the touched TypeScript surfaces: no matches.

## Concerns

- `src/content-loader.ts` and `tests/content-loader.test.ts` remain deleted by concurrent work, as recorded in Phase A. The requested content-loader focused test therefore could not be run.
- The production bundle builds successfully, but the separate `npm run check:bundle` gate currently reports `dist/content.js` at 458,122 bytes against the concurrently configured 450,000-byte budget.

## Review follow-up: discard and async lifecycle

Delivered:

- Made discard transactional on both composer entry points: only an explicit `{ ok: true, discarded: true }` completes the terminal lifecycle. Errors, malformed responses, timeouts, and `{ ok: true, discarded: false }` always call the rollback path, retain the mounted composer, and resume autosave.
- Added the shared, instance-aware `observeInstancePromise` / `reportAsyncFailure` boundary for promises launched by content-surface events. It handles extension context loss, restores AI busy/button state, and surfaces non-context errors without leaking an unhandled rejection.
- Routed settings/activity/save, discard, AI, recent-note, conflict, and reload event work through that observer.
- Made scheduled async callbacks observable by routing callback completion through the same rejection boundary.
- Replaced the broad composer-root DOM assertion with closed selector-to-concrete-constructor maps, eager template validation, and explicit optional/dynamic lookups.
- Deleted injected optional window globals during teardown instead of assigning `undefined`.
- Completed the required toolbar overflow and color-palette template elements already referenced by the concurrent wiring and styles.

RED:

- `npx playwright test tests/browser/quick-note.spec.ts --grep 'failed discard restores|event-launched runtime rejection' --workers=1`: 2 failed as expected before the fixes. Failed discard removed the composer without an error; the settings rejection surfaced visually but also reached the page-level unhandled-error collector.

GREEN:

- `npx playwright test tests/browser/quick-note.spec.ts --grep 'failed discard restores|event-launched runtime rejection' --workers=1`: 2 passed.
- `npx playwright test tests/browser/quick-note.spec.ts --grep 'selection toolbar uses|text and highlight palettes|toolbar toggles|toolbar menus preserve' --workers=1`: 4 passed.
- `npx tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --useUnknownInCatchVariables`: exit 0.
- `npx tsx --test tests/runtime-message.test.ts tests/panel-coordinator.test.ts tests/panel-lifecycle.test.ts`: 25 passed.
- `npm test`: 180 passed.
- `npm run build`: exit 0.

## Review re-check: concrete composer template validation

Delivered:

- Replaced the type-only `ComposerElements` and `ComposerLists` declarations with closed selector-to-constructor maps used at runtime.
- Added constructor-based singleton and list validators. `ComposerRoot` now eagerly validates the complete required template boundary, including non-empty lists and every list member's concrete class.
- Removed the unchecked `as unknown as` list conversion; lookup results now come from constructor-validated helpers.

RED:

- `npx playwright test tests/browser/quick-note.spec.ts --grep 'composer template validation rejects' --workers=1`: 2 failed before the fix because a `.page-title` rendered as `HTMLDivElement` and a `.format-menu [data-block]` list member rendered as `HTMLDivElement` both mounted without an error.

GREEN:

- The same malformed-template command: 2 passed after the runtime constructor maps and eager validation were added.
- `npx playwright test tests/browser/quick-note.spec.ts --grep 'composer template validation rejects|failed discard restores|event-launched runtime rejection|selection toolbar uses|text and highlight palettes|toolbar toggles|toolbar menus preserve' --workers=1`: 8 passed.
- `npx tsc -b tsconfig.extension.json --force --pretty false`: exit 0.
- Focused forced strict content compilation with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`: exit 0.
- `npm run build`: exit 0.
- `git diff --check -- src/content.ts tests/browser/quick-note.spec.ts`: exit 0.

## Final review: correlated background dispatch

Delivered:

- `GET_QUICK_SETTINGS` now returns `{ ok: true, ...quickSettings }`, matching the guarded client and `RuntimeResponseMap` contract.
- `RETRY_CAPTURE`, `RETARGET_CAPTURE`, and `MARK_CAPTURE_DELIVERED` now require a real `CaptureRecord`; a null queue result throws and is converted by the runtime listener into a structured failure.
- Added a shared, exported `validatedRuntimeResponse` boundary. Every dispatcher case is exhaustively switched and its result is checked against the request-specific runtime response guard before `sendResponse` receives it.
- Added correlated response helpers with no unsafe casts and focused tests for settings, all three capture mutations, null records, and malformed request-specific successes.

RED:

- `npx tsx --test tests/background-dispatch.test.ts`: failed with `ERR_MODULE_NOT_FOUND` before the correlated dispatch boundary existed.

GREEN:

- `npx tsx --test tests/background-dispatch.test.ts tests/runtime-message.test.ts`: 14 passed.
- `npx tsc -b tsconfig.extension.json --force --pretty false`: exit 0.
- `npm run build && npm run check:bundle`: exit 0; content bundle 449,902 / 450,000 bytes.
- `npx playwright test tests/browser/quick-note.spec.ts --grep 'setup status refreshes while the composer remains open' --workers=1`: 1 passed.
- `npm test`: 183 passed; one concurrent settings test failed because `normalizeSettings` had not yet been exported by its owning task.
- `git diff --check -- src/background.ts src/background-dispatch.ts tests/background-dispatch.test.ts`: exit 0.

No files were committed, staged, restored, reset, or checked out.

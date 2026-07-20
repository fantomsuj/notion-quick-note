# Task 3 report: Balanced selection toolbar and focus treatment

## Delivered

- Exported the exact `NotionColorName` union: `default`, gray, brown, orange, yellow, green, blue, purple, pink, and red.
- Replaced the selection bubble with the Balanced primary hierarchy: Text, Link, Bold, Italic, Underline, More formatting.
- Moved Strikethrough and Inline code into the overflow beside Text color and Highlight.
- Replaced punctuation affordances with inline SVG treatment while retaining conventional B/I/U typography.
- Added accessible overflow and palette menus with `aria-pressed`, `aria-haspopup`, `aria-expanded`, `aria-checked`, Escape/focus return, outside-click dismissal, and selection-safe commands.
- Added all ten text/highlight choices. Text stores base names, Highlight stores `<name>_background`, either mode replaces the other, and Default removes `notionColor`.
- Added distinct light/dark text and background tokens and rendering for all persisted Notion colors.
- Kept the toolbar and menus inside a 320px sheet.
- Added a neutral rounded `.page-title:focus-visible` override after the global blue focus rule while retaining blue keyboard focus on controls.
- Preserved the mounted-composer/discard lifecycle. Rejected discards reconcile through `GET_PANEL_DRAFT`; `draft_not_found` terminally disposes, while retained drafts resume autosave and surface the error.
- Restored empty slash-query handling exposed by the complete composer run.
- Kept the production content bundle below its unchanged 450,000-byte budget through compact typed DOM validation, delegated toolbar events, explicit editor extensions, and a composer-scoped response-envelope check. The shared comprehensive response validator remains available and covered in `src/runtime-message.ts`/contract tests.

## TDD evidence

Tests were added before the Task 3 production implementation.

Initial RED evidence:

- `node --import tsx --test --test-name-pattern "composer defines distinct|title overrides" tests/design.test.ts`
  - RED: 0/2 passed.
  - Expected failures: missing `--nqn-notion-gray`/the complete color token set and missing post-global `.page-title:focus-visible` override.
- `npm run typecheck`
  - RED included the expected missing `NotionColorName` export/type equality failure.
- `npm run build && npx playwright test tests/browser/quick-note.spec.ts --grep "selection toolbar uses|toolbar toggles expose|text and highlight palettes|toolbar menus preserve" --workers=1 --reporter=line`
  - The first RED run was blocked at composer mounting by a pre-existing shared ordering regression (`asComposerRoot` ran before template insertion). The coordinator authorized the minimal order prerequisite; it was corrected without undoing mounted lifecycle work.
  - Subsequent feature RED/iteration evidence exercised missing/incorrect hierarchy and menus, transient 320px overflow, overflow command state behavior, and title/control focus treatment. The final focused feature run passed 4/4.

## Verification

Fresh scoped/final results:

- `npx playwright test tests/browser/quick-note.spec.ts --grep "selection toolbar uses|toolbar toggles expose|text and highlight palettes|toolbar menus preserve|discard runtime rejection" --workers=1 --reporter=line`
  - PASS: 6/6.
- Final controller focused set after concurrent strict-validator reconciliation
  - PASS: 11/11, including concrete-class template validation, toolbar/palettes/keyboard behavior, discard rejection reconciliation, slash behavior, and the timeout fixture path.
- `node --import tsx --test --test-name-pattern "composer defines distinct|title overrides" tests/design.test.ts`
  - PASS: 2/2.
- `node --import tsx --test tests/design.test.ts`
  - PASS: 15/15.
- `npm test`
  - PASS: 180/180.
- `npx playwright test tests/browser/quick-note.spec.ts --grep-invert "runtime-message hang" --workers=1 --reporter=line`
  - PASS: 50/50.
  - The excluded timeout test initially exposed a fixture regression: `GET_CAPTURE_STATUS` returned a delivered record even when `window.captureStatus` was null. The coordinator corrected the fixture to return `{ ok: true, record: null }`; its final targeted check is included in the 11/11 controller result.
- `npm run build && npm run check:bundle`
  - PASS.
  - Final controller measurement: `449,413 / 450,000` bytes.
- `git diff --check`
  - PASS.

Repository-wide typecheck:

- `npm run typecheck`
  - Nonzero during final verification because of concurrent strict-migration work in browser fixtures/specs and capture tests outside Task 3.
  - The recorded run returned exit 2 with 338 diagnostics across `tests/browser/mv3-extension.spec.ts`, `tests/browser/quick-note.spec.ts`, `tests/browser/visuals.spec.ts`, `tests/capture-persistence.test.ts`, `tests/capture-queue.test.ts`, `tests/capture-store.test.ts`, and `tests/fixtures/mv3-worker-harness.ts`.
  - Task 3 does not claim a repository-wide green typecheck.

## Task 3 file list

- `src/content.ts`
- `src/contracts.ts`
- `styles/composer.css`
- `styles/tokens.css`
- `tests/browser/quick-note.spec.ts`
- `tests/design.test.ts`
- `tests/types/contracts.test-d.ts`
- `tests/fixtures/media-page.html` (shared timeout/discard verification fixture reconciliation)
- `.superpowers/sdd/persistent-composer/task-3-report.md`

## Concerns

- Bundle headroom is narrow: 587 bytes below the production limit. Future composer runtime additions should include a bundle check early.
- The repository-wide strict migration remains active and currently prevents a clean full typecheck; the scoped runtime, browser, design, node, build, bundle, and diff checks above are the evidence claimed here.
- The shared dirty worktree contains substantial unrelated user/agent work. No files were staged, committed, reset, restored, checked out, or branch-renamed by Task 3.

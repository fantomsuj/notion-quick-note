# Task 2 Report: Wire restricted-page notification

## Outcome

Delivered in the combined restored-composer and native-notification commit `e00cdf8` (`Restore in-page composer and add unavailable notifications`). The implementation replaces the old Side Panel surface with an injected in-page composer, and every restricted-page failure now preserves its badge/title feedback while also showing the native unavailable notification.

## Committed files

- Runtime and extension configuration: `manifest.json`, `src/background.ts`, `src/content.ts`, `src/content-loader.ts`, `src/contracts.ts`, `src/runtime-message.ts`, `src/diagnostics.ts`, `src/serialized-operation-queue.ts`, `types/globals.d.ts`, `tsconfig.extension.json`.
- Removed Side Panel runtime: `sidepanel/index.html`, `sidepanel/sidepanel.css`, `sidepanel/sidepanel.ts`, `src/panel-coordinator.ts`, `src/panel-lifecycle.ts`.
- Settings and release/build wiring: `options/options.css`, `options/options.html`, `options/options.ts`, `scripts/build.ts`, `scripts/check-bundle-size.ts`, `scripts/check-release.ts`, `scripts/release-files.ts`.
- Tests and fixtures: `tests/content-loader.test.ts`, `tests/diagnostics.test.ts`, `tests/serialized-operation-queue.test.ts`, `tests/design.test.ts`, `tests/browser/fixture-globals.d.ts`, `tests/browser/mv3-extension.spec.ts`, `tests/browser/quick-note.spec.ts`, `tests/fixtures/media-page.html`, `tests/fixtures/mv3-manifest.json`, `tests/capture-store.test.ts`, `tests/runtime-message.test.ts`, `tests/settings.test.ts`, `tests/types/contracts.test-d.ts`, updated onboarding snapshots, and removed Side Panel unit tests.
- Documentation: `README.md`, `PRIVACY.md`, `docs/PRODUCT.md`, `docs/RELEASE.md`, `docs/STORE_LISTING.md`, `docs/VISUAL_GUIDE.md`.

Task 2-specific files within that scope:

- `manifest.json` — declares the MV3 `notifications` permission.
- `src/background.ts` — imports `createUnavailableNotice`, creates it with `chrome.notifications`, and awaits it together with the existing unavailable badge/title updates.
- `scripts/check-release.ts` — requires `notifications` in the reviewed permission set.
- `tests/design.test.ts` — requires the permission and static worker notifier wiring.

## TDD evidence

### RED

1. Added the release permission expectation and static design expectations before production wiring.
2. `npm run check:release && npm test -- --test-name-pattern='Quick Note injects its composer'`
   - Failed at `scripts/check-release.ts:46` because the manifest lacked `notifications`.
3. `npm test -- --test-name-pattern='Quick Note injects its composer'`
   - Failed in the selected design test because the manifest lacked `notifications` (and the notifier wiring was not yet present).

### GREEN

1. Added `notifications` to the manifest.
2. Wired `createUnavailableNotice(chrome.notifications)` into `markOverlayUnavailable` and included it in the awaited `Promise.all` with the prior badge/title calls.
3. `npm run check:release && npm test -- --test-name-pattern='native unavailable notification|Quick Note injects its composer'`
   - Passed: release audit passed; 186 tests passed, 0 failed.
4. `npm run typecheck && npm test`
   - Passed: typecheck clean; 186 tests passed, 0 failed.
5. `npm run check`
   - Passed: typecheck, build, bundle check, release audit, 186 unit tests, and 69 Playwright browser tests all passed. Bundle size was 449,584 / 450,000 bytes.

## Commit

`e00cdf8` — `Restore in-page composer and add unavailable notifications`

## Self-review

- The notifier is constructed once from `chrome.notifications`.
- Every existing unavailable path reaches `markOverlayUnavailable`, which now retains its badge and title behavior while awaiting the native notification.
- The helper already absorbs notification API failures, so a notification rejection does not prevent the badge/title updates from resolving.
- The manifest permission and release/design expectations agree.
- The complete injected-composer restoration was committed with the notification wiring because `markOverlayUnavailable` is an integral part of that worker replacement.
- Staged-diff whitespace validation (`git diff --cached --check`) passed before committing.
- `.superpowers` artifacts and the untracked design-plan document were intentionally excluded from the commit.

## Privacy review follow-up: native notification payload

### Files changed

- `src/unavailable-notice.ts` — the Chrome notification message is now fixed safe copy and deliberately ignores its caller-provided detail. The caller contract and native notification ID/title remain unchanged.
- `tests/unavailable-notice.test.ts` — adds a regression using a URL, selection-like text, and credential-like values, proving none can enter the notification payload; updates the existing payload expectation to the fixed copy.
- `.superpowers/sdd/task-2-report.md` — this review record.

### RED evidence

`npm test -- --test-name-pattern='never includes caller-provided page details'`

- Exit 1: the new test failed as intended. Its payload contained `https://example.test/private?token=super-secret; selection: personal note; password=hunter2` where the expected fixed safe copy belonged.

### GREEN evidence

1. `npx tsx --test tests/unavailable-notice.test.ts`
   - Exit 0; 3 tests passed, 0 failed.
2. `npm test`
   - Exit 0; 187 tests passed, 0 failed.

### Self-review

- `markOverlayUnavailable` still makes the same badge text, badge color, and action-title calls with the detailed error; this change only constrains the native `chrome.notifications` payload.
- The notification title and stable tab-derived notification ID are preserved.
- The helper accepts the existing `detail` argument for callers but cannot place it in the notification payload.
- Scoped code/test diff has no whitespace errors. The workspace-wide `git diff --check` reports pre-existing blank-line warnings in `.superpowers/sdd/task-1-brief.md` and `.superpowers/sdd/task-2-brief.md`, outside this follow-up's files.

### Commit

`a8367d8` — `Prevent unsafe unavailable notification details`

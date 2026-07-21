# Task 1 — Native restricted-page notice helper

## Delivered

- Added `createUnavailableNotice`, an injected native-notification helper.
- It uses `notion-quick-note-unavailable-${tabId}` as the stable notification ID and the specified icon, title, and caller-provided detail.
- Notification failures are swallowed so the returned promise always resolves.

## TDD evidence

### RED

Command:

```sh
npm test -- --test-name-pattern='native unavailable notification'
```

Result: failed as expected with `ERR_MODULE_NOT_FOUND` for `src/unavailable-notice.js`, before the production helper existed (`184` passing, `1` failing test file).

### GREEN

Commands:

```sh
npm test -- --test-name-pattern='native unavailable notification'
npx tsx --test tests/unavailable-notice.test.ts
npm test
```

Results:

- Requested focused command passed; the matching native-notification test passed.
- Direct helper test run: `2` passing, `0` failing.
- Full unit suite: `186` passing, `0` failing.

## Changed files

- `src/unavailable-notice.ts`
- `tests/unavailable-notice.test.ts`
- `.superpowers/sdd/task-1-report.md`

## Self-review

- The dependency is injected through the narrow requested `chrome.notifications.create` pick.
- The emitted ID and all notification options exactly match the task brief.
- Both the success behavior and rejected-notification resolution behavior are covered.
- No manifest or background-worker files were modified.
- `git diff --check -- src/unavailable-notice.ts tests/unavailable-notice.test.ts` completed without whitespace errors.

## Commit

Pending commit hash; updated immediately after creating the task-only commit.

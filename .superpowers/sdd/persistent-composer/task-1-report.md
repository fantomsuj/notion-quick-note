# Task 1 implementation report: typed window-scoped panel coordinator

## Status

Implemented the reusable typed panel coordinator and focused tests. No integration changes were made to `src/background.ts`.

## Delivered behavior

- Added typed panel-to-worker registration, worker-to-panel navigation, and worker-to-panel active-page context messages.
- Added `isPanelRegistrationMessage`, which accepts only `REGISTER_PANEL` messages with non-negative integer `windowId` values.
- Added a dependency-light coordinator over a minimal `PanelPort.postMessage` interface.
- The coordinator keeps one current port per window, exposes `has(windowId)`, retains only the latest unserved navigation, flushes it once, sends live navigation immediately, and never queues context.
- A throwing port is removed only if it is still the exact registered port. Failed navigation remains queued; failed context is dropped. Stale unregister calls do not remove replacements.

## TDD evidence

### RED

Tests and type assertions were added before implementation.

Command:

```text
npx tsx --test tests/panel-coordinator.test.ts
```

Result: exit 1, expected missing-feature failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/panel-coordinator.js'
# tests 1
# pass 0
# fail 1
```

The pre-implementation `npx tsc -b --force --pretty false` also exited 2 and specifically reported the missing panel contract exports and missing `src/panel-coordinator.ts`, in addition to the shared worktree's existing unrelated TypeScript errors.

### GREEN

Command:

```text
npx tsx --test tests/panel-coordinator.test.ts
```

Result: exit 0:

```text
# tests 9
# pass 9
# fail 0
```

The nine behavioral tests cover registration validation, one-port replacement, `has`, latest-only navigation queuing, exactly-once flushing, immediate navigation, non-queued context, failed navigation (including a failed queued flush), failed context, and stale-port unregister safety.

## Required verification

- `npx tsx --test tests/panel-coordinator.test.ts`: PASS, 9/9 tests.
- `npx tsc -b --force --pretty false`: BLOCKED by the pre-existing/shared dirty worktree; exit 2 with 579 lines of diagnostic output across unrelated in-progress files such as `options/options.ts`, `src/background.ts`, and `src/content.ts`. The output also includes the existing `tests/types/contracts.test-d.ts:31` QuickSettings assertion, which was already stale relative to the shared `src/contracts.ts` edits. Filtered diagnostics contain no errors in the new coordinator, behavioral tests, or newly added panel type assertions.
- `git diff --check -- src/contracts.ts src/panel-coordinator.ts tests/panel-coordinator.test.ts tests/types/contracts.test-d.ts`: PASS, exit 0 with no output.

## Exact files changed

- `src/contracts.ts` — added panel message types/unions and the registration guard; preserved all pre-existing edits in this already-modified file.
- `src/panel-coordinator.ts` — added the coordinator and minimal port interface.
- `tests/panel-coordinator.test.ts` — added focused behavioral coverage.
- `tests/types/contracts.test-d.ts` — added panel contract equality, narrowing, and invalid-assignment assertions; preserved its existing assertions.
- `.superpowers/sdd/persistent-composer/task-1-report.md` — this report.

## Concerns

- Repository-wide type verification cannot be green until the unrelated shared-worktree TypeScript failures are resolved by their owning workstreams.
- The shared worktree contains concurrent, uncommitted background/side-panel integration. This task deliberately did not modify or reconcile that integration.

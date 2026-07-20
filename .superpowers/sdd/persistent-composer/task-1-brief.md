# Task 1: Typed window-scoped panel coordinator

Implement only the reusable coordinator and its focused tests. Do not integrate it into `src/background.ts` yet.

## Requirements

- Add typed internal panel messages in `src/contracts.ts`:
  - panel to worker: `{ type: "REGISTER_PANEL"; windowId: number }`
  - worker to panel navigation: `{ type: "SHOW_COMPOSER"; draftId?: string; tabId?: number }` and `{ type: "SHOW_ACTIVITY" }`
  - worker to panel context: `{ type: "ACTIVE_PAGE_CONTEXT"; tabId: number; page: CaptureContext }`
- Export discriminated unions and a guard for the registration message. The guard must reject non-integer or negative window IDs.
- Create `src/panel-coordinator.ts` with a dependency-light coordinator that operates on a minimal port interface exposing `postMessage`.
- Coordinator behavior:
  - Keep at most one registered port per `windowId`.
  - Queue only the latest navigation command while no port is registered.
  - Flush a queued navigation command exactly once when a port registers.
  - Deliver navigation commands immediately when a port is registered.
  - Deliver active-page context only to a currently registered port; do not queue it.
  - If `postMessage` throws, unregister that exact port. Queue the failed navigation command, but drop failed context messages.
  - An unregister request for a stale/replaced port must not remove the current port.
  - Expose a read-only `has(windowId)` check for background event filtering.
- Add focused behavioral tests in `tests/panel-coordinator.test.ts` covering every behavior above and type assertions in `tests/types/contracts.test-d.ts`.
- Follow TDD: add tests, run them and record the expected RED failure, then implement and run GREEN.
- Do not modify unrelated files, stage, commit, reset, restore, or rewrite existing user changes.

## Verification

- `npx tsx --test tests/panel-coordinator.test.ts`
- `npx tsc -b --force --pretty false`
- `git diff --check -- src/contracts.ts src/panel-coordinator.ts tests/panel-coordinator.test.ts tests/types/contracts.test-d.ts`

Write the full implementation report, including RED/GREEN evidence and exact files changed, to `.superpowers/sdd/persistent-composer/task-1-report.md`. Return only status, a one-line test summary, and concerns.

# Task 4 Phase A report: typed runtime protocol and non-content extension surfaces

Status: **DONE_WITH_CONCERNS**

## Delivered

- Removed Task 4 suppressions from the extension surfaces and focused runtime test.
- Aligned the runtime protocol with handled and sent messages, including `LOAD_NOTION_PAGE`, optional `OPEN_CAPTURE_RESULT.url`, recent-note fields, panel-era additions already present in the working tree, and correlated response shapes.
- Added typed `MESSAGE_TYPES`, exhaustive request and response switches, and boundary validation for requests, Chrome responses, drafts, editor documents, capture contexts, destinations, remote targets, activity records, recent items, diagnostics, and exports.
- Changed `sendRuntimeRequest` to receive Chrome data as `unknown` and accept it only after correlated response validation.
- Typed background dispatch, Chrome callbacks, panel ports, initialization, timers, settings/provisioning adapters, Notion result normalization, recovery/diagnostic shapes, DOM access in options and sidepanel, custom globals, and focused test fixtures.
- Preserved the concurrent shortcut settings behavior in `options/options.ts` and the current background/panel behavior.

## TDD evidence

RED 1:

`npx tsc -b --force --pretty false`

- Exit 2 after suppression removal.
- Diagnostics covered untyped DOM queries, callbacks, timers, error boundaries, runtime protocol gaps, and test fixtures.

RED 2:

`npx tsx --test tests/runtime-message.test.ts`

- Exit 1 after adding negative nested-payload tests.
- The new malformed-context assertion failed because the old guard returned `true`.

GREEN:

`npx tsx --test tests/runtime-message.test.ts`

- Exit 0; 5 tests passed, including malformed nested document/draft/context/destination/remote checks and timeout reconciliation.

The requested `tests/content-loader.test.ts` focused test could not be rerun at handoff because concurrent work deleted both `src/content-loader.ts` and `tests/content-loader.test.ts` from the shared worktree after they had been typed. Those deletions were preserved rather than overwritten.

## Verification

- Filtered forced typecheck for `src/contracts.ts`, `src/runtime-message.ts`, `src/background.ts`, `options/options.ts`, `sidepanel/sidepanel.ts`, `types/globals.d.ts`, and `tests/runtime-message.test.ts`: no diagnostics.
- `npm run build`: exit 0; background, options, sidepanel, and content bundles built.
- Full forced typecheck remains RED: `total_errors=331`, all in `src/content.ts` at the final count after the correlated contract type test was repaired.

## Remaining concern / Phase B

`src/content.ts` still needs the dedicated strict-surface pass. Its suppression is removed and initial `PopupInstance`/composer/editor type scaffolding is present, but its callbacks, DOM helper adoption, custom message guards, storage/runtime response handling, event typing, timers, and editor extension hooks are not complete. A fresh implementer should continue that file before Task 4 can be called fully done.

No files were committed, staged, restored, reset, or checked out.

## Phase A review fixes — 2026-07-20

Status: **DONE**

Review findings were addressed with another RED/GREEN cycle:

- Added an explicit `DisconnectConfirmationResponse` control-flow variant: `{ ok: false, requiresConfirmation: true, pendingCount: number }`. It no longer masquerades as an error, and the correlated response guard plus `sendRuntimeRequest` accept and preserve it for the options confirmation flow.
- Made delete response correlation exact: `DELETE_CAPTURE` requires a boolean `deleted`; `DELETE_DELIVERED_HISTORY` requires a non-negative integer `deleted`.
- Tightened capture-status validation to require and validate `lastError` and `destination`, in addition to every other declared field.
- Tightened activity capture validation across the complete `CaptureRecordBase`, nested capture payloads/documents/context/destination/remote/journal fields, numeric/boolean fields, and delivery-state-specific `deliveredAt`, `lastError`, and `remote` invariants.
- Expanded request-negative coverage across all required ID, session, capture, remote, format, fallback, status-identity, and destination payloads.
- Added direct correlated-response and `sendRuntimeRequest` tests for the disconnect control response and malformed Chrome responses.
- Updated options and sidepanel failure narrowing for the new non-error control response.

Review RED:

`npx tsx --test tests/runtime-message.test.ts`

- Exit 1; 6 passed and 3 failed.
- Failures showed that the disconnect confirmation was rejected, delete success without `deleted` was accepted, and the sender rejected/accepted those malformed correlations incorrectly.

Review GREEN:

`npx tsx --test tests/runtime-message.test.ts`

- Exit 0; 9 tests passed.

Type verification after the fixes:

`npx tsc -b --force --pretty false`

- Initial expected Phase B result: 331 diagnostics, all 331 in `src/content.ts`; zero diagnostics elsewhere.
- Final verification after concurrent Phase B work landed: exit 0 with zero diagnostics across the full project.

A concurrent panel-coordinator edit introduced an `await` inside a non-async `createDraft` callback in `src/background.ts`. The callback was repaired by loading `includeSource` immediately before constructing it; no panel behavior was removed.

A concurrent generic panel-lifecycle integration initially widened `routeShowComposer` to `DraftIdentity` at its sidepanel call site. Supplying the existing `CaptureDraft` type argument restored the full draft correlation without changing lifecycle behavior.

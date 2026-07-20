# Task 1 report: strict domain, persistence, and queue core

Status: DONE

## Files changed

- `src/contracts.ts`
- `src/capture-store.ts`
- `src/capture-indexed-db.ts`
- `src/capture-key-store.ts`
- `src/capture-record-repository.ts`
- `src/capture-persistence.ts`
- `src/capture-queue.ts`
- `src/capture-export.ts`
- `tests/types/contracts.test-d.ts`

No index operations, commits, restores, or checkouts were performed. The staged index was inspected at the end and remained empty/unchanged. Existing untracked `.superpowers/` and `docs/superpowers/` content was left in place; this report is the only required task artifact added under `.superpowers/`.

## Type design

### Normalized domain

- Expanded the canonical draft and capture models to match the persisted v2 record graph actually used by delivery and editing: capture/synced/pending payloads, operation, scope, context, destination snapshot, attempt timestamps, retry flags, remote identity, edit fingerprint, sync journal, and import provenance.
- Modeled `CaptureRecord` as a discriminated union:
  - `pending` and `sending` have `deliveredAt: 0`, nullable error metadata, and a nullable remote.
  - `delivered` requires a `RemoteTarget`, has numeric `deliveredAt`, and has `lastError: null`.
  - blocked/uncertain terminal states require `DeliveryErrorMetadata`, have `deliveredAt: 0`, and retain a nullable remote.
- Added the capture payload, destination snapshot, storage metadata, clock, UUID, backend transaction, backend, change event, and change handler types needed by the core.
- Extended error-kind coverage to the concrete queue classifications already emitted by the application.

### Unknown-first persistence boundaries

- All legacy graph, keyed storage, and IndexedDB reads begin as `unknown`.
- Persisted values are narrowed with `isRecord`, array checks, primitive field guards, literal-union guards, and recursive editor/JSON normalization.
- `normalizeDraft`, `normalizeRecord`, context/payload/source/remote/error normalization, metadata normalization, and editor node normalization produce canonical typed values before repository code consumes data.
- Corrupt/unsupported state continues to fail closed, and v1/v2 migration fallbacks are preserved.
- No `@ts-nocheck`, `@ts-ignore`, explicit `any`, or unchecked type assertions remain in the Task 1 files.

### Typed persistence and repository ports

- IndexedDB requests and session-key values are normalized at adapter boundaries into typed backend transactions.
- Record-repository transactions are generic and typed; quota/error boundaries narrow `unknown` errors before reading fields.
- Persistence delegation now exposes explicit typed methods instead of indexing repositories by untyped method-name strings. Legacy fallbacks for metadata, maintenance, logical size, and imports remain intact.
- Change callbacks use discriminated `CaptureChangeEvent` values and typed handlers.

### Queue and recovery behavior

- Queue configuration, connections, delivery callbacks, retry updates, error classification, and remote results are typed.
- Queue attempt dispatch handles every delivery-state variant and uses `assertNever` for exhaustiveness.
- Retrying without setup now supplies the required typed setup error rather than constructing an invalid blocked record with `lastError: null`.
- Remote delivery responses begin as `unknown` and are normalized into a complete `RemoteTarget` before the delivered transition.
- Recovery export inputs are normalized before grouping/rendering; recursive JSON sanitization remains in place, and Markdown rendering operates on typed editor nodes.

## TDD and verification

The controller supplied the required RED evidence by removing suppressions in a disposable copy and confirming Task 1 strict diagnostics. In the real workspace, the seven production suppressions were removed and the initial strict run reproduced the expected failure surface (478 diagnostics across Task 1 files). Implementation then proceeded to GREEN without adding suppressions or broad casts.

Commands run:

1. `npx tsc -b --force --pretty false`
   - Initial result after suppression removal: failed with the expected Task 1 strict diagnostics.
   - Final result: exit 0, no diagnostics.
2. `npx tsx --test tests/types/contracts.test-d.ts tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts tests/capture-export.test.ts`
   - First result: 33 behavioral tests passed; the declaration-only `.test-d.ts` fixture failed at runtime because `void repository` referenced a `declare`d-only symbol.
   - The fixture was changed to a purely type-level alias.
   - Final result: 34 tests passed, 0 failed.
3. Final combined verification: focused test command followed by `npx tsc -b --force --pretty false`
   - Exit 0; 34/34 focused tests passed and the compiler emitted no diagnostics.
4. `git diff --check`
   - Exit 0; no whitespace errors.
5. Task-file scan for `@ts-nocheck`, `@ts-ignore`, explicit `any`, and unchecked `as` assertions
   - No matches other than ordinary English use of “as” in an existing compatibility comment.

## Concerns

No known blocking concerns. Normalization now materializes canonical defaults for legacy partial records (including a typed error for terminal states and an empty-but-typed remote for legacy delivered records lacking remote identity); the focused migration, queue, export, and persistence tests cover the existing recovery behavior and all pass.

## Review follow-up: version gates and remote identity

Two Important review findings were addressed with new regressions in `tests/capture-store.test.ts` and `tests/capture-queue.test.ts`:

- `normalizeDraft` and `normalizeRecord` now reject explicit unsupported item versions instead of coercing them to v2. Legacy items with no version and known v1 items remain accepted and migrate to v2. Legacy graph, IndexedDB, keyed-storage, repository, and export boundaries filter rejected items rather than re-persisting them as current records.
- Delivery results must contain a non-empty remote `id` or `pageId` before `markDelivered` can transition state. Invalid delivery output throws inside the queue attempt, is caught by the existing delivery-failure path, and becomes a managed retry (or the corresponding manual ambiguous state) rather than a delivered record.
- The type fixture now also asserts terminal `lastError` metadata and the `getCapture`/`updateCapture` repository return signatures.

### Follow-up RED evidence

Command:

`npx tsx --test tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts`

Result before implementation: exit 1, 34 tests total, 32 passed, 2 failed.

- `unsupported explicit draft and capture versions are rejected instead of rewritten as v2` failed because `normalizeDraft({ version: 999, ... })` returned a normalized v2 draft instead of `null`.
- `malformed remote delivery results stay queued instead of becoming delivered` failed because a delivery callback returning `{}` produced status `delivered` instead of `pending`.

The legacy compatibility test (`missing-version and known v1 persisted items still migrate to v2`) already passed during RED, confirming the regression target did not require dropping known historical shapes.

### Follow-up GREEN evidence

Covering test command:

`npx tsx --test tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts`

Result after implementation: exit 0, 34/34 tests passed, 0 failed.

Final compiler and expanded covering command:

`npx tsc -b --force --pretty false && npx tsx --test tests/types/contracts.test-d.ts tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts`

Result: exit 0, compiler emitted no diagnostics, 35/35 tests passed, 0 failed.

Follow-up `git diff --check`: exit 0. No Git index operation was performed.

## Second review follow-up: record-shaped legacy input and verification guards

The remaining two Important findings were addressed with additional regressions:

- Missing-version compatibility now starts only after `isRecord` succeeds. `null`, primitives, and arrays return `null` from `normalizeDraft`/`normalizeRecord` and are filtered from persisted state. Record-shaped missing-version and known v1 items continue to migrate to v2.
- `findExisting` verification output must contain a non-empty `id` or `pageId` before it can enter `markDelivered`. Malformed verification output falls through to the already-classified retry/manual update, so a claimed capture cannot remain `sending` or become `delivered` from invalid evidence.

### Second-loop RED evidence

Command:

`npx tsx --test tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts`

Result before implementation: exit 1, 36 tests total, 34 passed, 2 failed.

- `non-record persisted draft and capture entries fail closed` failed because `normalizeDraft(null)` returned a canonical empty v2 draft instead of `null`.
- `malformed verification results cannot strand a claimed capture in sending` failed with actual status `sending` instead of expected `pending` after malformed `{}` verification output.
- The record-shaped compatibility test for missing-version/v1 entries continued to pass during RED.

### Second-loop GREEN evidence

Covering test command:

`npx tsx --test tests/capture-store.test.ts tests/capture-persistence.test.ts tests/capture-queue.test.ts`

Result after implementation: exit 0, 36/36 tests passed, 0 failed.

Compiler command:

`npx tsc -b --force --pretty false`

Result: exit 0, no diagnostics.

No Git index operation was performed.

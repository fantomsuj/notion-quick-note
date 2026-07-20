### Task 1: Strict domain, persistence, and queue core

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/capture-store.ts`
- Modify: `src/capture-indexed-db.ts`
- Modify: `src/capture-key-store.ts`
- Modify: `src/capture-record-repository.ts`
- Modify: `src/capture-persistence.ts`
- Modify: `src/capture-queue.ts`
- Modify: `src/capture-export.ts`
- Test: `tests/types/contracts.test-d.ts`
- Test: `tests/capture-store.test.ts`
- Test: `tests/capture-persistence.test.ts`
- Test: `tests/capture-queue.test.ts`
- Test: `tests/capture-export.test.ts`

**Interfaces:**
- Consumes: existing storage versions, repository semantics, delivery state transitions, and recovery formats.
- Produces: strict normalized domain types; typed storage, IndexedDB, repository, delivery, clock, UUID, and change-handler ports used by all later tasks.

- [ ] **Step 1: Expose the compiler failures**

Remove `// @ts-nocheck` from the task's production files and run `npx tsc -b --force --pretty false`. Expected: failure in these files, proving the strict gate covers them.

- [ ] **Step 2: Type normalized boundaries and ports**

Use `unknown` for persisted input and narrow it with `isRecord` plus field guards. Model drafts, records, metadata, repository methods, backend transactions, storage adapters, clock/UUID functions, and change events explicitly. Preserve migration fallbacks and return types; do not replace boundary values with unchecked casts.

- [ ] **Step 3: Tighten discriminated state contracts**

Ensure delivered records require a remote target and non-delivered terminal states require typed error metadata. Make repository/queue transitions return `CaptureRecord` variants and use exhaustive switches or `assertNever` for state-dependent behavior.

- [ ] **Step 4: Verify the core**

Run `npx tsc -b --force --pretty false` and the five listed test files through `tsx --test`. Expected: no task-file type diagnostics and all focused tests pass.

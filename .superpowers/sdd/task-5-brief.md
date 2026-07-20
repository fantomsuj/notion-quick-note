### Task 5: Strict tests, Playwright, and MV3 fixture harness

**Files:**
- Modify: `tests/*.test.ts`
- Modify: `tests/browser/*.spec.ts`
- Modify: `tests/fixtures/mv3-worker-entry.ts`
- Modify: `tests/fixtures/mv3-worker-harness.ts`
- Modify: `playwright.config.ts` if required by strict test types

**Interfaces:**
- Consumes: strict production exports and typed dependency ports.
- Produces: strictly checked unit/browser tests and a bundled fixture checkpoint API.

- [ ] **Step 1: Enable strict checking for every test**

Remove all remaining `// @ts-nocheck` directives. Type test doubles against the production ports, define small fixture-specific interfaces for partial Chrome/Worker objects, and narrow caught errors with assertion helpers.

- [ ] **Step 2: Preserve the MV3 fixture contract**

Keep `tests/fixtures/mv3-worker-entry.ts` as the esbuild fixture entry and type the optional service-worker checkpoint hook in `types/globals.d.ts` or a fixture-local global declaration.

- [ ] **Step 3: Verify strict test compilation and unit behavior**

Run `npx tsc -b --force --pretty false` and `npm test`. Expected: zero diagnostics and at least 130 passing tests.

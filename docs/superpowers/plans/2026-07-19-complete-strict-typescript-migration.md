# Complete Strict TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing TypeScript migration so every authored `.ts` file is genuinely checked under the repository's strict compiler settings, all external data is validated before mutation, and the complete release pipeline passes.

**Architecture:** Keep the existing esbuild output topology and ESM `.js` import specifiers. Replace suppression with explicit domain types and narrow ports from the inside out: storage/repository primitives first, then Notion and OAuth boundaries, then extension surfaces, then tests and browser fixtures. Treat `unknown` as the boundary type and narrow it with handwritten guards; use focused `type`/`interface` declarations for normalized in-memory objects and test doubles.

**Tech Stack:** TypeScript 7.0.2, tsx 4.23.1, esbuild 0.28.1, Node 20 typings, Chrome 116 typings, Cloudflare Worker typings, Node test runner, Playwright.

## Global Constraints

- Preserve all user-visible behavior, storage keys, migrations, Notion/OAuth wire routes, manifest permissions, Chrome 116 compatibility, and MV3 CSP.
- Keep `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and exhaustive discriminated-union handling enabled.
- Do not use `// @ts-nocheck`, `allowJs`, or tracked authored `.js`/`.mjs` source files.
- Keep ESM `.js` import specifiers in TypeScript source.
- Keep `dist/` and release artifacts ignored; do not commit generated JavaScript, declarations, TypeScript build metadata, or source maps.
- Keep content as a minified production IIFE and background/options/sidepanel as ESM targeting Chrome 116/ES2022.
- Preserve the existing staged working-tree changes; migration edits must be layered on top and must not stage or commit user-owned changes.
- Maintain at least 115 unit tests; the starting tree has 130 passing tests.

---

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

### Task 2: Strict Notion, settings, provisioning, and AI boundaries

**Files:**
- Modify: `src/notion.ts`
- Modify: `src/settings.ts`
- Modify: `src/provisioning.ts`
- Modify: `src/ai-note-actions.ts`
- Test: `tests/notion.test.ts`
- Test: `tests/settings.test.ts`
- Test: `tests/provisioning.test.ts`
- Test: `tests/ai-note-actions.test.ts`

**Interfaces:**
- Consumes: strict domain contracts and fetch/storage ports from Task 1.
- Produces: validated Notion response subsets, typed API errors, typed settings normalization, provisioning results, and Prompt API ports.

- [ ] **Step 1: Expose boundary diagnostics**

Remove the four suppression directives and run `npx tsc -b --force --pretty false`. Expected: failures localized to this task and downstream consumers.

- [ ] **Step 2: Validate consumed external JSON**

Parse `response.json()` as `unknown`. Add handwritten guards for the exact fields consumed from pages, databases/data sources, blocks, searches, errors, and Prompt API structured output. Throw the existing typed errors before state changes on incomplete success payloads.

- [ ] **Step 3: Type settings and orchestration**

Give defaults and normalization a stable `Settings` return type, keep historical field migration, and type provisioning dependency injection and error metadata without changing behavior.

- [ ] **Step 4: Verify focused behavior**

Run `npx tsc -b --force --pretty false` and the four listed test files through `tsx --test`. Expected: no diagnostics in these modules and all focused tests pass, including malformed Notion success responses.

### Task 3: Strict OAuth extension and Cloudflare Worker

**Files:**
- Modify: `src/oauth-device.ts`
- Modify: `src/oauth.ts`
- Modify: `oauth-worker/src/contracts.ts`
- Modify: `oauth-worker/src/index.ts`
- Test: `tests/oauth.test.ts`
- Test: `tests/oauth-worker.test.ts`

**Interfaces:**
- Consumes: fetch, cryptography, timer, settings, Durable Object, and Worker environment contracts.
- Produces: validated broker request/response types, typed OAuth errors, typed device-proof lifecycle, and strict Worker handlers/Durable Object storage.

- [ ] **Step 1: Expose OAuth diagnostics**

Remove suppression from the three suppressed OAuth files and run `npx tsc -b --force --pretty false`. Expected: OAuth/Worker diagnostics fail the build.

- [ ] **Step 2: Type OAuth ports and guards**

Define defaults for injected crypto, key store, nonce, time, and fetch dependencies so production call sites need not pass test-only ports. Validate successful broker and Notion payloads from `unknown`; preserve error code/status/retry metadata.

- [ ] **Step 3: Type Worker state and concurrency**

Type environment bindings, Durable Object stubs/storage, alarm state, rate-limit records, lease state, and request bodies. Preserve atomic state consumption, rotation, replay protection, origin validation, and cleanup semantics.

- [ ] **Step 4: Verify OAuth behavior**

Run `npx tsc -b --force --pretty false` and both listed tests through `tsx --test`. Expected: zero OAuth/Worker diagnostics and all focused tests pass.

### Task 4: Typed runtime messaging and extension surfaces

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/runtime-message.ts`
- Modify: `src/content-loader.ts`
- Modify: `src/background.ts`
- Modify: `src/content.ts`
- Modify: `options/options.ts`
- Modify: `sidepanel/sidepanel.ts`
- Modify: `types/globals.d.ts`
- Test: `tests/runtime-message.test.ts`
- Test: `tests/content-loader.test.ts`

**Interfaces:**
- Consumes: all strict core, Notion, OAuth, settings, and provisioning interfaces.
- Produces: complete `RuntimeRequest`/response correlation, exhaustive background dispatch, typed Chrome/DOM helpers, and validated message boundaries.

- [ ] **Step 1: Align the full message protocol**

Add every handled message and consumed field—including current working-tree additions—to `RuntimeRequest`, `RuntimeResponseMap`, and `MESSAGE_TYPES`. Validate required and optional fields by message type, reject malformed nested documents/drafts/destinations/remotes, and make the guard switch exhaustive with `assertNever`.

- [ ] **Step 2: Type extension dependencies and DOM access**

Remove suppression from background, content, options, and sidepanel. Type Chrome callbacks, runtime send helpers, injected dependencies, timers, editor events, DOM query helpers, custom globals, and boundary errors. Require elements once through typed helper functions instead of repeated nullable casts.

- [ ] **Step 3: Preserve compile-time protocol guarantees**

Expand `tests/types/contracts.test-d.ts` to assert response correlation for added messages, delivery-state narrowing, exhaustive handling, and port compatibility. Add negative runtime-message cases for each required payload shape.

- [ ] **Step 4: Verify extension surfaces**

Run `npx tsc -b --force --pretty false`, `tsx --test tests/runtime-message.test.ts tests/content-loader.test.ts`, and `npm run build`. Expected: zero source diagnostics, focused tests pass, and all four bundles build.

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

### Task 6: Release and acceptance verification

**Files:**
- Modify only if a gate exposes a defect: `scripts/*.ts`, `manifest.json`, HTML surfaces, release allowlists, and related tests.

**Interfaces:**
- Consumes: the complete strict source tree and build/release configuration.
- Produces: audited bundles and deterministic staged release archive.

- [ ] **Step 1: Prove repository hygiene**

Run `rg -l '^// @ts-nocheck' --glob '*.ts'` and `git ls-files '*.js' '*.mjs'`. Expected: both commands print no files. Run `npx tsc -b --force --pretty false`. Expected: exit 0.

- [ ] **Step 2: Run build and source release gates**

Run `npm run build`, `npm run check:bundle`, and `npm run check:release`. Expected: all exit 0 and the production content bundle remains at or below 450,000 bytes.

- [ ] **Step 3: Run the full behavioral suite**

Run `npm test` and `npm run test:browser`. Expected: all unit and Playwright scenarios pass with zero failures.

- [ ] **Step 4: Smoke-test a staged package**

Set non-secret syntactically valid public test values (`NQN_NOTION_CLIENT_ID=strict-migration-smoke`, `NQN_OAUTH_BROKER_URL=https://oauth-smoke.invalid`) and run `npm run release:package`. Inspect the ZIP inventory with `unzip -l`; expected: only allowlisted static assets and `dist/*.js`, with no `.ts`, `.map`, or undeclared files.

- [ ] **Step 5: Review final diff and acceptance criteria**

Compare the entire working tree with `origin/main`, inspect staged and unstaged diffs separately to preserve ownership, and obtain a whole-branch review. Fix every Critical/Important finding, then rerun Steps 1-4 fresh.

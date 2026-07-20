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

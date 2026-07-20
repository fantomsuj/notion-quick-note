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

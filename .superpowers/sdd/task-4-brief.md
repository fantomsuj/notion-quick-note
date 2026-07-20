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

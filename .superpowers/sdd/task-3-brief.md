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

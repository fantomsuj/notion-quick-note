# Task 3 report: Strict OAuth extension and Cloudflare Worker

Status: DONE

## Files

- `src/oauth-device.ts`
- `src/oauth.ts`
- `oauth-worker/src/contracts.ts`
- `oauth-worker/src/index.ts`
- `tests/oauth.test.ts`
- `tests/oauth-worker.test.ts`

## Design

- Removed all Task 3 `@ts-nocheck` directives from production and focused test files.
- Added typed defaults and ports for browser crypto, IndexedDB device-key storage, fetch, nonce generation, time, settings persistence, Worker bindings, rate limiting, and Durable Object storage.
- Broker and Notion JSON now enter as `unknown` and are narrowed by explicit record and endpoint-specific response guards before credentials or metadata are consumed.
- Added typed OAuth errors that retain HTTP status, broker code, retry delay, and retryability metadata.
- Typed transaction/connection records, encrypted token custody, nonce expiries, operation leases, alarms, and storage transactions without changing the existing consume-before-validation, one-operation lease, replay prevention, origin validation, or cleanup order.
- Exchange and refresh use separate Notion success guards so refresh retains its prior requirement set while malformed optional workspace/identity metadata still fails closed.
- Focused test fakes are fully typed; no suppressions, explicit blanket `any`, or unchecked boundary assertions were added.

## RED evidence

1. `npx tsc -b --force --pretty false`
   - Exit 2 after suppression removal, exposing the expected OAuth device, broker, Worker handler, Durable Object storage, and focused-test diagnostics.
2. `npx tsx --test tests/oauth.test.ts tests/oauth-worker.test.ts`
   - Exit 1; 24 passed and 2 failed.
   - A successful broker exchange accepted numeric `workspace_name` instead of rejecting an invalid token response.
   - A successful Notion exchange accepted numeric `workspace_name` and returned 200 instead of 502.
3. `npx tsx --test --test-name-pattern='surfaces a broker error message and metadata' tests/oauth.test.ts`
   - Exit 1 because broker `retry_after` and `retryable` metadata were not retained on the thrown error.

## GREEN evidence

1. `npx tsc -b --force --pretty false`
   - Exit 0; no diagnostics.
2. `npx tsx --test tests/oauth.test.ts tests/oauth-worker.test.ts`
   - Exit 0; 26 tests passed, 0 failed.
3. `npx tsc -b tsconfig.extension.json tsconfig.worker.json --force --pretty false`
   - Exit 0; extension and Worker projects emitted no diagnostics during the final behavior-preservation pass.
4. `git diff --check -- src/oauth-device.ts src/oauth.ts oauth-worker/src/contracts.ts oauth-worker/src/index.ts tests/oauth.test.ts tests/oauth-worker.test.ts`
   - Exit 0.

## Concerns

- None identified within Task 3 scope.
- Shared, out-of-scope shortcut-settings files briefly made the workspace-wide compiler fail during concurrent work; the required final forced compiler run was repeated after those files were completed and passed with no diagnostics.
- No Git add, commit, restore, checkout, or reset operation was performed during this task.

## Review follow-up: preserve broker fields and refresh compatibility

Status: DONE

- Extension exchange payloads are narrowed to their required credential/identity fields and optional workspace metadata, then copied by removing only `refresh_token`; all other broker fields remain available through a sound `Record<string, unknown>` intersection.
- Extension refresh payloads are narrowed in place and returned intact. `access_token` remains required; `bot_id`, `workspace_id`, `workspace_name`, and `workspace_icon` remain optional but fail closed when present with a non-string value.
- Worker Notion exchange/refresh response types retain their unknown extra fields. Refresh continues to require only access and refresh tokens, while exchange still requires both tokens plus bot/workspace identity.
- The malformed Worker exchange-body response now reports only `redirect_uri is required`; it no longer mentions a `public_key` that `/exchange` does not accept.

### Review RED evidence

`npx tsx --test tests/oauth.test.ts tests/oauth-worker.test.ts`

- Exit 1; 28 tests total, 25 passed and 3 failed.
- Extension exchange discarded an extra `owner` field.
- Extension refresh discarded an extra `owner` field.
- Worker `/exchange` returned `redirect_uri and public_key are required` instead of `redirect_uri is required`.
- The new Worker refresh compatibility/negative test already passed during RED, confirming omitted identity fields remained accepted and malformed optional metadata was rejected.

### Review GREEN evidence

1. `npx tsx --test tests/oauth.test.ts tests/oauth-worker.test.ts`
   - Exit 0; 28/28 tests passed.
2. `npx tsc -b --force --pretty false`
   - Exit 0; no diagnostics.
3. No suppressions, blanket `any`, unchecked boundary assertions, or Git index operations were introduced.

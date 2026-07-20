# OAuth Broker Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add enforceable abuse controls, bounded Notion calls, stable operational errors, and privacy-safe request tracing to the OAuth broker.

**Architecture:** Keep the dependency-free Cloudflare Worker and its public routes intact. Add small request-boundary, rate-limit, upstream, and logging helpers around the existing forwarding logic, with runtime dependencies injected through `env` for deterministic Node tests.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers Rate Limiting API, Node test runner, Wrangler TOML.

## Global Constraints

- Preserve `/exchange`, `/refresh`, `/revoke`, and `/health` route semantics.
- Never log request bodies, OAuth credentials, authorization codes, or tokens.
- Add no runtime package dependency or persistent storage.
- Keep the 16 KiB request-body cap and exact extension-origin/redirect allowlists.
- Use one `OAUTH_RATE_LIMITER` binding configured for 30 calls per 60 seconds.
- Treat the native limiter as a best-effort abuse guard, not exact accounting.

---

### Task 1: Request boundary and abuse controls

**Files:**
- Modify: `tests/oauth-worker.test.js`
- Modify: `oauth-worker/src/index.js`

**Interfaces:**
- Consumes: `env.OAUTH_RATE_LIMITER.limit({ key })`, `CF-Connecting-IP`, `Origin`, route path, and JSON request bodies.
- Produces: validated route payloads; `429 rate_limited`, `415 unsupported_media_type`, `400 invalid_request`, and `503 invalid_configuration` responses with `X-Request-ID`.

- [ ] **Step 1: Write failing tests** for missing bindings, per-client/per-route limiter keys, limiter rejection headers/body, non-JSON content types, non-object JSON, and supplied/generated request IDs. Use a mock limiter that records keys and returns `{ success: true }` by default.
- [ ] **Step 2: Verify RED** with `node --test tests/oauth-worker.test.js`; expect new assertions to fail because rate limiting, media-type validation, and correlation IDs do not exist.
- [ ] **Step 3: Implement the boundary** in `oauth-worker/src/index.js`: validate `OAUTH_RATE_LIMITER.limit`, generate or accept a safe request ID, call `limit({ key: path + ":" + clientAddress })`, require `application/json`, reject arrays/null after parsing, and attach standard headers to every response.
- [ ] **Step 4: Verify GREEN** with `node --test tests/oauth-worker.test.js`; expect all broker tests to pass.
- [ ] **Step 5: Inspect and commit** only the two files with message `Harden OAuth request boundary`.

### Task 2: Bounded and normalized Notion upstream handling

**Files:**
- Modify: `tests/oauth-worker.test.js`
- Modify: `oauth-worker/src/index.js`

**Interfaces:**
- Consumes: validated route payloads and `env.FETCH || fetch`.
- Produces: unchanged valid Notion JSON/status responses; normalized `502 upstream_unavailable`, `502 invalid_upstream_response`, and `504 upstream_timeout` errors.

- [ ] **Step 1: Write failing tests** for a rejected fetch, an abort/timeout, a non-JSON response, and preservation of valid Notion status/payload data.
- [ ] **Step 2: Verify RED** with `node --test tests/oauth-worker.test.js`; expect failures because fetch errors currently become generic `500` responses and non-JSON bodies become `{}`.
- [ ] **Step 3: Implement the upstream boundary** with an abort controller and fixed timeout, classify abort separately from transport errors, require a JSON upstream content type and parseable object payload, and preserve valid upstream status codes and JSON.
- [ ] **Step 4: Verify GREEN** with `node --test tests/oauth-worker.test.js`; expect all broker tests to pass.
- [ ] **Step 5: Inspect and commit** only the two files with message `Bound OAuth upstream requests`.

### Task 3: Secret-free operational logging

**Files:**
- Modify: `tests/oauth-worker.test.js`
- Modify: `oauth-worker/src/index.js`

**Interfaces:**
- Consumes: request ID, method, path, response status, outcome code, and elapsed time.
- Produces: one JSON completion event via `env.LOG || console.info`; no credential-bearing values.

- [ ] **Step 1: Write a failing test** that submits sentinel code/token values, records the log call, asserts expected metadata, and asserts serialized logs omit every sentinel.
- [ ] **Step 2: Verify RED** with `node --test tests/oauth-worker.test.js`; expect no completion event.
- [ ] **Step 3: Implement one completion log** in a top-level `finally`-style response wrapper, using an injected clock/logger for deterministic tests and an outcome derived only from status/code.
- [ ] **Step 4: Verify GREEN** with `node --test tests/oauth-worker.test.js`; expect all broker tests to pass without console noise.
- [ ] **Step 5: Inspect and commit** only the two files with message `Add OAuth request telemetry`.

### Task 4: Deployment contract and release guidance

**Files:**
- Modify: `oauth-worker/wrangler.toml.example`
- Modify: `docs/RELEASE.md`
- Modify: `docs/PRODUCT.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `OAUTH_RATE_LIMITER` Worker binding and Cloudflare Worker logs.
- Produces: copyable deployment configuration and explicit production verification/rollback steps.

- [ ] **Step 1: Add the Wrangler binding** with namespace `1001`, limit `30`, and period `60`.
- [ ] **Step 2: Document operations**: health validation, route smoke tests, synthetic `429`, request-ID tracing, secret-redaction review, native limiter locality/eventual consistency, and version rollback.
- [ ] **Step 3: Update the product release gate** to describe repository-enforced rate limiting plus the remaining deployed verification.
- [ ] **Step 4: Run documentation/release checks** with `npm run check:release`; expect exit code 0.
- [ ] **Step 5: Inspect and commit** the four documentation/configuration files with message `Document OAuth broker operations`.

### Task 5: Final verification and publication

**Files:**
- Review all task files; create no additional source files.

**Interfaces:**
- Consumes: completed implementation and repository scripts.
- Produces: a verified branch and draft pull request targeting `main`.

- [ ] **Step 1: Run targeted tests** with `node --test tests/oauth-worker.test.js` and confirm zero failures.
- [ ] **Step 2: Run unit tests** with `npm test` and confirm zero failures.
- [ ] **Step 3: Run the complete gate** with `npm run check`, including build, bundle/release audits, syntax checks, Node tests, and Playwright tests; investigate any failure without weakening checks.
- [ ] **Step 4: Review scope** with `git status --short`, `git diff main...HEAD --stat`, `git diff --check`, and `git log --oneline main..HEAD`; inspect for secrets, debug code, generated noise, and unrelated edits.
- [ ] **Step 5: Push** `agent/harden-oauth-broker` and open a draft PR through the GitHub app targeting `main`, with implementation, impact, root cause, validation, risks, and rollback notes.

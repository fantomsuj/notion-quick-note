# OAuth Broker Production Hardening Design

## Goal

Make the Cloudflare OAuth broker safe and diagnosable enough for production use without changing the extension's exchange, refresh, or revoke contract.

## Current state

The broker is a single dependency-free Cloudflare Worker. It validates extension origins and OAuth redirect URIs, caps request bodies at 16 KiB, and forwards three routes to Notion. Its release checklist still requires rate limiting and production broker verification. Upstream calls are currently unbounded, malformed upstream responses are treated as empty JSON, and responses have no correlation identifier.

## Approaches considered

### Native Cloudflare rate-limit binding (selected)

Use one Cloudflare Rate Limiting binding and key requests by client address and OAuth route. This is versioned in Wrangler configuration, fast at the edge, mockable in Node tests, and directly addresses the release gate. Limits are deliberately generous because shared networks can place legitimate users behind one address.

### Durable Object limiter

A Durable Object could enforce stricter globally coordinated counters. It would add state, migrations, deployment complexity, and cost without a demonstrated need for exact accounting.

### Dashboard-only rules

Cloudflare WAF rules could protect the endpoint without application changes, but their configuration and behavior would not be represented or tested in this repository.

## Request flow

1. Resolve a correlation ID from a valid incoming `X-Request-ID` or generate a UUID.
2. Answer `/health` without CORS credentials, while validating secrets, allowlists, and the rate-limit binding.
3. Reject unknown methods and routes.
4. Enforce the exact extension-origin allowlist.
5. Apply the rate limit before parsing or forwarding a credential-bearing request.
6. Require `application/json`, cap the body at 16 KiB, and require a plain JSON object.
7. Validate route-specific fields and the exchange redirect URI.
8. Forward to Notion with a bounded timeout.
9. Normalize upstream failures and emit a structured, secret-free completion log.
10. Return the correlation ID on every response.

## Rate limiting

The Worker uses an `OAUTH_RATE_LIMITER` binding. The key combines the OAuth path with Cloudflare's connecting client address. The example Wrangler configuration permits 30 requests per 60 seconds per route and edge location. Normal OAuth use is far below that threshold, while loops and basic abuse are curtailed. A missing or invalid binding fails health checks and credential-bearing routes closed with `503`.

Rate-limit rejection returns:

- HTTP `429`
- `Retry-After: 60`
- JSON `{ "error": "Too many requests", "code": "rate_limited" }`

Cloudflare's native limiter is intentionally permissive and eventually consistent; it is an abuse guard, not billing or security accounting.

## Upstream resilience

Notion requests use an abort signal with a short fixed timeout. Timeouts return `504` with code `upstream_timeout`; transport failures return `502` with code `upstream_unavailable`. A non-JSON Notion response returns `502` with code `invalid_upstream_response`. Valid Notion JSON and status codes continue to pass through so the extension retains existing OAuth behavior.

## Observability and privacy

Every response includes `X-Request-ID`. The Worker emits one structured JSON completion event containing only the request ID, route, method, status, outcome, and duration. It never logs headers, request bodies, authorization codes, access tokens, refresh tokens, client credentials, or Notion response bodies.

## Compatibility

The extension continues to call `/exchange`, `/refresh`, and `/revoke` with the same JSON shapes. Existing successful Notion payloads remain unchanged. Error responses gain stable machine-readable `code` values while preserving the human-readable `error` field already consumed by the client.

## Testing

Node tests use injected fetch, rate-limit, clock, UUID, and timeout behavior. Coverage includes successful forwarding, binding validation, CORS, malformed content, non-object JSON, oversize bodies, rate-limit rejection, timeout, transport failure, invalid upstream JSON, correlation IDs, and log redaction. The repository's complete `npm run check` remains the final gate.

## Deployment and rollback

The Wrangler example documents the binding namespace and limit. The release runbook requires deploying the binding, checking `/health`, exercising all OAuth routes, verifying a synthetic `429`, and confirming logs contain correlation metadata but no credentials. Rollback is a normal Worker version rollback; no persistent schema or migration is introduced.

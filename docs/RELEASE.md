# Chrome Web Store release runbook

Use the generated ZIP only. Do not zip or upload the repository: the working tree intentionally contains tests, documentation, development OAuth patterns, and other files that are excluded from the Web Store artifact.

## 1. Reserve and configure production identities

1. Create the Chrome Web Store item to obtain its stable extension ID.
2. Create a Notion public connection with the required read, insert, and update content capabilities and the intended installation scope.
3. Register `https://EXTENSION_ID.chromiumapp.org/notion` as the exact Notion OAuth redirect URI.
4. Copy `oauth-worker/wrangler.toml.example` to the ignored `oauth-worker/wrangler.toml`. Set `ALLOWED_EXTENSION_IDS` to the production extension ID and `ALLOWED_ORIGINS` to `chrome-extension://EXTENSION_ID`. Assign `OAUTH_RATE_LIMITER` a positive integer namespace ID unused by other bindings in the Cloudflare account; the checked-in policy allows 30 calls per 60 seconds for each client address and OAuth route.
5. Store `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` as deployment secrets, never in Git or the extension, then deploy `oauth-worker/` over HTTPS.
6. Verify `GET /health` returns `200` and an `X-Request-ID`. A `503` means credentials, allowlists, or the rate-limit binding are missing or inconsistent; do not release while health is degraded.
7. Exercise exchange, refresh-token rotation, revocation, rejected origins, the exact redirect, an upstream failure, and an upstream timeout against the deployed broker. Confirm every response has a request ID and OAuth success/error payloads still reach the extension.
8. Generate a controlled same-client burst against a non-forwarding invalid request such as `{}` on `/refresh` and confirm the broker eventually returns `429`, `Retry-After: 60`, and `code: rate_limited`. Cloudflare's native counters are edge-local and eventually consistent, so this is an abuse guard rather than exact accounting.
9. Find a request by its ID in Workers logs. Confirm the completion event contains only method, route, status, outcome, duration, and request ID; search explicitly for test authorization codes and tokens and confirm none were retained.

If production verification fails after deployment, roll back to the previous Cloudflare Worker version. This broker change has no persistent schema or migration, so rollback does not require data repair. Preserve the failed deployment ID and request IDs for diagnosis.

## 2. Configure and verify the release

Install from the lockfile with Node 20 or later:

```sh
npm ci
npx playwright install chromium
```

Copy `release.config.json.example` to the ignored `release.config.json` and enter the public client ID and HTTPS broker URL. These values are public configuration; the client secret must not appear in this file. Environment variables `NQN_NOTION_CLIENT_ID` and `NQN_OAUTH_BROKER_URL` can be used instead.

Keep `manifest.json`, `package.json`, and `package-lock.json` on the same monotonically increasing version. Then run:

```sh
npm run release:package
```

That command requires the complete `npm run check` suite to pass, audits permissions/CSP/assets/incognito storage/remote code, copies only the explicit allowlist in `scripts/release-files.mjs`, replaces development OAuth patterns with the exact broker origin, and writes:

- `release/chrome-extension/` — unpacked inspection build
- `release/notion-quick-note-VERSION.zip` — upload artifact with `manifest.json` at its root
- `release/notion-quick-note-VERSION.zip.sha256` — artifact checksum

Re-running from the same Git tree, lockfile, Node/npm versions, and release configuration should produce the same checksum. Record the commit, Node/npm versions, ZIP checksum, and broker deployment identifier with the release.

## 3. Test the generated artifact

Load `release/chrome-extension/` in a clean Chrome profile and verify:

- Fresh install, OAuth, automatic database creation, destination search, and disconnect/revocation.
- Toolbar, keyboard shortcut, selection context menu, formatted capture, source on/off, retry/restart recovery, recent-note editing, and side-panel/tab fallbacks.
- Legacy `captureStateV1` migration, per-record IndexedDB persistence, Notes storage diagnostics, and JSON/Markdown recovery downloads.
- Restricted pages and PDFs fail over without losing the draft.
- With “Allow in Incognito” off, no Incognito access is available. With it explicitly on, Incognito capture data is absent after all Incognito windows close, regular capture history is unchanged, and the user understands that saved captures go to the shared Notion connection.
- No console errors, failed local asset loads, remotely hosted code, or unexpected network origins.

## 4. Complete external submission requirements

- Replace the contact placeholder in `PRIVACY.md`, publish it on a stable HTTPS site, and add that URL to the Developer Dashboard.
- Complete the Privacy Practices form using `docs/STORE_LISTING.md`; ensure its answers, the hosted policy, and actual behavior agree.
- Supply accurate screenshots, listing copy, category, support contact/site, and reviewer test instructions.
- Confirm rights to distribute the Notion name/mark and every bundled NotionInter font file; otherwise replace them before submission. Keep license/provenance records outside the ZIP for review.
- Complete Chrome Web Store developer identity/account verification and any required payment.
- Confirm the production Notion public connection, redirect URI, capabilities, and installation scope are live for intended users.
- Upload the generated ZIP, address automated warnings, submit for review, and archive the checksum and submitted artifact.

Any code or manifest correction requires another version increment and a newly generated ZIP.

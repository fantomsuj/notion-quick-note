# Restricted-Page Notification Design

## Goal

Explain immediately when Quick Note cannot open on the current page, rather than relying only on the toolbar badge and its hover tooltip.

## Chosen approach

When the toolbar action, keyboard command, or selection menu invokes Quick Note on an unavailable page, the service worker will show a native browser notification. The notification will use the extension's existing 128px icon, a stable per-tab identifier, the title `Quick Note unavailable`, and the existing safe failure detail. Creating a notification with the same identifier replaces the earlier notification for that tab, so repeated clicks do not accumulate notices.

The existing red `!` badge and action title remain as a secondary, tab-scoped indication. The early return remains ahead of context collection and draft creation, so a restricted-page attempt never creates or changes a local draft.

## Alternatives considered

- An injected page toast cannot work on browser-internal pages, the Web Store, PDFs, or inaccessible file pages—the exact places that need the warning.
- An extension warning tab would interrupt the user and create unnecessary navigation.
- Native notifications work outside the current page and are the user-selected behavior. They require the Manifest V3 `notifications` permission.

## Error handling and privacy

Notification creation is best effort. A failure to show a browser notification must not prevent setting the badge/title or alter draft state. The notice includes only the existing concise error detail; it does not include page contents, URLs, selections, tokens, or Notion data.

## Validation

- Unit-test the native notification payload and stable per-tab ID.
- Unit-test notification failure so it is swallowed without affecting the warning path.
- Update manifest/release expectations for the explicit `notifications` permission.
- Run type checking, the unit suite, bundle/release checks, and browser/MV3 tests.

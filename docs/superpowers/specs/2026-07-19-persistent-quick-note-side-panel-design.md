# Persistent Quick Note Side Panel

## Goal

Make the toolbar action open a single Quick Note composer that remains visible while the user switches tabs in the same Chrome window. While the panel is open, the active page becomes source context for the current draft without requiring another toolbar click.

## Interaction Design

- Clicking the extension icon opens Chrome's native, window-scoped side panel on the Compose view.
- The panel remains open while the user switches tabs in that window.
- When the active tab changes or its top-level page finishes navigating, Quick Note attaches that page's title and URL to the active new-note draft.
- Attached pages appear in the composer's existing Sources interface and retain its one-click remove control.
- Removing an automatically attached page dismisses its normalized URL for the remainder of that draft. Returning to that tab does not reattach it.
- A dismissed page can be restored only through an explicit add-current-page action.
- Automatic tracking captures page title and URL only. Selected text remains an explicit user action so ordinary browsing never copies page content unexpectedly.
- Existing toolbar, browser shortcut, global shortcut, and selected-text context-menu entry points open the same side panel. The selected-text command may explicitly add its selection to the draft.
- Saving or discarding the draft clears its draft-scoped dismissal state. A new draft may attach the same page again.

## Architecture

### Window-scoped panel

The background service worker will open the default side panel by `windowId`, rather than configuring a panel path for an individual `tabId`. This uses Chrome's native per-window persistence and avoids reinjecting a composer into every page.

The existing extension-tab fallback remains available when Chrome cannot open the side panel. The in-page overlay is no longer the primary toolbar surface.

### Active-tab tracking

The background worker will observe active-tab changes and completed top-level navigations. Tracking runs only when a Quick Note panel session is active for that Chrome window. It obtains the active tab's safe metadata, normalizes supported HTTP(S) page URLs, and submits that context through the same draft repository used by explicit capture entry points.

Restricted Chrome pages, missing tab metadata, unsupported protocols, and PDFs are ignored for automatic attachment without closing or disrupting the panel.

### Draft source and dismissal state

The persisted draft remains the source of truth for attached sources. A small draft-scoped collection of normalized dismissed URLs prevents automatically removed sources from returning. It is stored with the draft rather than in service-worker variables so it survives Manifest V3 worker suspension.

Automatic context updates must be idempotent: revisiting an attached URL updates its metadata without creating a duplicate, and revisiting a dismissed URL makes no change. Explicit restoration removes the URL from the dismissal collection before attaching it.

### Panel synchronization

The side panel listens for draft/context change notifications and refreshes the currently displayed draft without replacing unsaved editor input. Draft revisions continue to protect against stale writes. Source-only background changes are merged against the latest stored draft rather than a stale panel snapshot.

## Permissions and Privacy

The manifest will add only the Chrome permission necessary to read active-tab title and URL during automatic tracking. Automatic behavior does not inject scripts or read page contents. Existing host permissions remain unchanged.

The store-facing permission explanation and product documentation will be updated to describe persistent side-panel behavior and automatic title/URL source attachment.

## Error Handling

- Side-panel open failure falls back to the existing extension tab and reports the failure only through existing diagnostics/logging.
- Unsupported or restricted tabs are skipped silently; the existing draft remains usable.
- A closed panel session stops automatic tab tracking for its window once the extension can no longer confirm an active panel connection.
- Concurrent tab events and editor autosaves are serialized through repository revisions so neither source changes nor typed content are lost.

## Testing

- Repository tests cover automatic attach, URL deduplication, metadata update, dismissal persistence, explicit restoration, and dismissal reset for a new draft.
- Background tests cover a toolbar click opening a window-scoped panel and tab activation/navigation forwarding supported page metadata only while the panel is active.
- Side-panel tests cover applying source-only draft updates without overwriting editor content and removing an automatic source in one click.
- Browser verification builds the Manifest V3 extension, opens the side panel, switches between two tabs, confirms the composer remains mounted, confirms both pages are represented once, removes one source, and confirms revisiting that tab does not restore it.
- The full typecheck, unit test, release-check, and extension build commands run before completion.

## Non-goals

- Automatically copying selected text or other page content during tab switches.
- Tracking background tabs or browser history that the user never activates.
- Synchronizing one open panel across separate Chrome windows.
- Redesigning the composer or changing Notion delivery behavior.

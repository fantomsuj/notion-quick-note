# Chrome Web Store listing draft

## Core listing

**Name:** Notion Quick Note

**Single purpose:** Capture a reviewed note, selected text, and optional source-page context into a user-selected Notion page or database without leaving the active tab.

**Short description:** Capture a thought into Notion without leaving the page you're on.

**Detailed description:**

> Open a compact Quick Note from the toolbar, a keyboard shortcut, or the selected-text context menu. Review and format your note, optionally attach the active page title and URL, then save it to a Notion page or database you choose.
>
> On supported Chrome desktop devices, optional AI actions can suggest a title or extract editable to-dos using Chrome's on-device language model. These actions run only when you choose them, have no cloud AI fallback, and never change or save a note until you review and apply the preview. A master setting and separate feature toggles let you turn them off.
>
> Your note text, selected text, and any attached page title and URL are autosaved locally in Chrome so you can recover a draft. Quick Note sends a capture only when you choose Save, and only to the Notion workspace and destination you selected.
>
> Queued notes stay on your device until delivery succeeds or you delete them. Inactive drafts and delivered history are removed after 30 days. Quick Note retries temporary failures and shows recent delivery status.
>
> The Notes view shows local storage diagnostics and can export drafts and capture history as JSON or Markdown without including Notion credentials or extension settings.
>
> If you explicitly enable the extension in Incognito, Incognito drafts, queued notes, and local history remain session-only. Saving still sends the capture to your selected Notion workspace.
>
> Quick Note reads active-page details only when you invoke it. It uses Notion's OAuth flow for production connections and does not continuously read browsing activity, run analytics, show ads, or load remote program code.
>
> Notion Quick Note is an independent product and is not endorsed by Notion Labs, Inc.

Recommended category: **Productivity**.

## Permission justifications

| Permission | Dashboard justification |
|---|---|
| `activeTab` | Temporarily accesses the active tab only after the user clicks the extension, invokes its shortcut, or chooses its context-menu command, so the user can review the page title, URL, and selected text before saving. |
| `scripting` | Injects the locally packaged Quick Note composer and collects the user-invoked active-page context. No script is injected continuously. |
| `contextMenus` | Adds “Save selection to Notion Quick Note” to the selection context menu. |
| `identity` | Opens Notion's OAuth authorization flow and receives its callback through Chrome's identity redirect. |
| `storage` | Stores the current Notion access token, an opaque broker connection handle, settings, and a small capture index in extension-scoped storage. A non-exportable signing key used to prove refresh, revoke, and replaced-connection cleanup requests is kept in the extension's local IndexedDB database, alongside regular capture records. Incognito drafts and queue records use memory-backed session keys. |
| `alarms` | Wakes the service worker for scheduled retry of captures that could not be delivered immediately. |
| `sidePanel` | Opens a Chrome side-panel fallback when the in-page composer cannot run, such as on restricted pages or PDFs. |
| `https://api.notion.com/*` | Sends user-approved captures to Notion and searches, validates, creates, or updates the user's chosen Notion destination. |
| Production OAuth broker origin (optional) | Requested only when the user chooses Connect Notion; used to create a one-time authorization transaction, exchange the authorization code, and make device-signed refresh and revocation requests. The broker stores the rotating refresh credential encrypted at rest and returns only an opaque connection handle. The release packager narrows access to the exact production origin. |

The `<all_urls>` match appears only on three web-accessible packaged design resources used by the gesture-injected composer: its two CSS files and local font files. It is not a host permission and does not grant page access.

## Privacy Practices answers

Confirm the dashboard's current wording before submission. Based on current behavior, disclose:

- **Authentication information:** the current Notion OAuth access token and opaque connection handle stored by the extension; a non-exportable device signing key stored only in extension-local IndexedDB; and the rotating Notion refresh credential stored encrypted by the OAuth broker.
- **Website content:** selected text and the page title/URL attached to a capture.
- **Web history / browsing activity:** the active page title and URL, accessed only when the user invokes Quick Note and used only for the capture feature.

Do not select advertising, analytics, personalization, or sale/transfer uses. Certify that data is used only for the extension's single purpose, is not sold, is not used for credit or lending, and is not used for personalized advertising. Supply the public URL hosting [`PRIVACY.md`](../PRIVACY.md), after replacing its contact placeholder.

The broker deletes its encrypted refresh record when a signed disconnect or replacement request reaches it, or after 180 days without a refresh. It attempts Notion revocation during disconnect even though local broker custody is deleted if Notion is temporarily unavailable. Uninstalling without disconnecting cannot notify the broker, so that encrypted record remains until the inactivity limit expires.

The optional Prompt API flow processes note content locally through Chrome's on-device model. It does not add a remote AI host permission or send prompt content to the extension developer.

## Listing media and review notes

Create at least one accurate screenshot; 1280×800 or 640×400 is recommended. Show the composer on a normal webpage, the connection screen, and Activity/retry behavior. Avoid Notion endorsement claims or Chrome/browser UI imitation.

Reviewer notes should include:

- A test Notion account or clear steps for completing OAuth.
- The exact user gesture needed to see active-page capture.
- How to test toolbar, shortcut, selection context menu, side-panel fallback, disconnect/revocation, and Incognito.
- A statement that the OAuth broker contains the client secret, holds rotating refresh credentials encrypted for at most 180 days of inactivity, and returns only an opaque handle; the submitted ZIP contains no remote executable code.

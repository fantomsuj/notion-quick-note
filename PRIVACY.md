# Notion Quick Note Privacy Policy

Effective: July 19, 2026

Notion Quick Note has one purpose: let you review and save a note, selected text, and optional source-page context to a Notion destination you choose.

## At a glance

- Your note text, selected text, and attached page title and URL are saved locally in Chrome so a draft can be recovered.
- Quick Note sends a capture only when you choose **Save**, and only to the Notion workspace and destination you selected.
- Queued notes remain on your device until delivery succeeds or you delete them. Inactive drafts and delivered history are removed after 30 days.
- In Incognito, drafts, queue entries, and local history last only for that Incognito extension session. Choosing **Save** still sends the capture to your selected Notion workspace.
- Optional title and to-do suggestions run only after you choose an AI action, using Chrome's on-device language model. There is no cloud AI fallback, and generated text is not added until you review and apply it.

## Data the extension handles

- **Capture content:** text you type, text you explicitly capture through the selection command, and active-page titles and URLs attached while the Quick Note side panel is open.
- **Notion account data:** an OAuth access token, an opaque broker connection handle, workspace ID/name/icon, destination IDs/names, and the minimum Notion page/database data needed to find, create, validate, or update your chosen destination.
- **Local operational data:** drafts, queued captures, delivery state, timestamps, source metadata, recent delivery records needed for retry, recovery, deduplication, and activity history, and a non-exportable device signing key used to prove refresh, revocation, and replaced-connection cleanup requests came from this extension installation.
- **Optional AI input:** when you explicitly run an AI action, the current note text, active-page title, and attached source titles are provided to Chrome's on-device model to generate the requested preview.

After you open Quick Note through its toolbar button, keyboard shortcut, or context menu, the side panel reads the active tab's title and URL as you switch tabs. This tracking stops when the side panel closes. The extension does not automatically read page bodies or selected text, monitor background tabs or browsing history, run analytics, show ads, or sell data.

## How data is used and shared

Capture content and destination data are sent directly from the extension to Notion only to provide the save, search, setup, retry, and edit features you request; note content does not pass through the OAuth broker. Authorization codes and OAuth credentials pass through the configured broker only to start and complete authorization, refresh access, or revoke the connection. The broker stores the rotating refresh credential encrypted at rest and returns an opaque connection handle to the extension. The broker hosting provider may process request metadata as part of operating the service.

Data is not shared with advertisers, data brokers, or unrelated third parties. The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

AI actions use the Prompt API and Chrome's locally managed model. Quick Note does not send AI prompts or generated responses to its developer, Google, Notion, or another cloud model service. Chrome may download and manage the on-device model according to Chrome's own model lifecycle.

All network requests use HTTPS. The Notion client secret is held by the OAuth broker and is never included in the extension package.

## Storage and retention

The current Notion access token, opaque broker connection handle, and settings are stored in Chrome extension storage on your device. A non-exportable signing key is stored in the extension's local IndexedDB database. The long-lived rotating refresh credential is encrypted and stored by the OAuth broker rather than in the extension. Broker connection records expire after 180 days without a successful refresh and are deleted when a signed disconnect or replacement request reaches the broker. If you uninstall without disconnecting, an abandoned encrypted broker record can remain until that inactivity limit. Regular-window drafts, queued captures, and recent delivery state are stored as separate records in the extension's local IndexedDB database, with only a small summary index in Chrome extension storage. Delivered history and abandoned drafts are retained for up to 30 days. Pending, blocked, or uncertain captures remain until you resolve or delete them so the extension does not silently lose unsent work.

If you explicitly allow the extension in Incognito, Incognito capture drafts, queue entries, and delivery history are kept in memory-backed session storage and are discarded when that Incognito extension session ends. Chrome shares extension settings and locally stored Notion credentials between regular and split-Incognito contexts; saving an Incognito capture still sends the capture to your selected Notion workspace.

The Notes view can display local storage usage and export drafts, queued captures, and delivery history as a JSON or Markdown recovery file. Recovery exports are created only when you request them and exclude Notion credentials and extension settings.

## Your controls

You can disable all AI actions or either individual prompt feature, remove any automatically attached source page with one click, omit source-page information, close the panel to stop active-tab tracking, discard drafts, delete local delivery history, export local capture data, grant access to additional Notion pages, disconnect Notion, revoke the connection in Notion, or uninstall the extension. A removed source stays dismissed for the rest of that draft unless you explicitly restore it. Disconnecting removes the locally stored access token and connection handle and asks the broker and Notion to revoke the OAuth connection; Notion content already created is not deleted.

## Changes and contact

Material changes to these practices will be disclosed before the changed collection or use begins. Questions and deletion requests can be sent to **[REPLACE WITH SUPPORT EMAIL BEFORE PUBLISHING]**.

Notion Quick Note is an independent product and is not endorsed by Notion Labs, Inc.

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

- **Capture content:** text you type, text you select, and—when “Attach the current webpage” is enabled—the active page title and URL.
- **Notion account data:** OAuth access and refresh tokens, workspace ID/name/icon, destination IDs/names, and the minimum Notion page/database data needed to find, create, validate, or update your chosen destination.
- **Local operational data:** drafts, queued captures, delivery state, timestamps, source metadata, and recent delivery records needed for retry, recovery, deduplication, and activity history.
- **Optional AI input:** when you explicitly run an AI action, the current note text, active-page title, and attached source titles are provided to Chrome's on-device model to generate the requested preview.

The extension reads active-page context only after you invoke it through its toolbar button, keyboard shortcut, or context menu. It does not continuously monitor browsing, run analytics, show ads, or sell data.

## How data is used and shared

Capture content and destination data are sent to Notion only to provide the save, search, setup, retry, and edit features you request. Authentication codes and tokens pass through the configured OAuth broker only for token exchange, refresh, or revocation; the broker forwards them to Notion and does not intentionally persist them. The broker hosting provider may process request metadata as part of operating the service.

Data is not shared with advertisers, data brokers, or unrelated third parties. The use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

AI actions use the Prompt API and Chrome's locally managed model. Quick Note does not send AI prompts or generated responses to its developer, Google, Notion, or another cloud model service. Chrome may download and manage the on-device model according to Chrome's own model lifecycle.

All network requests use HTTPS. The Notion client secret is held by the OAuth broker and is never included in the extension package.

## Storage and retention

Notion credentials and settings are stored in Chrome extension storage on your device. Regular-window drafts, queued captures, and recent delivery state are stored as separate records in the extension's local IndexedDB database, with only a small summary index in Chrome extension storage. Delivered history and abandoned drafts are retained for up to 30 days. Pending, blocked, or uncertain captures remain until you resolve or delete them so the extension does not silently lose unsent work.

If you explicitly allow the extension in Incognito, Incognito capture drafts, queue entries, and delivery history are kept in memory-backed session storage and are discarded when that Incognito extension session ends. Chrome shares extension settings and locally stored Notion credentials between regular and split-Incognito contexts; saving an Incognito capture still sends the capture to your selected Notion workspace.

The Notes view can display local storage usage and export drafts, queued captures, and delivery history as a JSON or Markdown recovery file. Recovery exports are created only when you request them and exclude Notion credentials and extension settings.

## Your controls

You can disable all AI actions or either individual prompt feature, omit source-page information, discard drafts, delete local delivery history, export local capture data, disconnect Notion, revoke the connection in Notion, or uninstall the extension. Disconnecting removes the locally stored connection and asks Notion to revoke the OAuth token; Notion content already created is not deleted.

## Changes and contact

Material changes to these practices will be disclosed before the changed collection or use begins. Questions and deletion requests can be sent to **[REPLACE WITH SUPPORT EMAIL BEFORE PUBLISHING]**.

Notion Quick Note is an independent product and is not endorsed by Notion Labs, Inc.

# Product brief

## Outcome

Make capturing a thought into Notion feel like opening Apple Quick Note: one gesture, immediate focus, very little configuration in the moment, and a reassuring sense that the thought landed safely.

## Key product decisions

| Decision | MVP choice | Reason |
|---|---|---|
| Surface | Floating card on the active webpage | Closest match to the bottom-right Apple Quick Note gesture |
| Alternate surface | Chrome side panel later | Better persistence, but takes more space and feels browser-owned |
| Default destination | Append to one page | Minimum Notion schema/configuration burden |
| Structured mode | Create a database item | Better organization and search for users who want it |
| Local testing auth | Personal access token | Lets one developer test immediately |
| Public auth | Notion OAuth through a broker | Keeps the mandatory client secret out of extension code |
| Permissions | `activeTab` plus Notion API | Avoids always-on access to browsing data |

## What research changed

Notion now distinguishes databases from their underlying data sources. Database pages are created under a `data_source_id`, so the extension resolves a pasted database URL to its first data source before creating a note.

Notion's May 2026 authorization behavior returns fresh access and refresh token pairs on every successful public authorization. The current broker completes initial exchange; refresh-token rotation is a release blocker, not something to fake inside the extension.

Flylighter's differentiation is not just clipping. Its flows, formatted highlights, property filling, append-to-previous-capture, shortcuts, and instant capture show that the long-term opportunity is a configurable capture layer. The MVP keeps only the behaviors that make the first capture feel excellent.

## Experience principles

1. **Thought first.** The cursor lands in an empty composer immediately.
2. **Context is optional and visible.** The current webpage is attached by default, but can be removed with one click.
3. **No modal labyrinth.** Destination configuration lives in settings, never in the capture loop.
4. **Quiet confidence.** Drafts persist during the tab session, saving has a visible state, and success closes the card.
5. **Permission proportionality.** Read the active page only after a user gesture; do not request continuous browsing history.

## Release gates

- Add refresh-token handling and token revocation
- Add a workspace page/data-source picker after OAuth
- Verify the full Chrome Web Store privacy disclosure
- Pin a stable production extension ID
- Add end-to-end tests in real Chrome against a test Notion workspace
- Test on difficult hosts, iframes, PDF viewer pages, Chrome internal pages, and CSP-heavy sites
- Add accessible focus trapping and screen-reader announcements

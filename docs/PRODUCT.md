# Product brief

## Outcome

Make capturing a thought into Notion take one gesture, focus immediately, require very little configuration in the moment, and reassure the user that the thought landed safely. Apple Quick Note is the interaction reference; [`DESIGN.md`](../DESIGN.md) defines the Notion-native visual system.

## Key product decisions

| Decision | MVP choice | Reason |
|---|---|---|
| Surface | Floating card on permitted webpages | Closest match to the bottom-right Apple Quick Note gesture |
| Alternate surface | Automatic side panel, then extension tab | Keeps capture available on PDFs, restricted pages, and injection failures |
| Default destination | Recover or create a private Quick Notes database | Delivers a working, searchable capture destination without asking users for IDs or duplicating it after an uncertain request |
| Structured mode | Create a database item | Better organization and search for users who want it |
| Local testing auth | Personal access token | Lets one developer test immediately |
| Public auth | Notion OAuth through a broker | Keeps the mandatory client secret out of extension code |
| Permissions | `activeTab` plus Notion API | Avoids always-on access to browsing data |
| Draft ownership | One active regular-profile draft | A thought follows explicit invocations across tabs instead of appearing lost |
| Recent editing | Five latest notes plus 30-day local search | Makes returning to prior work immediate without browsing history or workspace-wide Notion search |
| Capture persistence | One IndexedDB row per regular draft/capture; one session key per Incognito record | Keeps autosaves proportional to the note being edited and preserves atomic draft-to-queue transitions |
| Recovery | Notes diagnostics plus JSON and Markdown export | Makes local storage health visible and gives users a credential-free escape hatch |

## What research changed

Notion now distinguishes databases from their underlying data sources. Database pages are created under a `data_source_id`, so the extension resolves a pasted database URL to its first data source before creating a note.

Managed Quick Notes databases use a versioned description marker and stable property-ID mappings for `Name`, `Source URL`, `Source Domain`, and `Captured At`. Setup persists its recovery marker before calling Notion, and only a marked, schema-compatible database can be adopted after a restart or uncertain response. Manual destinations are not migrated.

Notion's May 2026 authorization behavior returns fresh access and refresh token pairs on every successful public authorization. The broker now handles exchange, refresh-token rotation, and revocation; the deployed production path still needs end-to-end verification before release.

Flylighter's differentiation is not just clipping. Its flows, formatted highlights, property filling, append-to-previous-capture, shortcuts, and instant capture show that the long-term opportunity is a configurable capture layer. The MVP keeps only the behaviors that make the first capture feel excellent.

## Experience principles

1. **Thought first.** The cursor lands in an empty composer immediately.
2. **Context is optional and visible.** The current webpage is attached by default, but can be removed with one click.
3. **No modal labyrinth.** Destination configuration lives in settings, never in the capture loop.
4. **Quiet confidence.** Routine local autosaves stay invisible. “Saved to Notion” means confirmed remote delivery; local drafts, acceptance, and background retries remain clearly labeled in Notes.
5. **Permission proportionality.** Read the active page only after a user gesture; do not request continuous browsing history.
6. **Preserve before mutation.** Remote edits stop on fingerprint conflicts, keep unsupported blocks locked in place, and journal every replacement step locally.

## Release gates

- Verify refresh-token rotation and revocation against the deployed production broker
- Configure Cloudflare rate limits for the OAuth broker and verify its origin gate in production
- Test destination search indexing and automatic database creation across workspace roles
- Verify the full Chrome Web Store privacy disclosure
- Pin a stable production extension ID
- Run the existing real-MV3 termination/profile-relaunch suite in release CI
- Complete manual verification on difficult hosts, iframes, PDFs, Chrome internal pages, CSP-heavy sites, Incognito, and fullscreen media
- Pass production OAuth exchange/rotation/revocation and managed Capture ID deduplication against a test Notion workspace

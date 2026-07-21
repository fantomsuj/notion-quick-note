# Product brief

## Outcome

Make capturing a thought into Notion take one gesture, focus immediately, require very little configuration in the moment, and reassure the user that the thought landed safely. Apple Quick Note is the interaction reference; [`DESIGN.md`](../DESIGN.md) defines the Notion-native visual system.

## Key product decisions

| Decision | MVP choice | Reason |
|---|---|---|
| Surface | Page-injected composer | Opens in the active eligible page only after an explicit user gesture |
| Default destination | Recover or create a private Quick Notes database | Delivers a working, searchable capture destination without asking users for IDs or duplicating it after an uncertain request |
| Structured mode | Create a database item | Better organization and search for users who want it |
| Local testing auth | Personal access token | Lets one developer test immediately |
| Public auth | Notion OAuth through a broker | Keeps the mandatory client secret out of extension code |
| Permissions | `activeTab`, `scripting`, plus Notion API | Injects the composer and reads title/URL at invocation time without reading page bodies |
| Keyboard shortcut | Browser-scoped `Command+Shift+Space` on macOS; `Ctrl+Shift+Space` elsewhere | Uses Chrome's reliable action command, remains customizable through Settings and `chrome://extensions/shortcuts`, and works only while the browser is active |
| Draft ownership | One active regular-profile draft | A new invocation safely flushes and resumes the draft in the selected tab without changing its original source context |
| Recent editing | Local drafts first, then five latest saved notes, plus recent Notion pages the integration can see | Makes returning to prior work immediate while still letting users pull in Notion-originating docs |
| Capture persistence | One IndexedDB row per regular draft/capture; one session key per Incognito record | Keeps autosaves proportional to the note being edited and preserves atomic draft-to-queue transitions |
| Recovery | Notes diagnostics plus JSON and Markdown export | Makes local storage health visible and gives users a credential-free escape hatch |
| AI assist | Explicit on-device title and to-do actions with editable previews | Adds focused help without putting generation in the capture or Save path |
| Lists | Native bullet, numbered, task, and mixed lists through ten list-item levels | Preserves editable Notion structure while keeping request and recovery behavior deterministic |

## What research changed

Notion now distinguishes databases from their underlying data sources. Database pages are created under a `data_source_id`, so the extension resolves a pasted database URL to its first data source before creating a note.

Managed Quick Notes databases use a versioned description marker and stable property-ID mappings for `Name`, `Source URL`, `Source Domain`, and `Captured At`. Setup persists its recovery marker before calling Notion, and only a marked, schema-compatible database can be adopted after a restart or uncertain response. Manual destinations are not migrated.

Notion's May 2026 authorization behavior returns fresh access and refresh token pairs on every successful public authorization. The broker now handles exchange, refresh-token rotation, and revocation; the deployed production path still needs end-to-end verification before release.

Flylighter's differentiation is not just clipping. Its flows, formatted highlights, property filling, append-to-previous-capture, shortcuts, and instant capture show that the long-term opportunity is a configurable capture layer. The MVP keeps only the behaviors that make the first capture feel excellent.

## Experience principles

1. **Thought first.** The cursor lands in an empty composer immediately.
2. **Context is explicit and visible.** The invoking page's title, URL, and focused-frame selection are captured once, at invocation time; a context-menu selection overrides the focused-frame selection.
3. **No modal labyrinth.** Destination configuration lives in settings, never in the capture loop.
4. **Quiet confidence.** Routine local autosaves stay invisible. “Saved to Notion” means confirmed remote delivery; local drafts, acceptance, and background retries remain clearly labeled in Notes.
5. **Permission proportionality.** Read only the invoking page's title and URL after the user opens Quick Note; never read page bodies automatically.
6. **Preserve before mutation.** Remote edits stop on fingerprint conflicts, keep unsupported blocks locked in place, and journal every replacement step locally.
7. **AI is optional and reviewable.** Prompt features run only after an explicit gesture, degrade away when unsupported or disabled, and keep output separate until the user applies it.

## List behavior

Quick Note preserves bullet, numbered, task, and mixed list types when saving, reopening, editing, and resaving. The outer list is level 1; levels 1 through 10 are supported. At level 10, Tab is consumed without changing the document, Shift+Tab still outdents, and the composer shows: “Quick Note supports up to 10 list levels. Outdent the deepest items before saving.”

Pasted, restored, or programmatically supplied documents deeper than ten levels remain editable and are still saved locally as drafts. Remote enqueue is blocked with the same message until the deepest items are outdented to level 10 or less.

## Release gates

- Verify refresh-token rotation and revocation against the deployed production broker
- Configure Cloudflare rate limits for the OAuth broker and verify its origin gate in production
- Test destination search indexing and automatic database creation across workspace roles
- Verify the full Chrome Web Store privacy disclosure
- Pin a stable production extension ID
- Run the existing real-MV3 termination/profile-relaunch suite in release CI
- Complete manual verification on difficult hosts, iframes, PDFs, Chrome internal pages, CSP-heavy sites, Incognito, and fullscreen media
- Pass production OAuth exchange/rotation/revocation and managed Capture ID deduplication against a test Notion workspace

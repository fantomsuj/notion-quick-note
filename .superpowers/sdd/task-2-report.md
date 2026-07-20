# Task 2 report: Strict Notion, settings, provisioning, and AI boundaries

Status: DONE

## Files

- `src/notion.ts`
- `src/settings.ts`
- `src/provisioning.ts`
- `src/ai-note-actions.ts`
- `tests/notion.test.ts`
- `tests/settings.test.ts`
- `tests/provisioning.test.ts`
- `tests/ai-note-actions.test.ts`

## Design

- Removed strictness suppressions and added explicit boundary/domain types for Notion requests, Prompt API sessions, settings defaults, and provisioning dependencies/results.
- Treats `response.json()`, direct database-resolution JSON, Prompt API responses, and caught errors as `unknown`.
- Adds handwritten guards for the response subsets actually consumed: database/data-source IDs and schema properties, search/query result arrays and items, page title properties, block IDs/types/attributes/rich text, inserted block IDs, error metadata, and Prompt title/to-do output.
- Malformed successful Notion payloads fail with `NotionApiError` (`code: "invalid_response"`) before provisioning or update journals save destination/remote state.
- Prompt output now requires an object with a string `title`, or an array containing only string tasks, before normalization.
- `DEFAULT_SETTINGS` has a stable `Readonly<Settings>` type while legacy OAuth credential migration behavior is unchanged.
- Provisioning ports, outcomes, persisted in-flight state, and error metadata are explicit; concurrency, recovery, uncertain-create, migration, and connection-change behavior are preserved.

## RED evidence

1. `npx tsc -b --force --pretty false`
   - Exit 2 after suppression removal.
   - Exposed strict boundary diagnostics in the four task modules and their focused/downstream consumers.
2. `npx tsx --test tests/ai-note-actions.test.ts tests/notion.test.ts --test-name-pattern='non-string tasks|incomplete successful'`
   - Exit 1.
   - Three intended failures: non-string Prompt tasks were accepted; incomplete database creation and incomplete search/block-list successes did not reject.

## GREEN evidence

1. `npx tsx --test tests/notion.test.ts tests/settings.test.ts tests/provisioning.test.ts tests/ai-note-actions.test.ts`
   - Exit 0; 57 tests passed, 0 failed.
2. `npx tsc -b --force --pretty false`
   - Exit 0; no diagnostics.
3. `git diff --check -- src/notion.ts src/settings.ts src/provisioning.ts src/ai-note-actions.ts tests/notion.test.ts tests/settings.test.ts tests/provisioning.test.ts tests/ai-note-actions.test.ts`
   - Exit 0.

## Concerns

- None identified within Task 2 scope.
- The workspace contains pre-existing/unrelated uncommitted changes; they were preserved. No files were staged, committed, restored, checked out, or reset.

## Review follow-up

Status: DONE

Addressed all Critical/Important review findings:

- Insert responses now require every consumed block ID to be a non-empty string before updating or emitting the journal.
- The final page response is validated for non-empty string `id`, `last_edited_time`, and `url` before the journal can enter `complete`.
- Database/data-source create and retrieval paths enforce non-empty string IDs; schema-consuming callers validate `properties` as an object of property objects.
- Rich-text guards validate consumed `type`, `plain_text`, `href`, `text.content`, `text.link.url`, annotation booleans/color, mention objects, and equation expressions.
- Sparse page payloads remain compatible: missing `properties` produces the historical `Untitled` fallback, while present properties are validated.
- Existing manual destinations now preserve their configured `page` or `database` type; provisioning results use the general `Destination` contract while creation/recovery/migration APIs remain managed-database-specific.
- Managed capture query results require a non-empty string ID and a string URL when present.

### Review RED evidence

`npx tsx --test tests/notion.test.ts tests/provisioning.test.ts`

- Exit 1; 40 passed and 7 failed.
- Intended failures covered invalid inserted IDs, malformed final pages, sparse pages, wrong-type create/retrieve IDs, malformed rich text, wrong-type query results, and manual-page destination coercion.

### Review GREEN evidence

1. `npx tsx --test tests/notion.test.ts tests/settings.test.ts tests/provisioning.test.ts tests/ai-note-actions.test.ts`
   - Exit 0; 64 passed, 0 failed.
2. `npx tsc -b --force --pretty false`
   - Exit 0; no diagnostics.
3. `git diff --check -- src/notion.ts src/settings.ts src/provisioning.ts src/ai-note-actions.ts tests/notion.test.ts tests/settings.test.ts tests/provisioning.test.ts tests/ai-note-actions.test.ts`
   - Exit 0.
4. Suppression scan across all eight focused files
   - No `ts-nocheck`, `ts-ignore`, or blanket `any` usage.

## Second review follow-up

Status: DONE

- Migration PATCH responses now require a non-empty string data-source `id` and a property-object map before the updated destination is consumed.
- Data-source retrieval and managed-database recovery validate `parent.database_id` and fallback `database_id` as non-empty strings when present. Malformed successful payloads now throw `NotionApiError` with `code: "invalid_response"` before ID normalization.
- Block response guards now validate optional `has_children`/`in_trash` booleans and `last_edited_time`, plus the consumed attribute fields `checked`, `language`, `list_start_index`, and `list_format`. Inline child blocks are validated recursively.

### Second review RED evidence

`npx tsx --test tests/notion.test.ts`

- Exit 1; 39 passed and 3 failed.
- Intended failures covered malformed optional/consumed block fields, malformed retrieval/recovery parent database IDs leaking a raw `TypeError`, and a wrong-type migration PATCH ID being accepted.

### Second review GREEN evidence

1. `npx tsx --test tests/notion.test.ts tests/settings.test.ts tests/provisioning.test.ts tests/ai-note-actions.test.ts`
   - Exit 0; 67 passed, 0 failed.
2. `npx tsc -b --force --pretty false`
   - Exit 0; no diagnostics after correcting the new test fixtures to include the required migration marker.
3. `git diff --check -- src/notion.ts tests/notion.test.ts .superpowers/sdd/task-2-report.md`
   - Exit 0 after the report append.
4. Suppression scan across the touched production and test files
   - No `ts-nocheck`, `ts-ignore`, `eslint-disable`, or blanket `any` usage.

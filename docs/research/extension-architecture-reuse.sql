WITH architecture("order", primitive, current_support, thread_work) AS (
  VALUES
    (1, 'One active regular-profile draft', 'A thought follows explicit invocations across tabs', 'Expose the behavior as an intentional thread state'),
    (2, 'Cross-tab context merge', 'Adds a new source and appends a selected passage', 'Add a stable clip record and explicit add-to-thread copy'),
    (3, 'Up to 20 URL-deduplicated sources', 'Tracks distinct pages with a stable primary source', 'Separate page identity from repeated clip provenance'),
    (4, 'Recent editing and stashed-draft return', 'Reopens local/remote notes without losing the active draft', 'Use it for deliberate resume and finish flows'),
    (5, 'Revision and remote-conflict protection', 'Prevents stale cross-tab and destructive remote edits', 'Extend fingerprints and migrations to clip-level state'),
    (6, 'Durable queue and recovery export', 'Reconciles ambiguous saves and preserves recoverable records', 'Verify clip/source counts through atomic enqueue and delivery'),
    (7, 'Reviewed on-device AI', 'Suggests titles and to-dos without cloud fallback', 'Add optional chunked thread synthesis after the manual MVP')
)
SELECT "order", primitive, current_support, thread_work
FROM architecture
ORDER BY "order" ASC;

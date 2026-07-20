# Task 6 bundle-budget report

Status: **BUNDLE SUBTASK COMPLETE**

This report covers only the bounded content-bundle optimization and its relevant verification. It does not mark the complete Task 6 release/acceptance checklist complete.

## Outcome

- Assignment baseline: `458,122 / 450,000` bytes.
- Fresh build on entry: `449,188 / 450,000` bytes, but only because `src/content.ts` had regressed to validating the generic `{ ok: boolean }` envelope and then casting unknown successes.
- Restoring correlated content response validation initially produced `453,313` bytes at that workspace snapshot.
- Final fresh production build: **`449,812 / 450,000` bytes**.
- Net change from the reported failing baseline: **8,310 bytes smaller**, while restoring stricter boundary behavior and the full eager composer-template contract.

Metafile evidence is saved in `.context/content-final-meta.json` and `.context/content-final-analysis.txt`. The dominant contributors remain Tiptap/ProseMirror; the final relevant local contributions were approximately `71.7kb` from `src/content.ts`, `3.6kb` from `src/contracts.ts`, and `2.1kb` from `src/runtime-message.ts` before the final compact-map pass.

## Delivered

- Added an exhaustive `ContentRuntimeRequest` subset and `isContentRuntimeResponse(request, unknown)` guard.
  - Every request sent by the content surface is correlated with its exact success response.
  - Failure envelopes require a string error.
  - Draft, capture-status, recent-item, settings, load, enqueue, and empty-success responses validate their consumed fields before use.
- Routed the content surface through the correlated guard and removed the generic success cast.
- Exported the existing focused draft/status/recent validators so esbuild can include only the content-required validation graph instead of the complete background response switch.
- Tightened recent-item validation to reject unknown sources and malformed optional fields.
- Re-encoded delivery-state and delivery-error-kind membership as compact arrays. This is behaviorally equivalent to the former long comparison chains and saved about 4.4KB in the minified bundle at the measured snapshot.
- Removed the unused exported `MESSAGE_TYPES` `Set`; request validation continues to use the exhaustive literal message list.
- Kept the concurrent explicit Tiptap extension imports, preserving the complete StarterKit feature set without bundling the StarterKit wrapper.
- Restored complete eager, concrete composer-template validation with compact constructor groups:
  - every singleton selector is validated;
  - every list selector must be non-empty and every member must have the mapped concrete class;
  - mapped lookups return constructor-validated values and contain no `as unknown as` escape.
- Added two RED-to-GREEN browser regressions for previously unchecked singleton and list mappings.
- Configured the production content build to emit UTF-8 and drop dependency `console` calls. Debug builds retain console output. No application feature, guard, budget, or target changed.

## Tradeoffs

- Production no longer includes Tiptap/ProseMirror console warnings. User-visible error handling, thrown errors, debug builds, and extension behavior are unchanged.
- UTF-8 output relies on Chrome's normal UTF-8 extension-resource handling and is compatible with the existing Chrome 116 target.
- The budget has narrow headroom, but the gate remains unchanged and passes without excluding behavior or validation.

## TDD evidence

RED:

- `tests/runtime-message.test.ts` failed because `isContentRuntimeResponse` did not yet exist.
- The new malformed recent-item case initially returned `true` for an unknown `source`.
- The two new template tests initially mounted successfully after replacing `.recent-search` and `.color-swatch` with the wrong concrete class.

GREEN:

- The response table now covers all 18 content request variants and verifies valid plus malformed correlated responses.
- Unknown recent-item sources now fail closed.
- All four composer-template regression tests pass, including the two new complete-map checks.

## Final scoped verification

- `npx tsc -b --force --pretty false`: pass, zero diagnostics.
- `npx tsc -b tsconfig.extension.json --force --pretty false`: pass.
- `npm test`: **181 passed, 0 failed**.
- `npx tsx --test tests/runtime-message.test.ts tests/panel-lifecycle.test.ts tests/panel-coordinator.test.ts`: **26 passed, 0 failed**.
- Relevant Quick Note Playwright regressions (template validation, discard recovery, rejected event promises, Recent flows, timeout reconciliation, toolbar/palettes): **13 passed, 0 failed**.
- `npm run build`: pass.
- `npm run check:bundle`: **`449,812 / 450,000` bytes**, pass.
- `git diff --check` on touched bundle/guard/content/test files: pass.
- Suppression/blanket-any scan on the scoped files: no matches.

No files were staged, committed, restored, reset, or checked out.

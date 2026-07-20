# Task 3 brief: Balanced selection toolbar and focus treatment

## Ownership and safety

Implement only the selection-toolbar/color/focus portion of the approved Persistent Composer plan. Work in the shared dirty worktree. Preserve all staged, unstaged, and untracked user/agent work. Do not stage, commit, reset, restore, or check out files. Use TDD: add focused failing browser/design/type tests first, record RED evidence, then implement and verify. Do not edit Task 1/2 reports or their coordinator/background/side-panel implementation unless a direct compile-safe import is required.

Primary scope:

- `src/content.ts`
- `src/contracts.ts` only for the exported color-name type
- `styles/composer.css`
- `styles/tokens.css`
- `tests/browser/quick-note.spec.ts`
- `tests/design.test.ts`
- `tests/types/contracts.test-d.ts` if useful
- a new `.superpowers/sdd/persistent-composer/task-3-report.md`

## Requirements

1. Add/export a `NotionColorName` union covering exactly `default`, gray, brown, orange, yellow, green, blue, purple, pink, and red. Background choices use the same Tiptap `notionColor` mark with corresponding `<name>_background` values because Notion permits one color annotation per rich-text run.
2. Replace the current bubble toolbar with the approved Balanced hierarchy. Always visible, in order: Text, Link, Bold, Italic, Underline, Overflow. Overflow contains Strikethrough, Inline code, Text color, Highlight. Do not leave strike/code visible outside overflow.
3. Replace punctuation-only action icons with the project inline-SVG treatment. Conventional typographic B/I/U glyphs are allowed. Link, overflow, inline code, and color/highlight affordances need accessible labels and non-punctuation SVG/icon treatment.
4. Text color and Highlight open keyboard-accessible palette submenus with all ten choices including Default. Choosing text color replaces an existing background annotation; choosing highlight replaces an existing text color; Default removes the `notionColor` mark. The exact stored values are base color names for text and `_background` for highlights.
5. Preserve the editor selection while opening menus and applying formatting. Keep command active states and use `aria-pressed` for toggles and `aria-expanded`/`aria-haspopup` for menus. Support Escape, focus return to the invoker, and outside-click dismissal without losing the selected range.
6. Keep the toolbar usable at a 320px panel viewport. Its primary row must fit without horizontal clipping; overflow/palette menus must remain inside the sheet.
7. Add complete light/dark tokens and distinct visible rendering for every base text color and every background color; do not collapse backgrounds into a neutral shade. Existing persisted Notion colors must render correctly too.
8. Fix `.page-title` focus specifically after the broad global `:focus-visible` rule: remove the blue `#2383e2` line/outline and use a subtle neutral rounded focus treatment with a visible caret. Preserve the blue keyboard focus ring for buttons, menus, swatches, and other controls.

## Required tests

At minimum add focused coverage for:

- Exact visible-toolbar and overflow command hierarchy, SVG action icons, and 320px fit.
- Bold/italic/underline plus overflow strike/code active states and `aria-pressed`.
- Link add and remove while preserving the chosen range.
- Every text and highlight color, their exact `notionColor` values, mutual replacement, and Default removal.
- Palette/overflow keyboard behavior: `aria-expanded`, Escape closes the topmost menu and returns focus, outside click dismissal, selection preservation.
- Dark-mode color distinction and palette usability.
- Title focus has no blue outline while keyboard-focused controls retain the configured visible blue focus ring.

Prefer behavioral Playwright assertions over source-regex assertions; use design tests only where they protect architecture/token invariants. Avoid broad snapshot churn unless the toolbar is already part of a stable targeted snapshot.

## Verification and report

Run the new focused tests first, then the complete composer browser spec, the relevant node/type tests, `npm run build && npm run check:bundle`, and `git diff --check`. Record exact commands/results and any pre-existing unrelated failures in `task-3-report.md`, along with an exact file list and concerns. Do not claim a repository-wide green typecheck unless you actually run it successfully.

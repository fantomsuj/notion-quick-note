# Extension opportunity study — source and method notes

As of July 19, 2026.

## Decision

Choose the next product direction that best complements Notion Quick Note's reliable, privacy-first capture base while creating a distinctive user benefit.

## Evidence boundary

- Current Chrome Web Store listing metrics were recorded for Save to Notion, Notion Web Clipper, Flylighter, and Notate.
- Chrome-Stats pages collectively reference 1,627 review records for the three primary comparators (1,095 + 521 + 11). This study uses the public summaries and visible recent samples, not the gated full text corpus. Theme mentions are therefore directional source-level signals, not statistically representative review frequencies.
- Two recent Reddit threads were used as anecdotal corroboration, not as prevalence estimates.
- Official competitor docs establish claimed capabilities; they do not verify reliability.
- Official Chrome and Notion documentation controls technical feasibility claims.
- The local repository controls claims about Notion Quick Note's current behavior.

## Scoring model

Each opportunity is rated from 1 (weak) to 5 (strong) on:

- Demand signal: 30%
- Product fit: 25%
- Differentiation: 20%
- Feasibility: 15%
- Privacy and trust: 10%

Weighted score = `0.30 × demand + 0.25 × fit + 0.20 × differentiation + 0.15 × feasibility + 0.10 × privacy/trust`.

Scores are decision aids, not measured forecasts. A half-point change in one factor is not statistically meaningful; the model is intended to make tradeoffs explicit.

## Theme coding

- Reliability and delivery trust: repeated negative signal across all three primary competitor review summaries and both recent Reddit threads.
- Speed and simplicity: repeated positive signal in official positioning and review summaries.
- Property-aware routing: strong explicit demand in official Web Clipper reviews and a major feature in Save to Notion and Flylighter.
- Rich capture fidelity: feature demand spans images, screenshots, tables, formatted highlights, articles, video, and PDFs; extraction failures are also a recurring complaint.
- Multi-clip research: Flylighter and Notate explicitly support multi-highlight or collection workflows; Notion Quick Note already contains most of the underlying local primitives.
- Authentication and account clarity: recurring friction across review summaries and samples.
- Return-to-source context: a smaller but differentiated signal from Notate's scrollback, video timestamp, and PDF positioning.
- Local synthesis: weak direct demand evidence, but unusually strong fit with the extension's existing reviewed on-device AI posture.

## Chart map

- Opportunity prioritization: comparison/ranking bar chart using `extension-opportunity-scorecard.csv`. Single-root blue palette, zero baseline, exact score in tooltips, no redundant series legend.

## Required-structure mapping

- Title: `Where Notion Quick Note Should Go Next`
- Executive summary: visible immediately after the title
- Key findings with evidence: market/review synthesis, opportunity ranking, and recommendation sections
- Recommended next steps: prototype and validation plan
- Further questions: explicit section near the end
- Caveats and assumptions: explicit final section

## Chosen concept: Evidence threads

An evidence thread is one durable Quick Note that accumulates selected passages, personal annotations, and source links across multiple tabs before the user finishes and sends it to Notion.

The codebase already has a one-active-draft model, cross-tab context merge, quote append, URL-deduplicated sources, revision protection, Recent editing, a durable queue, and reviewed local AI. The primary product work is to expose this as an intentional workflow and preserve clip-level provenance instead of treating it as incidental draft behavior.

Proposed data addition:

```text
clips[] = {
  id,
  sourceId,
  kind: selection | note | link,
  text,
  locator?,
  capturedAt
}
```

`sources[]` remains the distinct-page index. `clips[]` preserves repeated selections from the same page and their provenance.

## Validation assessment

Overall: Share with caveats.

- Store scale and rating claims are current and directly sourced.
- Technical feasibility claims are supported by repository and official platform/API documentation.
- Review themes are directionally useful but are not raw-corpus frequency estimates.
- The weighted ranking is a transparent judgment model, not a causal or revenue forecast.
- The next confidence-building step is a small prototype and 8–12 task-based sessions with researchers, students, analysts, and heavy Notion users.

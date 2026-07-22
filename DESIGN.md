# Notion Quick Note design system

This file is the visual source of truth for the onboarding page and floating composer. Product behavior and architecture remain documented in `docs/PRODUCT.md` and `docs/VISUAL_GUIDE.md`.

## Direction

The extension uses Notion's restrained product language: quiet neutral surfaces, compact controls, direct hierarchy, and shallow elevation. The onboarding page should feel like a focused Notion page; the responsive 390px composer should feel like a compact Notion page in a popover. Apple Quick Note remains an interaction reference for fast invocation only, not a styling reference.

## Color

### Approved brand palette

| Role | Value | Use |
|---|---:|---|
| Red | `#f64932` | Brand or semantic accents only |
| Yellow | `#ffb110` | Brand or semantic accents only |
| Blue | `#097fe8` | Brand artwork and non-text accents |
| Gray | `#f6f5f4` | Brand neutral |
| Black | `#000000` | Approved logo artwork |
| White | `#ffffff` | Approved logo artwork and text on actions |

### Product palette

Light surfaces are `#ffffff`, `#f9f8f7`, and `#f0efed`. Dark surfaces are `#191919`, `#202020`, and `#252525`. The semantic implementation lives in `styles/tokens.css` so both extension surfaces share the same roles.

Small muted text uses `#5f5e59` in light mode. Primary buttons use `#0077d4` so white labels meet WCAG AA. `#7d7a75` and `#2383e2` are reserved for larger text, icons, focus rings, and non-text accents. Feedback colors must always be paired with text or an icon; color is never the only signal.

## Typography

Bundle NotionInter locally in Regular 400, Medium 500, Semibold 600, and Bold 700. Regular is the default body weight and Semibold is the default heading weight. The fallback stack is open-source Inter, then the system sans stack; Inter is available under the [SIL Open Font License](https://github.com/rsms/inter/blob/master/LICENSE.txt).

| Role | Tracking | Line height |
|---|---:|---:|
| Page heading | `-3%` | `105%` |
| Panel/subheading | `-1%` | `120%` |
| Body and controls | `0` | `140%` |

The onboarding title is 40px, panel headings are 20px, explanatory copy is 15px, and compact controls and metadata are 12–13px. Notion's Serif (Lyon Text) and Mono (iA Writer Mono) modes are page-style references only; neither font is bundled because these surfaces do not expose Notion's page-font selector.

## Shape, spacing, and elevation

- Use a 4px spacing foundation.
- Controls use 6px radii, structural panels use 8px, and the composer uses a 10px outer radius.
- Do not introduce radii larger than 10px.
- Use borders before shadows. Panels use the shallow outline shadow; only the floating composer uses the oversized popover shadow.
- Do not use blur, translucency as a surface treatment, gradients, or decorative glass effects.

## Components

Primary actions are accessible blue. Secondary actions use a neutral outline and translucent hover state. Focus uses a visible 2px blue ring. Functional state transitions run for 150–180ms and are removed under `prefers-reduced-motion`.

The onboarding sequence remains Connect → Destination → Ready with progressive disclosure for advanced configuration. The composer keeps a 40px header, a 15px page editor with an optional title and quote blocks, and a compact overflow menu for destination, source attachment, and settings. Within the editor, the first `Command/Ctrl+A` selects the current non-empty block's text and the second selects the complete document; an empty block selects the complete document immediately. Adjacent headings, body blocks, and lists use relationship-aware spacing so section openings stay grouped without flattening the document hierarchy. Long workspace, page, and destination names truncate instead of changing layout.

Use the bundled Notion cube artwork for Notion identity. UI actions use consistent 16px inline SVG icons; never substitute letters, punctuation, or Unicode glyphs for logo, more, search, refresh, close, or check controls.

## Accessibility and compatibility

Both surfaces support light and dark browser preferences, keyboard-only operation, visible focus, reduced motion, and widths below 640px. All fonts and design assets are packaged with the extension; the UI must not issue remote font or asset requests. Styling may change without changing OAuth, storage keys, Notion messages, draft behavior, or save timing.

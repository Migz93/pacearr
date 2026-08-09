<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Colour Scheme

Pacearr uses a fixed dark-mode palette defined as CSS custom properties in
`src/client/styles.css` under the Tailwind v4 `@theme` block. Components should
reference these variables through Tailwind utility classes (`bg-*`, `text-*`,
`border-*`) for normal colour usage. Poster, episode, and responsive layout
rules are Tailwind utility classes directly in component JSX; `styles.css`
holds only the theme tokens and a small `@layer base` reset for bare
elements (`body`, `button`, `h1`/`h2`). Form controls (`TextInput`,
`SelectInput`, `Field`, `ToggleField`, `SectionCard`, `SaveBar`) are shared
components in `src/client/components/FormControls.tsx`, not global CSS. Page
layout (`Page`, `PageHeader`, `PageLoading`, `ErrorBanner`) is shared the same
way in `src/client/components/Page.tsx` — every authenticated app route
(Dashboard, Shows, Users, History, Settings) renders inside `Page`, so container
width and heading size are set in one place rather than per page. Login, the
Plex OAuth popup screens, and the top-level bootstrap/loading states in
`App.tsx` render outside `Page` — they're full-bleed or centred layouts with
no sidebar, not a page in the shell's sense.
Status badges use the shared `badgeClass()` helper in `src/client/lib/utils.ts`
instead of inline colour classes. Raw colour values in component JSX are not
permitted.

## The Palette

### Background scale

Six steps from darkest (page base) to lightest (hover states). Use in elevation
order — deeper backgrounds sit behind shallower ones.

| Variable | Hex | Role |
|---|---|---|
| `background` | `#0d0e12` | Page-level backgrounds, input wells, modal overlays |
| `background-container-low` | `#121318` | Sidebar, nav rail, inset surfaces |
| `background-container` | `#18191e` | Default cards and panels |
| `background-container-high` | `#1e1f25` | Elevated cards, resting buttons, selected controls |
| `background-container-highest` | `#24252b` | Tooltips, popovers, elevated row hovers |
| `background-bright` | `#2a2c32` | Button hover state, interactive element hover |

### Brand / interactive

Two steps of the brand red. Use `primary-dim` for resting interactive states
and `primary` for hover only — this gives a consistent brighten-on-hover feel
and keeps resting contrast above WCAG AAA (7:1 against `on-surface`).

| Variable | Hex | Role |
|---|---|---|
| `primary` | `#e50914` | Hover state, active indicators, and brand accent |
| `primary-dim` | `#ae0610` | Resting state for buttons, active nav, filters, toggles, and badges |

### Text

| Variable | Hex | Role |
|---|---|---|
| `on-surface` | `#faf8fe` | Primary text and text on coloured backgrounds |
| `on-surface-variant` | `#abaab0` | Secondary text: subtitles, hints, and inactive labels |

### Border

| Variable | Hex | Role |
|---|---|---|
| `outline-variant` | `#47484c` | Borders and dividers, used at reduced opacity |

### Status

| Variable | Hex | Role |
|---|---|---|
| `success` | `#22c55e` | Enrolled, reclaimed-space, healthy, and successful states |
| `warning` | `#f59e0b` | Warnings and non-critical notices |
| `error` | `#f07070` | Errors, validation failures, and destructive actions |

## Contrast

All text/background pairings in active use pass WCAG AA (4.5:1 for normal text).

| Text | Background | Ratio |
|---|---|---|
| `on-surface` on any background step | worst case `background-bright` | 13.2:1 |
| `on-surface-variant` on any background step | worst case `background-bright` | 6.1:1 |
| `on-surface` on `primary-dim` | Buttons, badges | 7.0:1 (AAA) |
| `on-surface` on `primary` | Hover state | 4.6:1 (AA) |
| `success` on tinted `success/18` badge fill | Status badges, worst case `background-container-high` | 5.2:1 (AA) |
| `warning` on tinted `warning/16` badge fill | Status badges, worst case `background-container-high` | 5.7:1 (AA) |
| `error` on tinted `error/15` badge fill | Status badges, worst case `background-container-high` | 4.6:1 (AA) |

## Rules

- Never use `primary` or `primary-dim` as a text colour on dark backgrounds.
- Use `on-surface` for text on coloured backgrounds to keep the off-white tone consistent.
- Status colours are for text and subtle tinted backgrounds only; do not use them as solid button backgrounds.
- Keep green success semantics for enrolled, healthy, and reclaimed-space states; red is reserved for Pacearr branding and interaction.
- `outline-variant` is a border colour only, never used for text.

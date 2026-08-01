<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Colour Scheme

Pacearr uses a fixed dark-mode green palette defined as CSS custom properties in
the `:root` block of `src/client/styles.css`. Components reference them through
semantic classes in that same stylesheet (`.panel`, `.stat-card`, `.badge`,
`.nav-item`) rather than through utility classes.

> **Pacearr is the odd one out.** Hubarr and ShelfBridge share a red palette
> driven by a Tailwind v4 `@theme` block, and forbid raw hex values in component
> code. Pacearr predates that convention: Tailwind is installed but not used for
> colour, and **23 hardcoded hex values** remain scattered through
> `styles.css` outside the variable system. Both the palette and the mechanism
> are under review in
> [#51](https://github.com/Migz93/pacearr/issues/51).

## The Palette

### Background scale

| Variable | Hex | Role |
|---|---|---|
| `--bg` | `#121516` | Page-level background |
| `--panel` | `#1b2021` | Default cards, panels, sections, tables |
| `--panel-2` | `#242a2b` | Elevated surfaces: buttons at rest, nav hover, popovers |

Three further background values are hardcoded rather than tokenised:

| Hex | Where | Role |
|---|---|---|
| `#171b1c` | `.sidebar` | Sidebar background, one step below `--bg` |
| `#151819` | `.season-panel`, `.episode-table` | Inset surfaces inside a panel |
| `#101313` | `input`, `select`, `.shows-toolbar` | Input wells, recessed controls |
| `#1c2021` | `.season-row:hover` | Row hover |
| `#2b3233` | avatar fallback, popup hover | Highest-elevation hover |
| `#3a4244` | `.toggle-track` | Inactive toggle track |

### Brand / interactive

Two steps of the brand green. `--primary-2` is the resting state and `--primary`
the brighter accent, the same brighten-on-hover relationship hubarr and
ShelfBridge use.

| Variable | Hex | Role |
|---|---|---|
| `--primary` | `#6fd3a6` | Brand accent, active indicators, logo mark |
| `--primary-2` | `#2d7c61` | Resting state for primary buttons |

Also hardcoded: `#3f9a77` (Plex login button hover) and `#1f5542` (login brand
mark gradient stop).

### Text

| Variable | Hex | Role |
|---|---|---|
| `--text` | `#eef2ef` | Primary text |
| `--muted` | `#9aa7a1` | Secondary text: subtitles, hints, inactive nav items, stat labels |

### Border

| Variable | Hex | Role |
|---|---|---|
| `--line` | `rgba(238, 242, 239, 0.1)` | Borders and dividers — an alpha value, not a solid hex |

### Status

| Variable | Hex | Role |
|---|---|---|
| `--danger` | `#ff7b7b` | Errors, destructive action indicators |
| `--warn` | `#dcb867` | Warnings, non-critical notices |

There is no `--success` variable. Success and "enrolled" states use hardcoded
tints instead:

| Hex | Where | Role |
|---|---|---|
| `#c5f4dc` | `.show-state.enrolled`, `.inline-success` | Enrolled and success text |
| `#dcf9e9` | `.poster-savings-badge` | Reclaimed-space badge text |
| `#f5fff9` | `.plex-login-button` | Text on the Plex login button |
| `#f0d696` | `.badge.warn`, `.callout.warn` | Warning text, lighter than `--warn` |
| `#ffc1c1` | `.dashboard-attention`, `.inline-error` | Error text, lighter than `--danger` |

## Contrast

Text pairings in active use pass WCAG AA (4.5:1 for normal text) against the
background scale. The greens are used as accents and tinted text, not as
backgrounds for small text.

| Text | Background | Notes |
|---|---|---|
| `--text` on `--bg` / `--panel` / `--panel-2` | — | Comfortably above AA |
| `--muted` on `--panel` | — | Passes AA for body text |
| `--text` on `--primary-2` | Primary buttons | Passes AA |

These have not been re-measured since the palette was written. If the palette
changes under [#51](https://github.com/Migz93/pacearr/issues/51), recompute them
against the ratios documented in hubarr's and ShelfBridge's colour-scheme docs.

## Rules

- Prefer a `:root` variable over a raw hex. The hardcoded values listed above are
  legacy, not a precedent — do not add more.
- Never use `--primary` or `--primary-2` as a text colour on dark backgrounds.
- The lighter status tints (`#c5f4dc`, `#f0d696`, `#ffc1c1`) are for text and
  subtle tinted backgrounds only — do not use them as solid button backgrounds.
- `--line` is a border colour only, not used for text.
- Green currently carries meaning in Pacearr beyond branding: enrolled state and
  reclaimed disk space both read as "green = good". Keep that association intact
  when adding new UI.

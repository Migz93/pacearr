# Mobile & Responsive Review

Read this before changing layout, adding a new page-level container, or adding
an `auto-fill`/`minmax()` grid. It documents the breakpoints Pacearr actually
uses, how to verify a mobile layout against a real running instance, and two
non-obvious CSS traps found during the #87 mobile audit.

## Breakpoints In Use

| Breakpoint | Where | Purpose |
|---|---|---|
| `md` (768px, Tailwind default) | `Layout.tsx` | Sidebar switches between the permanent desktop rail and the off-canvas mobile drawer |
| `max-[820px]` | Most page headers/controls (`Shows.tsx`, `Users.tsx`, `Settings.tsx`, `Dashboard.tsx`) | Control rows and multi-column grids stack to a single column or reduced column count for tablet-and-below |
| `max-[480px]` | `Users.tsx` viewer grids, `Shows.tsx` poster grid | Phone-specific overrides where the 820px tablet value still doesn't leave enough room on a ~375px phone |

Every authenticated route renders inside `Page` (`components/Page.tsx`), which
sets `mx-auto max-w-7xl p-6`. Available content width for breakpoint math is
`min(viewport width, 1280px) − 48px` — viewport-driven below `max-w-7xl`
(1280px), capped at `1232px` above it.

## Gotchas Found By The #87 Audit

| Gotcha | Symptom | Fix |
|---|---|---|
| A `flex-1` container without `min-w-0` sizes to its widest unwrappable descendant, not the viewport. A flex item's automatic minimum width is its content's min-content size; a nested `overflow-x-auto` bar with `whitespace-nowrap` labels (or a long unbroken link) forces the whole page wider than the viewport instead of scrolling/wrapping internally. | Real horizontal page scroll on the Shows tab bar and Settings → About's GitHub URL. | `min-w-0` on `Layout.tsx`'s content column (`min-w-0 flex-1 md:ml-64`). Give any new top-level flex/grid container `min-w-0` (or `min-h-0` in a column layout) unless it's deliberately meant to grow with its content. |
| `auto-fill`/`minmax()` grids have a pixel-fixed column floor. A valid grid track can still silently collapse to fewer columns than intended once the real (post-fix) content width is available — no overflow, just a much taller page. | Shows poster grid (`minmax(158px,1fr)`) held 2 columns down to tablet width but dropped to 1 on a 375px phone (327px content width, 5px short of two 158px tracks + gap), tripling page height. Was masked by the `min-w-0` bug above artificially widening the page. | Work out the column count the component needs at phone width (some card content genuinely needs to stay wide and should legitimately be one column), then add a `max-[480px]:` override tuned to that count. Verify with `getBoundingClientRect()` on the grid's children in a script — not a screenshot. |

## How To Verify A Mobile Layout Against A Real Instance

Vite's dev server (`npm run dev:client`) has no API proxy, so it can't
exercise authenticated routes. Verification needs a rebuilt container (see
"Rebuilding The Container After Code Changes" in `AGENTS.md`) plus a real
session:

1. Rebuild and recreate the `pacearr` container from the current workspace.
2. Get a fresh `pacearr_session` cookie (see `TESTING.md`'s Playwright setup)
   into `tests/playwright/.auth/storageState.json`, matching the `domain` the
   instance is actually reached at — a cookie saved for one host isn't sent
   when Chromium hits a different host/IP for the same instance (e.g. a
   Docker bridge gateway IP vs. the LAN IP the cookie's `domain` was set to).
   An always-login-page response with no connection error usually means this,
   not a real expiry.
3. Drive Playwright at phone viewport sizes (375×667 and 390×844 cover the
   common range) against each authenticated route. Check
   `document.documentElement.scrollWidth` vs. `clientWidth` for page-level
   horizontal overflow, and `getBoundingClientRect()` on interactive elements
   for anything under 24×24px (ignore visually-hidden inputs behind a styled
   label/peer, and inner `<input>`/`<select>` elements whose *containing*
   control is already tall enough).
4. For dialogs (`position: fixed` overlays), verify with a viewport-only
   screenshot, not `fullPage: true` — Playwright's full-page mode resizes the
   capture to full document height, which renders fixed elements pinned to
   their initial position instead of centered in the visible viewport (a
   screenshot-tool artifact, not a real rendering bug).

## Deferred Follow-Ups

Tracked in #102, not fixed in #87 because they affect desktop layout too
(not mobile-specific regressions) and need a deliberate design pass:

- Viewer-card checkbox touch target (18×18px)
- Shows tab-bar scroll affordance
- Settings → About version-link height

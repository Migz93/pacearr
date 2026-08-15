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
sets `mx-auto max-w-7xl p-6`, inside `Layout.tsx`'s content column
(`min-w-0 flex-1 md:ml-64`). Available content width for breakpoint math:

| Viewport | Available content width |
|---|---|
| `< 768px` (below `md`, sidebar off-canvas) | `viewport width − 48px` |
| `≥ 768px` (sidebar's fixed 256px reserved via `md:ml-64`) | `min(viewport width − 256px, 1280px) − 48px` |

## Gotchas Found By The #87 Audit

Root cause and impact for each is documented as a code comment at the fix
site, linked below — this table is just the operational rule.

| Gotcha | Rule |
|---|---|
| `flex-1` container without `min-w-0` sizes to its widest unwrappable descendant, not the viewport. See the comment above [`Layout.tsx`'s content column](../src/client/components/Layout.tsx). | Give any top-level flex/grid container `min-w-0` (or `min-h-0` in a column layout) unless it's deliberately meant to grow with its content. |
| `auto-fill`/`minmax()` grid column floor can silently collapse to fewer columns than intended at phone width, with no overflow — just a much taller page. See the comment above the [Shows poster grid](../src/client/pages/Shows.tsx). | Work out the column count the component needs at phone width (some card content genuinely needs to stay wide and should legitimately be one column), then add a `max-[480px]:` override tuned to that count. Verify with `getBoundingClientRect()` on the grid's children in a script — not a screenshot. |

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

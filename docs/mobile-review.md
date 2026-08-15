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
| `max-[480px]` | `Users.tsx` viewer grids, `Shows.tsx` poster grid | Phone-specific overrides where the 820px tablet value still doesn't leave enough room on a ~375px phone (see gotchas below) |

Every authenticated route renders inside `Page` (`components/Page.tsx`), which
sets `mx-auto max-w-7xl p-6` — that's 48px of horizontal padding on every
route at every width, so "available content width" for reasoning about a
breakpoint is always `viewport width − 48px`.

## Two Gotchas Found By The #87 Audit

**A `flex-1` container without `min-w-0` grows to fit its widest unwrappable
descendant, not the viewport.** `Layout.tsx`'s content column
(`min-w-0 flex-1 md:ml-64`) sits in a flex row next to the (position-fixed,
out-of-flow) sidebar. Without `min-w-0`, a flex item's automatic minimum width
is its content's min-content size — so a deeply nested `overflow-x-auto` pill
tab bar with `whitespace-nowrap` labels, or a long unbroken link, forced the
*entire page* wider than the viewport instead of scrolling or wrapping
internally. This showed up as real horizontal page scroll on the Shows page
(tab bar) and Settings → About (the GitHub URL). Any new top-level flex/grid
container should carry `min-w-0` (or `min-h-0` in a column layout) unless it's
deliberately meant to grow with its content.

**`auto-fill`/`minmax()` grids have a pixel-fixed column floor that can
silently collapse to one column on a phone.** The Shows poster grid
(`[grid-template-columns:repeat(auto-fill,minmax(158px,1fr))]`) fits 2 columns
down to tablet width, but a 375px phone only has 327px of content width after
`Page`'s padding — one 5px short of fitting two 158px tracks plus the gap. The
grid didn't overflow (it's a valid grid track), it just silently rendered as a
single tall column instead of two, multiplying page height. This was masked
for a long time by the `min-w-0` bug above artificially widening the page.
Give any `auto-fill` grid a `max-[480px]:` override tuned to keep at least 2
columns on a phone, and verify column count directly — via
`getBoundingClientRect()` on the grid's children in a script, not by trusting
a screenshot — rather than assuming a valid grid track means the layout is
right.

## How To Verify A Mobile Layout Against A Real Instance

Vite's dev server (`npm run dev:client`) has no API proxy, so it can't
exercise authenticated routes. Verification needs a rebuilt container (see
"Rebuilding The Container After Code Changes" in `AGENTS.md`) plus a real
session:

1. Rebuild and recreate the `pacearr` container from the current workspace.
2. Get a fresh `pacearr_session` cookie value (see `TESTING.md`'s Playwright
   setup) and put it in `tests/playwright/.auth/storageState.json`, matching
   the `domain` the running instance is actually reached at — a cookie saved
   for one host is not sent when Chromium is pointed at a different host/IP
   for the same instance (e.g. a Docker bridge gateway IP vs. the LAN IP the
   cookie's `domain` was set to). A cookie that looks "expired" from
   `ERR_CONNECTION_REFUSED`-free but always-login-page responses is usually
   this, not a real expiry.
3. Drive Playwright at phone viewport sizes (375×667 and 390×844 cover the
   common range) against each authenticated route. For every route, check
   `document.documentElement.scrollWidth` vs. `clientWidth` for page-level
   horizontal overflow, and scan interactive elements for a
   `getBoundingClientRect()` under 24×24px (ignore visually-hidden inputs
   behind a styled label/peer, and inner `<input>`/`<select>` elements whose
   *containing* control is already tall enough — the container is the real
   touch target).
4. For dialogs (`position: fixed` overlays), verify with a viewport-only
   screenshot, not `fullPage: true`. Playwright's full-page screenshots resize
   the capture to the full document height, which renders fixed-position
   elements pinned to their initial position instead of centered in the
   visible viewport — a screenshot-tool artifact, not a real rendering bug.

## Deferred Follow-Ups

A few smaller mobile polish items were found during the #87 audit but not
fixed there, because they affect desktop layout too (not mobile-specific
regressions) and need a deliberate design pass rather than a same-PR fix —
see the tracking issue linked from #87 for details (viewer-card checkbox
touch target, tab-bar scroll affordance, About page version-link height).

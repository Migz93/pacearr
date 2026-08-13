<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Testing

Pacearr has TypeScript checks, focused server/database tests, production build
verification, and Docker smoke testing. Server tests run against a temporary
SQLite database with no external services involved.

## Commands

| Command | What it does |
|---|---|
| `npm run test:server` | Builds the server, compiles server tests, and runs Node's test runner |
| `npm test` | Runs already-compiled server tests |
| `npm run check` | Runs TypeScript checks for the client, shared types, server, and Playwright config/tests |
| `npm run build` | Builds the Vite client and TypeScript server |
| `npm run test:e2e` | Runs Playwright auth setup and the live-instance browser suite |
| `npm run test:e2e:auth` | Runs only the Playwright session-cookie setup |

## Server Tests

Server tests use Node's built-in test runner against a temporary SQLite
database. Safe to run any time — they touch no real data and make no network
calls.

## Playwright End-To-End Tests

Playwright tests run against a live, fully configured Pacearr instance. They do
not mock the API or use the server test database. Auth uses a real
`pacearr_session` cookie because the devcontainer has no display for driving
Plex OAuth.

### First-Time Setup

1. Install Chromium with `npx playwright install chromium`.
2. Copy `.env.playwright.example` to `.env.playwright`.
3. Set `BASE_URL` to the running Pacearr instance and paste the value of the
   `pacearr_session` cookie from the browser into `SESSION_COOKIE`.
4. Run `npm run test:e2e`.

The auth setup validates the cookie and saves it to
`tests/playwright/.auth/storageState.json`. Later runs reuse that session until
it expires. Delete the saved state and provide a fresh cookie to re-authenticate:

```bash
rm tests/playwright/.auth/storageState.json
```

`.env.playwright`, generated auth state, test results, and the HTML report are
all gitignored and must stay local because they contain the active session
cookie or authenticated page data. The smoke
tests also fail on unexpected browser console errors and page errors, using the
selective client logging convention from #42.

---

## Test Suite

### `tests/server/db.test.ts` — Database invariants

Runs against a temporary SQLite database. Safe to run any time.

| Test | What it checks |
|---|---|
| Rolling show enrollment is idempotent | A Sonarr series can only create one Pacearr rolling-show row |
| Watch event import is idempotent | Duplicate source events are ignored and do not inflate watch history |
| Expanded seasons are monotonic and not duplicated | Expansion state is sorted and duplicate-safe |
| Expanded seasons can be removed during progressive cleanup | Progressive cleanup can remove a season from expansion state |
| Prefetched episodes persist and clear with their lifecycle | Prefetch records retain their triggering user, reject duplicates, clear explicitly, and clear when the season expands |
| Pruning history events by retention only removes events older than the cutoff | `history_events` past `historyRetentionDays` is deleted; recent events, `watch_events`, and `reclaimed_storage_events` are untouched |
| Pruning history events does not crash on an extreme retention value | An overflow-inducing input (e.g. `1e308`) is clamped to `MAX_SAFE_RETENTION_DAYS` instead of producing an invalid Date that throws |
| Pruning history events with a zero or negative retention value does not wipe every row | A retention value below 1 is floored, so the cutoff can't land on now-or-future and delete the entire audit log |
| Pruning history events does not crash or wipe every row on a NaN retention value | `Number.isFinite` is checked before the clamp, since `Math.min`/`Math.max` both propagate `NaN` rather than bounding it |
| Dry-run defaults are safe | New and legacy/partial settings resolve to dry-run enabled |
| The split library refresh job inherits old combined-job state | An upgrade carries `recommendation-refresh` run status into `sonarr-library-refresh`, avoiding a misleading “never run” status while the existing cache is warm |
| A history category filter matches an action and its dry-run twin | `?category=` filters on the fixed action set from `src/shared/history.ts`, includes `dry_run.` variants, excludes other categories, and stacks with the level filter |
| Per-user activity windows the show count but not the last-watched timestamp | The Users page's "N shows active" respects the viewer activity window while "last watched" does not, so a quiet viewer shows when they were last seen rather than "never" |
| A disabled user's recent watch does not count as an active show, but still counts as last watched | Only an enabled viewer's progress keeps a season expanded, so the active-show count excludes disabled users while the last-watched timestamp stays informational |
| A recent special (season 0) does not count as an active show, but still counts as last watched | Specials never expand a season (`processWatchEvent` gates expansion on `seasonNumber > 0`), so counting one as "active" here would tell a viewer their switch is keeping a show expanded when it isn't |
| A legacy `watch_events.reconciled` row still appears under the Sync category | That action stopped being written, but an install that ran an older version can already have rows with it, and dropping it from the category map would make them disappear from the Sync filter |
| `updateUser` with an empty patch preserves the current enabled state | Locks in the `patch.enabled ?? current.enabled` fallback this layer relies on, independent of whatever the route above it does with an absent field |
| A recommendation cache missing any field, not just viewers/viewerCount, is treated as absent | The shape guard used to check only the two fields the last rename broke; a row missing a different field (or a malformed nested viewer) would have passed and then crashed the client downstream |
| A recommendation cache row with corrupted JSON is treated as absent, not as zero candidates | `getRecommendationCache` used to parse through a helper whose fallback-on-error returned `[]`, which passes the shape check vacuously and reads as a genuine "0 candidates" cache instead of triggering the refresh callers expect from `null` |
| A malformed Sonarr library cache is treated as absent | Invalid JSON or a partial cached series must trigger the normal Sonarr fallback instead of looking like a valid empty library |
| A recommendation cache with non-numeric season entries is treated as absent | The shape guard checked `retainedSeasons`/`droppedSeasons` were arrays but never that their elements were numbers, unlike every other field in the same guard |
| Tautulli resolver prefers an exact username match and refuses to guess between ambiguous display names | `username` has no uniqueness constraint and `display_name` even less so — a single OR query with `.get()` would silently attribute one person's Tautulli history to a different Pacearr user on a tie |
| Tautulli resolver refuses to guess between two users whose usernames collide case-insensitively, and does not fall through to display_name on that tie | The username step trusted a bare `.get()` as if a match always meant one row; it did not, since username has no uniqueness constraint either and the lookup is case-insensitive. A third user with a matching display_name proves the null result is the designed refusal, not a coincidence — without it, the test couldn't tell "refused to guess" from "found nothing either way" |
| Tautulli resolver falls back to an unambiguous display name match | The case the fallback exists for — a Tautulli friendly name that matches nobody's username but exactly one display name |
| Tautulli resolver matches on the Plex username even when the Tautulli friendly name matches nobody | Regression for #75 — a Tautulli admin can rename the friendly name freely without touching Plex, so a friendly name matching nothing must not block a match on the real Plex username |
| Tautulli resolver falls back to the friendly name when the Plex username matches nobody | Plex Home/managed users have no real Plex.tv username, so Tautulli's `username` field for them is often empty or unrelated — the friendly name has to be tried independently, not just as a fallback field for the same string |
| Tautulli resolver refuses to guess when the Plex username is ambiguous, even if the friendly name uniquely matches a different user | An ambiguous username used to be indistinguishable from "no match" and fell through to the friendly name regardless — a coincidental unique friendly-name match could then attribute the event to a third user unrelated to the ones the username was ambiguous between |
| Tautulli resolver tries the friendly name when the Plex username only collides ambiguously on display_name, not on username itself | Blocking the friendly-name fallback was only meant for a genuine conflict on the strong signal (the real username field) — an ambiguous display_name match during that same lookup's own fallback step is just a failed primary lookup, and the independent friendly name can still resolve it |
| A previously orphaned Tautulli watch event can be repaired once its user resolves | Regression for #75 — `INSERT OR IGNORE` means a duplicate event is silently skipped forever unless something explicitly repairs its `user_id`; also locks in that repairing an already-assigned event is a no-op, not a re-attribution |
| Mapping a Tautulli identity persists it and links that identity's orphaned history | The Users-page mapping stores Tautulli's stable user ID, makes it the preferred future match despite a renamed username, and assigns previously unmatched events so their progress is available again |
| Mapping cannot replace a user's existing Tautulli identity | A second different stable ID is rejected without overwriting the existing user mapping |
| Unmapped Tautulli users display the names from their newest event | The mapping UI does not pair the latest activity timestamp with lexicographically selected stale names after a Tautulli rename |
| The cached Tautulli resolver preserves stable-ID and ambiguity safeguards | Full-history reconciliation uses its in-memory resolver without changing the stable-ID priority or the refusal to guess on ambiguous names |
| An ambiguous saved Tautulli username is never resolved through a weaker fallback | Two editable mappings that collide case-insensitively leave the event unmatched even when its friendly name could otherwise resolve to another user |
| Tautulli username backfill uses a managed user's friendly name when their username is blank | A database upgraded from before the editable field gets a usable Tautulli friendly name for a matched managed user whose event username is blank |
| Migration 17 repairs duplicate Tautulli IDs before adding the unique index | A pre-release duplicate retains the earliest user deterministically while later duplicate mappings are cleared |

### `tests/server/history-noise.test.ts` — History records only real changes

| Test | What it checks |
|---|---|
| A session check that moved nobody's progress records no history event | `session-check` can run once a minute; an unconditional entry buried History under "processed 0, changed 0" rows. The run is still logged |
| A session check that only advances a viewer's progress, without expanding or prefetching a season, still records a history event | `processWatchEvent` can persist a `rolling_show_users` update while returning `changed: false` (no premiere, or `earlyPrefetchEnabled` is off) — the audit-log gate must also react to `progressUpdated`, not just `changed`, or a genuine progress move goes unlogged |
| A rolling reconcile with nothing to change and no errors records no history event | Same rule for the six-hourly sweep |
| A rolling reconcile that only flips series-level Sonarr monitoring, with no episode/season change, still records a history event | `changedSomething` used to check only episode/file/search counts, missing `plan.seriesMonitoringUpdate` and season-level monitoring toggles — a scheduled sweep that only mutated series-level monitoring skipped the `sonarr.baseline` entry despite genuinely changing something |

### `tests/server/plex-session-monitor.test.ts` — Live Plex playback trigger

| Test | What it checks |
|---|---|
| A local SSE playback notification triggers a session check | The monitor authenticates its local stream with the Plex token, records a live connection, accepts both Plex's named `playing` event with its root `PlaySessionStateNotification` payload and the legacy generic/nested notification shape, and safely ignores null notification frames without requiring a Plex server or an active viewer |
| A failed local SSE connection reports polling fallback | A Plex connection failure does not trigger a session check and leaves the scheduled fallback visible |
| An idle live SSE connection falls back to polling | A reverse proxy or Plex stream that stays open but stops producing heartbeats is reconnected rather than suppressing polling indefinitely |
| A monitor that begins before Plex is configured reconnects later | The live monitor does not become permanently unavailable when configuration appears after startup |
| A session-check trigger is coalesced while that job is running | Live notifications, schedules, and manual actions cannot cause overlapping session checks |
| A dependent manual job queues one follow-up after an active run | A refreshed Sonarr library cannot leave recommendations stale when an older calculation is already in flight; repeated triggers still coalesce to one follow-up |
| A job identifies a manual trigger | The session fallback can skip only scheduled polls while retaining Settings and SSE-triggered checks |
| Disabled jobs cannot be manually run or queued | Settings and internal callers cannot override a job the administrator disabled |
| A scheduled collision retains the following timer | Skipping an in-progress recurring run does not silently stop that job permanently |

### `tests/server/schedule-interval.test.ts` — Scheduled interval bounds

| Test | What it checks |
|---|---|
| Oversized finite intervals are clamped | Values that are finite as minutes, hours, or days but invalid as milliseconds are bounded before persistence or scheduler conversion |
| Invalid interval forms stay safe | App-settings fall back safely for non-finite minute, hour, and day values; direct Jobs edits reject invalid or non-aligned minute values rather than silently rounding them |

### `tests/server/logger.test.ts` — Log ring, file, and merge behavior

| Test | What it checks |
|---|---|
| `getRecentLogs` only reflects the in-memory ring | Retained rotated files never leak into the ring-only read path |
| `currentLogFilePath` points at the machine-readable transport's fixed symlink name | Settings → Logs reads the same file the machine-readable rotating transport always symlinks to |
| `mergeLogEntries` drops exact duplicates but keeps same-millisecond entries that differ only in meta | The Logs merge key can't collapse distinct entries that share a timestamp and message (e.g. reconcileRollingShows's per-show skip log) |
| `mergeLogEntries` sorts the combined result chronologically | Combining out-of-order sources still yields a chronological result |
| `readRecentLogEntries` combines today's log file with the in-memory ring | The Logs route sees history from both a prior restart (file) and this process's own activity (ring) |
| Logged metadata survives the full write/read round trip through the persisted file | Winston's second log argument is wrapped so metadata is nested under `meta` in the serialized file, not spread onto top-level fields where `readTodaysLogEntries` couldn't see it |
| The ring entry's timestamp matches the persisted file's timestamp for the same log call | `write()` supplies its own timestamp to winston instead of letting `format.timestamp()` generate an independent one, so `mergeLogEntries`' dedup key can't split one log call into two visible entries |
| Logging circular or BigInt metadata does not throw, in the ring, the persisted file, or the Logs API's own merge | `write()` sanitizes metadata once before it enters the ring, so every downstream consumer (the persisted file, and `mergeLogEntries` via the Logs API) only ever sees an already-safe value |
| Logging the same object referenced twice preserves both, rather than marking the repeat as circular | `sanitizeMeta` tracks ancestry, not "every object ever seen", so two sibling properties referencing the same object aren't mistaken for a cycle |
| Logging a root metadata value with no JSON representation (a function or Symbol) does not throw and omits metadata | `JSON.stringify` returns `undefined` for these at the root, so `sanitizeMeta` must recognize that instead of handing `undefined` to `JSON.parse`, which throws |
| The human-readable log retains falsy scalar metadata (`0`, `false`, `""`, `null`) instead of treating it as absent | `humanFormat` checks whether meta is present, not whether it's truthy, so a real but falsy scalar isn't silently dropped from `pacearr.log` |

### `tests/server/image-cache.test.ts` — Image-cache integrity

| Test | What it checks |
|---|---|
| A deleted cached image is fetched again | The in-memory file index is invalidated when the on-disk image disappeared, allowing a replacement fetch instead of returning a broken URL |

### `tests/server/app-settings.test.ts` — App-settings transitions

| Test | What it checks |
|---|---|
| New-show triage creates a boundary only on enable | The authenticated HTTP route sets a new activation boundary on disabled → enabled, while enabled → enabled saves preserve it |

### `tests/server/sonarr-dry-run.test.ts` — Sonarr mutation boundary

| Test | What it checks |
|---|---|
| Dry-run blocks Sonarr mutations | Monitoring updates, searches, and file deletions send no HTTP requests while dry-run mode is enabled |

---

### `tests/server/tautulli-integration.test.ts` — Tautulli history field mapping

| Test | What it checks |
|---|---|
| `getHistory` maps Tautulli's `username` and `user` fields independently, not collapsed into one | Regression for #75 — these used to be collapsed into a single field with `??`, discarding whichever one lost; this asserts they stay distinct all the way out of `getHistory` |

### `tests/server/new-show-triage.test.ts` — Automatic Sonarr arrival triage

| Test | What it checks |
|---|---|
| Existing series are ignored while new series at or below the limit are searched | The activation timestamp excludes the existing library, and the strict “more than” comparison sends an 80-episode series to `SeriesSearch` |
| A series above the limit is enrolled onto the pilot baseline | The large-series path reuses enrollment rather than issuing a full series search |
| Dry-run triage remains pending for live mode and a completed decision is not repeated | A dry-run never consumes an arrival; the first live run searches it and later polls do not repeat that command |
| Dry-run does not persist a fallback baseline | An undated dry-run response cannot suppress that series if Sonarr later supplies a post-activation `added` time in live mode |
| A changed activation stops an in-flight poll | A poll that started before triage was re-enabled cannot apply its old activation boundary |
| A missing Sonarr `added` field uses a first-poll ID baseline | The fallback never acts on pre-existing series, but detects a newly appearing ID on a later poll |
| A pre-existing series remains ignored if its `added` field disappears | An ID recorded from the initial timestamped response cannot become a fallback candidate later |
| A failing series does not block later arrivals | Per-series failures remain pending and visible in History while later new series continue through triage |
| A manual enrollment is not resumed by automatic triage | Only an explicitly pending automatic enrollment can receive the pilot baseline on a retry |
| A failed automatic enrollment cannot mark a later manual enrollment pending | A failure before Pacearr creates its rolling-show row leaves no marker for a later manual enrollment to inherit |
| A pending-marker write failure releases its enrollment lock | A database error before the mutation phase cannot permanently block later work on that series |
| Unenrolling a partial automatic enrollment clears its pending marker | A later manual enrollment cannot inherit stale automatic triage state after unenrollment |
| A full-series search waits for another series operation | Triage retries instead of overlapping a concurrent enrollment or rolling mutation |
| Retrying a partial large-show enrollment resumes it | A retry reuses the persisted rolling-show row without writing a second enrollment history entry |

### `tests/server/security-hardening.test.ts` — Session and integration credential boundaries

| Test | What it checks |
|---|---|
| Session IDs are hashed before persistence and cannot be used as stored | A database read contains only the SHA-256 session-token hash, not a replayable bearer token |
| Existing plaintext session IDs are migrated without invalidating their cookie tokens | A version-13 database upgrades its session row to a hash while the original cookie token still resolves its owner |
| Session signature validation rejects malformed non-ASCII input safely | A visually 64-character but UTF-8-long signature returns false instead of reaching `timingSafeEqual` with mismatched byte lengths |
| Plex, Sonarr, and Tautulli reject unsafe URLs and configure credentialed request safeguards | Non-HTTP(S) and embedded-credential URLs are refused; successful connection checks plus Plex.tv account, discovery, friends, and token-ping requests pass `redirect: "error"` and an abort signal to `fetch` |
| Integration request paths cannot replace the configured origin | Absolute, non-HTTP(S), and protocol-relative paths cannot escape the administrator-configured Sonarr or Tautulli origin |

---

### `tests/server/recommendations.test.ts` — Service and Sonarr workflow behavior

| Test | What it checks |
|---|---|
| History import batches events outside the activity window while still applying rolling logic to recent ones | A mixed batch of one old and one recent watch event routes the old one through the batched insert-only path (no season expansion) and the recent one through the Sonarr-touching path (expands its season), with accurate imported/matched/unmatched counts across both |
| History import uses the cached Sonarr library | Prevents every history import from repeating the full Sonarr `/series` request when the library refresh job has already populated its cache |
| Recommendation refresh is cache-only | The calculation job waits for a populated library cache rather than issuing another whole-library Sonarr request |
| A full history reconciliation repairs a previously orphaned Tautulli event and refreshes rolling progress | Regression for #75 end to end — a full reconcile re-fetches an event that's a duplicate by `(source, source_event_id)`, so the fix has to repair it in place rather than rely on a fresh insert; also confirms `rolling_show_users`, not just the raw `watch_events` row, picks up the repaired progress |
| Manual Tautulli mapping refreshes rolling progress from relinked history | Assigning an unmatched Tautulli identity immediately rebuilds its enrolled-show progress from stored history, without waiting for the next import |
| Reset clears prefetch targets before applying the pilot baseline | Reset removes persisted prefetch targets before reconciliation calculates which episodes to unmonitor and delete |
| Dry-run reset projects prefetch cleanup without mutating state | Dry-run reset excludes prefetched episodes from the projected monitoring and deletion plan while retaining their records |
| Dry-run expansion preserves prefetch targets | Reprocessing an already-expanded season in dry-run mode does not delete its persisted prefetch records |
| Scheduled reconciliation reclaims stale prefetches | A prefetch with no active viewer need beyond the cleanup delay is cleared, unmonitored, and its file is deleted |
| Progressive cleanup toggle protects stale prefetches | Disabling progressive cleanup prevents stale-prefetch records and files from being reclaimed |

### `tests/server/rolling-plan.test.ts` — Rolling-plan selection and retention

| Early prefetch selection skips the pilot and caps the candidate count | Episodes selected from the next season start after E01 and respect the configured count |
| Rolling plans preserve prefetched episodes individually | Prefetched episode targets remain monitored without retaining the entire season |

### `tests/playwright/pages.spec.ts` — Page smoke tests

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Primary pages load | Dashboard, Shows, Users, History, and Settings render their headings without browser console or page errors |
| Sidebar navigation links are present | The five primary navigation links render inside the app navigation |
| Unauthenticated requests redirect to the login page | A fresh browser context is redirected from `/dashboard` to `/login` |

### `tests/playwright/settings.spec.ts` — Settings navigation

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| All settings tabs are visible | General, Plex, Sonarr, Tautulli, Logs, Jobs, and About render |
| Clicking settings tabs updates the URL | Each tab writes its expected `?tab=` query parameter |

### `tests/playwright/shows.spec.ts` — Shows navigation and filters

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Shows tabs and filters render | Enrolled, Recommendations, Ignored, Sonarr, and the sort control render |
| Shows tab updates the URL | Selecting Recommendations writes `?tab=recommendations` |

### `tests/playwright/users.spec.ts` — Users API shape

| Test | What it checks |
|---|---|
| Discovering users returns the same per-user activity fields as the users list | `POST /api/users/discover` used to return the raw discovery shape (missing `activeShowCount`/`lastWatchedAt`), so clicking Refresh silently dropped active viewers out of the Active section until the next reload |
| PATCH-ing a user with no `enabled` field in the body leaves their enabled state unchanged | `PATCH /api/users/:id` used to wrap the body's `enabled` in `Boolean(...)` unconditionally, turning a genuinely absent field into `false` and silently disabling the user; runs against live data and restores the original state in a `finally` block |
| PATCH-ing a user with a non-boolean `enabled` value is rejected, not coerced | `Boolean(...)` also accepted any truthy non-boolean (a string, an object) as `true`; the route now requires an actual boolean whenever the field is present at all |

### `tests/server/users-activity.test.ts` — Per-user shows dialog activity

| Test | What it checks |
|---|---|
| The shows-driven-by-user dialog reports nothing as active for a disabled viewer, even a recent watch | Must agree with the card's `activeShowCount` — a disabled viewer's watches can't keep anything expanded, so the dialog can't show the same shows as "Active" that the card just called inactive |
| The shows-driven-by-user dialog reports a recent watch as active for an enabled viewer | The positive case, so the negative one above is checking a real gate and not a query that always returns false |
| The shows-driven-by-user dialog reports a recent special (season 0) as inactive | Matches the `countActiveShowsByUser` card-level fix — specials don't expand a season, so they shouldn't read as "keeping this show active" here either |

### `tests/playwright/history.spec.ts` — History filters

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| History filters and page size render | Level filters (All / Info / Warning — no Error, which nothing writes) and the rows-per-page control render |
| History type filter is a fixed set of categories | All types, Monitoring, Cleanup, Shows, and Sync render, rather than one button per action string in the database |
| History category filter updates the URL | Selecting Cleanup writes `?category=cleanup` |
| History level filter updates the URL | Selecting Warning writes `?level=warn` |

## Adding New Tests

Which layer to reach for — server test or Playwright — is covered in `AGENTS.md`
under Tests. Mechanically:

- **Server tests:** create a `*.test.ts` file under `tests/server/` and it is
  picked up by `npm run test:server`. Tests should build their own temporary
  database rather than sharing state.
- **Playwright:** create a `*.spec.ts` file under `tests/playwright/`; the saved
  session is loaded for each Chromium test. Use the live instance only and keep
  generated artifacts under the existing ignored `tests/` paths.

When a test is agreed and written, add a row for it in the relevant table above.

## Manual Smoke Test

For a local Docker verification:

```bash
docker build -t pacearr .
docker stop pacearr && docker rm pacearr
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  pacearr
docker logs pacearr 2>&1 | tail -5
```

Expected log line:

```text
Pacearr listening on port 9302
```

Depending on DooD network behaviour, `curl http://127.0.0.1:9302/api/health`
from inside the devcontainer may not reach the host-published port. Testing from
inside the container is the most reliable check:

```bash
docker exec pacearr node -e "fetch('http://127.0.0.1:9302/api/health').then(r => r.text()).then(console.log)"
```

Then open `http://localhost:9302` and smoke-test — use this after changes that
touch external integrations, cleanup, or Docker behaviour:

- Sign in with Plex OAuth or the manual token fallback
- Configure the Plex server URL and machine identifier
- Configure the Sonarr base URL and API key
- Optionally configure Tautulli and save settings
- Open Shows and confirm Sonarr series load
- Enroll a known show and confirm Pacearr applies the all-season-pilot baseline
- Run Import History and confirm relevant SxxE01 history expands seasons
- Run Check Sessions while a Plex episode is active and confirm live expansion
- Run inactive reset only when you are comfortable with cleanup/deletion
  behaviour

This section needs Docker. See "Where You're Running" in `AGENTS.md` — where it
is unavailable, say so rather than substituting a workspace check.

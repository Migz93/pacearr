# Jobs And History

## Jobs

Pacearr has six scheduler-managed jobs.

| Job | Default schedule | Purpose |
|---|---:|---|
| `session-check` | every 15 minutes | Poll Plex live sessions only while the live SSE connection is unavailable; process active episode playback |
| `history-import` | every 24 hours | Import Plex history and optional Tautulli history |
| `full-history-reconcile` | every 30 days, configurable | Re-read all available Plex and Tautulli episode history to recover source gaps |
| `rolling-reconcile` | every 6 hours, configurable | Reconcile every enrolled show against active-viewer progress and correct Sonarr monitoring/files; also prunes `history_events` past `historyRetentionDays` |
| `sonarr-library-refresh` | every 6 hours, configurable | Fetch Sonarr's series list and refresh `sonarr_library_cache` |
| `recommendation-refresh` | every 6 hours, configurable | Recalculate projected-savings recommendations from the cached Sonarr library |

Job state is stored in `job_run_state`.

The scheduler tracks:

- enabled flag
- next run time
- last successful run time
- last terminal status
- whether a run is active

## Scheduler Health

Runs of the same job never overlap: manual, scheduled, and event-driven
triggers coalesce while a run is active, and a skipped scheduled trigger still
leaves the next timer armed. A failure is logged with structured detail,
persists an `error` status in `job_run_state`, and appears as the job's last
result in Settings → Jobs. Jobs retry at their configured interval; Pacearr
does not add exponential backoff because each interval is administrator-owned
and can already be lengthened from Settings when an integration is unavailable.

Plex playback normally arrives through a persistent SSE connection. Settings →
Jobs shows whether this live connection is active or Pacearr is using its polling
fallback. Playback notifications and scheduled/manual requests share the
`session-check` job; an in-progress run is never duplicated. An idle live stream
is treated as disconnected and reconnects, so polling resumes if Plex or a proxy
silently stalls the connection.

## Manual Job Triggers

Endpoints, for any scheduler-registered job:

| Endpoint | Action |
|---|---|
| `POST /api/settings/jobs/:id/run` | Run a job now |
| `PATCH /api/settings/jobs/:id` | Change any job's interval |

The parallel `/api/jobs/*` routes and the Dashboard quick actions they
supported were removed.

Settings → Jobs is the only UI surface for running a job now or changing a
schedule. Each interval is stored in application settings and editing it writes
the setting and reschedules the job. The session interval is the polling
fallback, not the primary playback trigger. `sonarr-library-refresh` is the
dedicated cache-refresh job; history import and session processing reuse that
snapshot, with a direct Sonarr fallback only before the first cache exists.
`recommendation-refresh` computes from the cache, so history imports can
refresh recommendation results without repeating the library fetch.

## Watch Events

`watch_events` is the normalised record of imported and observed episode activity.

Sources:

- `plex-history`
- `plex-session`
- `tautulli`

Each watch event stores:

- source
- source event id
- user id where matched
- Plex account id where available
- username where available
- Sonarr series id where matched
- show title
- season number
- episode number
- watched timestamp
- raw payload JSON

Events are unique by `(source, source_event_id)` so re-imports are idempotent.

## History Synchronization

Plex and Tautulli each maintain an independent local synchronization state. The first successful import for a source backfills its complete episode history into `watch_events`. Once the backfill is complete, subsequent imports request only records newer than the source cursor with a small overlap to account for delayed reporting. Source-event IDs keep overlapping records idempotent.

## Full History Reconciliation

The monthly full reconciliation reads all history currently available from Plex
and optional Tautulli. It complements rather than replaces the normal
incremental import: the latter uses source cursors for efficient frequent
updates, while the full job intentionally leaves those cursors unchanged.

Only missing events are stored. Historic events discovered by this job are
available in show detail under **Show inactive viewers**, but never trigger
season expansion, cleanup, or other Sonarr mutations. Its history entry reports
the number of source events fetched, newly stored, matched to Sonarr, and left
unmatched.

## History Events

`history_events` is Pacearr's audit log.

It records:

- enrollment and removal
- baseline application
- season expansion and early prefetch
- history import summaries
- live session checks **that moved a viewer's progress**
- rolling-monitoring reconciliation **that changed something or hit an error**
- progressive cleanup
- warnings and errors

History events are intentionally separate from watch events. Watch events represent user playback. History events represent Pacearr's own actions and operational state.

### Only Record What Changed

`session-check` can run once a minute and `rolling-reconcile` runs every six
hours. Recording every run regardless of outcome buried History under rows
reading `processed 0, changed 0`, so both write an event only when something
actually happened. Every run is still logged. Re-matching stored watch events
(`watch_events.reconciled`) is logger-only for the same reason — it is internal
bookkeeping with no user-visible effect.

### Categories

The History page filters on four fixed categories rather than on the raw action
string. `src/shared/history.ts` is the single mapping, used by both the server's
`?category=` filter and the client's row labels; adding an action there is what
puts it in a filter. An unmapped action still appears under "All types".

| Category | Actions |
|---|---|
| Monitoring | `sonarr.baseline`, `sonarr.expand_season`, `sonarr.early_prefetch` |
| Cleanup | `cleanup.progressive`, `cleanup.prefetch`, `show.reset` |
| Shows | `show.enrolled`, `show.unenrolled`, `recommendation.ignored` |
| Sync | `history.import`, `history.full_reconcile`, `sessions.check`, `rolling.reconcile`, `watch_events.reconciled` (no longer written, kept mapped so existing rows stay visible) |

A `dry_run.` prefix is not a separate action for filtering purposes: it shares
its live counterpart's category and label and renders a **Dry run** badge on the
row. No code path writes an error-level history event — `addHistory` only ever
uses `info` or `warn` — so the level filter offers All / Info / Warning only.

`history_events` is pruned to `historyRetentionDays` (default 7) by the `rolling-reconcile` job. `watch_events` is never pruned — see [maintenance.md](maintenance.md#data-retention).

## Reclaimed Storage

When a live Sonarr cleanup deletes episode files, Pacearr records a separate
`reclaimed_storage_events` ledger entry after the deletion succeeds. Each entry
contains the show, cleanup action, optional season, file count, byte total, and
timestamp. The dashboard sums this ledger for its **Space reclaimed** total.

Dry runs never write reclaim records. Existing deletions from before this ledger
was introduced cannot be reconstructed reliably, so the total begins accruing
with the first successful cleanup after upgrading.

## UI Surfaces

- Dashboard shows four linked stat chips, the three newest history entries, and a
  strip of recently-active enrolled shows. It carries no job controls.
- History shows the full audit list, filtered by category and level.
- Settings → Jobs owns every schedule and every "run now".

## Logging Relationship

Logs are for runtime troubleshooting. History events are for user-visible audit.

Important workflow actions should usually write both:

- a structured log for support/debugging
- a `history_events` row for admin visibility

Application logs are written to two rotating files in `/config/logs`,
matching hubarr: a human-readable `pacearr-*.log` (7 days, manual inspection
only) and a machine-readable `.machinelogs-*.json` (3 days) that Settings →
Logs reads, combined with the in-memory ring — see `readRecentLogEntries` in
`app.ts`.

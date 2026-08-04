# Jobs And History

## Jobs

Pacearr has five scheduler-managed jobs.

| Job | Default schedule | Purpose |
|---|---:|---|
| `session-check` | every 5 minutes | Poll Plex live sessions and process active episode playback |
| `history-import` | every 24 hours | Import Plex history and optional Tautulli history |
| `full-history-reconcile` | every 30 days | Re-read all available Plex and Tautulli episode history to recover source gaps |
| `rolling-reconcile` | every 6 hours | Reconcile every enrolled show against active-viewer progress and correct Sonarr monitoring/files; also prunes `history_events` past `historyRetentionDays` |
| `recommendation-refresh` | every 6 hours | Refresh the cached Sonarr library and projected-savings recommendations |

Job state is stored in `job_run_state`.

The scheduler tracks:

- enabled flag
- next run time
- last successful run time
- last terminal status
- whether a run is active

## Manual Job Triggers

The API exposes manual trigger endpoints:

| Endpoint | Action |
|---|---|
| `POST /api/jobs/session-check/run` | Run a live Plex session check immediately |
| `POST /api/jobs/history-import/run` | Import Plex/Tautulli history immediately |
| `POST /api/jobs/full-history-reconcile/run` | Re-read all available Plex/Tautulli history without changing incremental cursors |
| `POST /api/jobs/rolling-reconcile/run` | Reconcile enrolled shows immediately |
| `POST /api/jobs/:id/run` | Trigger a scheduler-registered job by id |

The Dashboard exposes quick actions for session checks and history import.

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
- season expansion
- history import summaries
- live session check summaries
- rolling-monitoring reconciliation
- progressive cleanup
- warnings and errors

History events are intentionally separate from watch events. Watch events represent user playback. History events represent Pacearr's own actions and operational state.

`history_events` is pruned to `historyRetentionDays` (default 90) by the `rolling-reconcile` job. `watch_events` is never pruned — see [maintenance.md](maintenance.md#data-retention).

## Reclaimed Storage

When a live Sonarr cleanup deletes episode files, Pacearr records a separate
`reclaimed_storage_events` ledger entry after the deletion succeeds. Each entry
contains the show, cleanup action, optional season, file count, byte total, and
timestamp. The dashboard sums this ledger for its **Space reclaimed** total.

Dry runs never write reclaim records. Existing deletions from before this ledger
was introduced cannot be reconstructed reliably, so the total begins accruing
with the first successful cleanup after upgrading.

## UI Surfaces

- Dashboard shows current enrolled-show activity, confirmed reclaimed storage,
  curated Pacearr changes, and concise operational status.
- History shows a larger audit list.
- Settings shows job configuration and integration settings.

## Logging Relationship

Logs are for runtime troubleshooting. History events are for user-visible audit.

Important workflow actions should usually write both:

- a structured log for support/debugging
- a `history_events` row for admin visibility

Application logs are retained for 14 days in `/config/logs`. Settings → Logs
combines the in-memory ring of recent entries with today's active log file
(read directly, not merged across every retained rotated file), so it stays
useful both immediately after a restart and right after midnight's daily
rotation.

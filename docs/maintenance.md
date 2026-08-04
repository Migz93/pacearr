<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Maintenance

## Current Housekeeping Responsibilities

Pacearr's maintenance work is focused on rolling-monitoring state and storage
control. There is no single scheduled "maintenance" job — cleanup is attached to
the jobs that own the relevant state.

| Where | What it does |
|---|---|
| `rolling-reconcile` job | Brings enrolled shows back to the monitoring state implied by enabled viewers' progress; also prunes `history_events` past `historyRetentionDays` |
| Watch-event processing | Progressive cleanup shrinks older expanded seasons back to pilot-only |
| `job_run_state` | Durable job state across restarts |
| `history_events` | Audit history of what Pacearr did |

Progressive cleanup is the implemented rolling-monitoring cleanup path. It runs
while processing watch events and can shrink older expanded seasons back to
pilot-only when all enabled users have moved beyond them. See
[rolling-monitoring.md](rolling-monitoring.md#progressive-cleanup) for the
authoritative behaviour and safety boundary.

## Data Retention

| Data | Retained | Controlled by |
|---|---|---|
| `/config/logs/pacearr.log` | 14 days, compressed after rotation | Log rotation config |
| `watch_events` | Never pruned | — |
| `history_events` | Configurable, default 90 days | `historyRetentionDays` setting; pruned by the `rolling-reconcile` job |
| `reclaimed_storage_events` | Never pruned | — |

**Settings → Logs** combines the in-memory ring of recent entries with today's
active log file (not every retained file — that would mean decompressing and
merging up to 14 days on every request). Neither source alone is always
complete: the ring is empty right after a restart while the file still has
that day's history, and the file is near-empty right after midnight's
rotation while the ring still holds the tail of the previous day — so recent
logs stay available across both cases.

`history_events` pruning deletes rows older than `historyRetentionDays` on
every `rolling-reconcile` run rather than running as its own job — see
[Adding New Maintenance Work](#adding-new-maintenance-work) below for the
reasoning. `watch_events` (core viewer-progress state) and
`reclaimed_storage_events` (the Dashboard's lifetime "Space reclaimed" total)
are deliberately excluded: pruning either would corrupt state other features
depend on, not just shrink an audit trail.

## Adding New Maintenance Work

When adding a new cleanup or consistency task:

1. Make it idempotent.
2. Prefer a dry-run or summary path for destructive actions.
3. Record meaningful `history_events`.
4. Add structured logs around start, finish, skipped work, and failures, with
   counts for anything removed. Use `debug` when there was nothing to do.
5. Add focused server tests for the persistence invariants.
6. Update this doc, and [jobs-and-history.md](jobs-and-history.md) if the task is
   scheduled or user-visible.

## Safety Rules

- Never delete media files unless the relevant setting explicitly allows
  deletion.
- Never clean up a season if an enabled user still appears active there.
- Never infer that all shows should be managed; only enrolled shows are
  Pacearr-controlled.
- Treat failed Plex/Sonarr/Tautulli calls as a reason to skip or warn, not as a
  reason to force cleanup.
- Maintenance is a bucket for scheduled housekeeping, not a place to hide
  unstructured miscellaneous logic. Each task should have one clear owner, an
  explicit scope, and tests where practical.

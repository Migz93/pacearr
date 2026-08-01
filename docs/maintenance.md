<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Maintenance

## Current Housekeeping Responsibilities

Pacearr's maintenance work is focused on rolling-monitoring state and storage
control. There is no single scheduled "maintenance" job — cleanup is attached to
the jobs that own the relevant state.

| Where | What it does |
|---|---|
| `rolling-reconcile` job | Brings enrolled shows back to the monitoring state implied by enabled viewers' progress |
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
| `history_events` | Never pruned | — |

**Settings → Logs** combines the active in-memory log stream with the retained
files, so recent logs remain available after an application or container restart.

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

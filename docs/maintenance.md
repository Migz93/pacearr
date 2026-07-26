# Maintenance

## Current Housekeeping Responsibilities

Pacearr's maintenance work is currently focused on rolling-monitoring state and storage control.

Implemented maintenance-style behavior:

- rolling monitoring reconciliation through the `rolling-reconcile` job
- progressive cleanup during watch-event processing
- durable job state in `job_run_state`
- audit history in `history_events`

## Progressive Cleanup

Progressive cleanup is the implemented rolling-monitoring cleanup path. It runs
while processing watch events and can shrink older expanded seasons back to
pilot-only when all enabled users have moved beyond them. See
[rolling-monitoring.md](rolling-monitoring.md#progressive-cleanup) for the
authoritative behavior and safety boundary.

## Data Retention

Pacearr retains application logs under `/config/logs` for 14 days. The active
file is available as `/config/logs/pacearr.log`; rotated files are compressed
after rotation. Settings → Logs combines the active in-memory log stream with
these retained files, so recent logs remain available after an application or
container restart.

Pacearr currently does not prune:

- `watch_events`
- `history_events`

## Adding New Maintenance Work

When adding a new cleanup or consistency task:

1. Make it idempotent.
2. Prefer a dry-run or summary path for destructive actions.
3. Record meaningful `history_events`.
4. Add structured logs around start, finish, skipped work, and failures.
5. Add focused server tests for persistence invariants.
6. Update this doc and [jobs-and-history.md](jobs-and-history.md) if the task is scheduled or user-visible.

## Safety Rules

- Never delete media files unless the relevant setting explicitly allows deletion.
- Never clean up a season if an enabled user still appears active there.
- Never infer that all shows should be managed; only enrolled shows are Pacearr-controlled.
- Treat failed Plex/Sonarr/Tautulli calls as a reason to skip or warn, not as a reason to force cleanup.

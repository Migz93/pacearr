# Maintenance

## Current Housekeeping Responsibilities

Pacearr's maintenance work is currently focused on rolling-monitoring state and storage control.

Implemented maintenance-style behavior:

- rolling monitoring reconciliation through the `rolling-reconcile` job
- progressive cleanup during watch-event processing
- durable job state in `job_run_state`
- audit history in `history_events`

## Inactive Reset

Inactive reset checks enrolled shows and reapplies the all-season-pilot baseline when no enabled user has watched the show within the configured inactivity window.

The default inactivity window is 7 days.

Reset behavior:

- clears expanded season state
- monitors every real-season E01
- unmonitors E02+
- disables season-level monitoring flags
- searches pilots
- deletes E02+ files in live mode

## Progressive Cleanup

Progressive cleanup is opportunistic and runs while processing watch events.

When enabled, it can shrink older expanded seasons back to pilot-only when all enabled users have moved beyond those seasons.

Because this can delete files, every change should remain conservative and auditable.

## Data Retention

Pacearr retains application logs under `/config/logs` for 14 days. The active
file is available as `/config/logs/pacearr.log`; rotated files are compressed
after rotation. Settings → Logs combines the active in-memory log stream with
these retained files, so recent logs remain available after an application or
container restart.

Pacearr currently does not prune:

- `watch_events`
- `history_events`

Future retention work should be explicit and configurable.

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

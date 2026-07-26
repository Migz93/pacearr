# Technical Docs

This folder is Pacearr's long-term technical reference area.

Use these docs for implementation details, subsystem behavior, and architecture notes that should stay useful after the branch or issue that introduced them is long gone.

## What's Here

- [architecture.md](architecture.md) — high-level system shape, deployment model, core invariants, and the main subsystems that make Pacearr work
- [rolling-monitoring.md](rolling-monitoring.md) — all-season-pilot behavior, Sonarr monitoring mutations, season expansion, reset, and progressive cleanup
- [integrations.md](integrations.md) — Plex, Sonarr, and optional Tautulli connectivity, API usage, matching, and failure behavior
- [jobs-and-history.md](jobs-and-history.md) — scheduled jobs, manual jobs, imported watch events, history events, and runtime audit behavior
- [deployment.md](deployment.md) — Docker image/container expectations, ports, bind mounts, and DooD-specific rules
- [maintenance.md](maintenance.md) — housekeeping responsibilities, database/filesystem persistence, and how to add cleanup work safely

## When To Read Which Doc

- Start with [architecture.md](architecture.md) if you need the big-picture mental model before touching the code.
- Read [rolling-monitoring.md](rolling-monitoring.md) when changing enrollment, baseline application, season expansion, resets, or deletion behavior.
- Read [integrations.md](integrations.md) when changing Plex OAuth/history/session logic, Sonarr API calls, Tautulli import, or matching behavior.
- Read [jobs-and-history.md](jobs-and-history.md) when changing scheduled jobs, manual job triggers, event import, or audit/history output.
- Read [deployment.md](deployment.md) when changing Docker, ports, bind mounts, or runtime config.
- Read [maintenance.md](maintenance.md) when adding background cleanup, consistency checks, pruning, or other housekeeping tasks.

## Maintenance Rule

When a major feature or long-lived internal behavior changes, update the relevant doc in this folder in the same branch/PR. If no existing doc fits, add a new topic doc here and link it from this index.

# Pacearr Architecture Overview

## What Pacearr Is

Pacearr is a single-purpose Plex and Sonarr companion app.

It does not request media and it does not add shows to Sonarr. Instead, it lists shows that already exist in Sonarr, lets the admin enroll selected shows, imports Plex/Tautulli viewing history, and changes Sonarr monitoring state based on where enabled Plex users actually are in a show.

## Core Model

- Sonarr is the source of truth for the available TV series and episode metadata.
- Plex is the default source of truth for playback history and live sessions.
- Tautulli is an optional additional history source.
- Pacearr is the source of truth for enrollment, normalized watch events, per-user rolling progress, expanded seasons, job state, and audit history.
- V1 supports one Sonarr instance.
- V1 supports one rolling mode: all-season pilots.

## Deployment Model

Pacearr runs as a single self-hosted container:

- Express backend and API
- React frontend
- background job scheduler
- Plex integration layer
- Sonarr integration layer
- optional Tautulli integration layer
- SQLite database
- log file output

Persistent data is stored in `/config`, which should be bind-mounted from `/opt/pacearr` on the host.

## Database Migrations

Pacearr uses SQLite `PRAGMA user_version` for schema migrations.

- Versioned migrations live in `src/server/db/migrations.ts`.
- `runMigrations(db)` runs on startup, applies any migration whose version is higher than the current `user_version`, and advances `user_version` after each successful migration.
- Each migration runs inside a transaction so a failure should leave the database unchanged.

The current v1 baseline migration creates:

- `settings`
- `users`
- `rolling_shows`
- `rolling_show_users`
- `watch_events`
- `history_events`
- `job_run_state`
- `sessions`

Migration v2 adds `ignored_recommendations`, keyed by Sonarr series id, so recommendation exclusions survive application restarts.

Migration v3 adds the calculated `recommendation_cache`. Migration v4 adds `sonarr_library_cache`, which stores the shared Sonarr series snapshot and locally cached poster paths.

When changing the schema in the future:

1. Add a new migration entry with the next integer version.
2. Write the schema change in that migration's `up(db)` function.
3. Do not edit older migrations that may already have shipped.
4. Keep default-setting seeding separate from schema migrations.

## Auth And Setup

- Authentication is Plex-owner based.
- The first successful Plex login becomes the stored owner account.
- OAuth popup login is available from the UI; manual token entry is retained as a fallback.
- Setup flow is currently lightweight:
  1. sign in with Plex
  2. save Plex server connection
  3. save Sonarr connection
  4. optionally save Tautulli connection
  5. discover users
  6. enroll shows from the Sonarr show list

## Major Subsystems

### Show enrollment

The Shows page reads the shared Sonarr library snapshot from SQLite and overlays Pacearr enrollment state from `rolling_shows`, so opening or searching the page does not wait on Sonarr. Its Refresh action starts the same background job used by Recommendations. That job refreshes the library, caches missing posters, and then recalculates recommendations every six hours, after history imports, on first configured startup, or on demand.

Enrolling a show creates or updates one `rolling_shows` row keyed by Sonarr series id. Enrollment can apply the all-season-pilot baseline and run history import immediately.

Every Sonarr series can be opened at `/shows/:seriesId`, whether or not it is enrolled. The detail view shows current Sonarr monitoring, seasons and episodes, plus matched viewer progress. Unenrolled shows offer an Enroll action; enrolled shows offer Reset and Unenroll. Unenroll removes Pacearr's enrollment and stored rolling progress only—it does not delete media or revert Sonarr monitoring state—and requests a background recommendation refresh.

The Recommendations page ranks un-enrolled shows by projected savings and displays 25 results at a time, with the current page stored in the URL. Administrators can persistently ignore candidates they do not intend to enroll and restore them through the “Show ignored” toggle.

Recommendation calculations are stored in `recommendation_cache` so page loads do not wait on Sonarr. The existing snapshot remains readable while the shared background refresh runs. The configured minimum projected savings (50 GB by default) and ignored state are applied when the cache is read, so those filters take effect without recalculating the snapshot.

### Watch history import

Plex playback history is imported through `/status/sessions/history/all`. Tautulli history is imported through `get_history` when configured and enabled.

Imported rows are normalized into `watch_events`. Re-imports are idempotent by `(source, source_event_id)`.

### Live session monitoring

The `session-check` job polls Plex `/status/sessions`. Episode sessions are normalized into the same watch-event path used by history import.

Watching SxxE01 for an enrolled show expands that season.

### Sonarr orchestration

Pacearr uses Sonarr v3 API endpoints to:

- fetch series and episodes
- set series monitoring and `monitorNewItems`
- set season monitored flags
- set episode monitored flags
- trigger `EpisodeSearch`
- trigger `SeasonSearch`
- delete episode files during cleanup/reset when enabled

### Frontend

The React UI is intentionally compact:

- Dashboard
- Shows
- Users
- History
- Settings

It is designed as an operational admin surface rather than a public landing page.

## Important Invariants

- Dry-run mode defaults to enabled and blocks every Sonarr PUT, POST, and DELETE operation at the integration boundary.
- Pacearr never adds a series to Sonarr.
- Pacearr only manages shows explicitly enrolled in `rolling_shows`.
- Specials, season `0`, are ignored by rolling baseline and expansion logic.
- All-season-pilot baseline keeps E01 of every real season monitored and searches those pilot episodes.
- Expanded seasons are stored as a sorted unique season-number array.
- Duplicate imported watch events must not retrigger Sonarr actions.
- Disabled users do not trigger expansion and should not block cleanup.
- Destructive cleanup must be auditable through `history_events`.

# Rolling Monitoring

## V1 Mode

Pacearr v1 implements one rolling mode: **All-Season Pilots**.

The intent is to keep a tiny foothold available for every season of an enrolled show. Users can jump to any season's first episode, and Pacearr expands only that season when someone actually starts it.

## Dry-Run Safety Boundary

Dry-run mode is enabled by default, including for existing databases that predate the setting. While enabled, Pacearr can read Sonarr and calculate every intended action, but the Sonarr integration blocks all monitoring updates, searches, and episode-file deletions. Planned actions are written to the application log and history with `dry_run` action names.

Dry runs do not mark seasons expanded, remove expanded-season state, or clear expansion state during resets, because doing so would incorrectly claim that Sonarr was changed. Disabling dry-run mode in Settings is required before any Sonarr mutation can be sent.

## Enrollment

Enrollment starts from an existing Sonarr series. Pacearr does not search for or add series.

When a show is enrolled:

1. Pacearr creates or updates a `rolling_shows` row keyed by Sonarr series id.
2. If history import is enabled, Pacearr imports Plex/Tautulli history and identifies seasons retained by active viewers.
3. If baseline application is enabled, Pacearr applies the all-season-pilot baseline only to seasons without active viewers. Retained seasons remain fully monitored.

The current UI enroll action sends both `applyBaseline: true` and `importHistory: true`.

## Early Season Prefetch

Early season prefetch is optional and disabled by default. When enabled, a watch
event within the configured remaining-episode threshold monitors and searches
E02 onward (up to the configured count) in the next real season. Sonarr only
receives episodes that actually exist, so short seasons are naturally capped.

Prefetched episodes are stored separately from `expanded_seasons`, including the
user and timestamp that triggered them. Reconciliation preserves those
individual episode targets without treating the entire season as expanded. When
E01 is watched and the season expands, its prefetch records are cleared. The
show detail page displays the prefetched episodes and triggering user.

The setting is controlled under Settings → Automation:

| Setting | Default | Meaning |
|---|---:|---|
| Early season prefetch | off | Enable early monitoring/searching of the next season |
| Episodes remaining trigger | 3 | Start when this many episodes remain after the watched episode |
| Episodes to prefetch | 2 | Number of next-season episodes after E01 to target |

When the optional rolling-season artwork setting is enabled in live mode,
Pacearr also labels pilot-only Plex season posters with `WATCH E01 TO UNLOCK`.
It restores the saved original poster as soon as that season is expanded.

The show detail dry-run plan uses this same effective target state. It lists retained
seasons explicitly and excludes their episodes and files from unmonitoring or deletion.
Active progress is also reconciled independently of newly imported events, so watch
events first recorded in dry-run can still expand their seasons after live mode is enabled.

## Baseline

The all-season-pilot baseline means:

- series `monitored` is set to `true`
- series `monitorNewItems` is set to `none`
- each real season's season-level monitored flag is set to `false`
- every E01 in seasons greater than `0` is monitored
- every E02+ in seasons greater than `0` is unmonitored
- every E01 is searched with Sonarr's `EpisodeSearch`
- E02+ files are deleted in live mode

Season `0` specials are ignored.

## Expansion

Pacearr expands a season when an enabled user watches E01 of that season.

The trigger can come from:

- Plex playback history import
- Tautulli history import
- Plex live session polling

Expansion does this:

1. Fetch Sonarr episodes for the series.
2. Set the season-level monitored flag to `true`.
3. Monitor all episodes in the watched season.
4. Trigger Sonarr `SeasonSearch`.
5. Add the season number to `rolling_shows.expanded_seasons`.
6. Record a `history_events` audit entry.

If the season is already expanded, Pacearr skips the Sonarr mutation and search.

## Per-User Progress

Pacearr stores per-user progress in `rolling_show_users`.

Progress includes:

- rolling show id
- user id
- last watched season
- last watched episode
- last watched timestamp

Only enabled users can trigger expansion or block cleanup.

## Scheduled Reconciliation

The `rolling-reconcile` job checks every enrolled show every six hours. It
derives retained seasons from enabled viewers active inside the configured
activity window, applies the inactive-season cleanup delay, then brings Sonarr
back to that target state. This covers new enrollments with no viewer activity,
dry-run-to-live transitions, missed playback events, manual changes made in
Sonarr, and orphaned non-pilot files left by an interrupted cleanup.

The job does not repeatedly search healthy pilots. If a newly active viewer
makes a season required, it monitors that season and starts a Sonarr season
search once as part of the correction.

## Progressive Cleanup

Progressive cleanup can shrink older expanded seasons back to E01-only as users move forward.

When a watch event is processed and `progressiveCleanupEnabled` is true:

- Pacearr checks expanded seasons lower than the user's current season.
- If no enabled user still has progress at or before a candidate season, that season is reset to pilot-only.
- Pacearr keeps E01 monitored, unmonitors E02+, disables the season-level flag, and deletes E02+ files when file deletion is enabled.

Before this cleanup runs, an inactive expanded season waits for the configured
**Inactive-season cleanup delay**, which defaults to seven days. Pacearr records
the first reconciliation that observes the season has no active viewer; this is
the start of the timer for legacy seasons whose earlier transition is unknown.
If a viewer returns before the delay expires, the timer is cleared. A value of
`0` preserves immediate cleanup. Seasons that were never expanded are already
pilot-only and need no inactivity timer.

Progressive cleanup is intentionally conservative. Multi-user activity should preserve seasons still relevant to another enabled user.

## Deletion Safety

In live mode, Pacearr deletes Sonarr episode files for non-pilot episodes during:

- baseline application
- manual reset
- scheduled reconciliation
- progressive cleanup

Every cleanup path should write a `history_events` entry with enough context to understand what happened.

## Unenrolment

In live mode, unenrolling first restores any Plex posters Pacearr changed and
then sets the Sonarr series, all real seasons, and all real episodes to
monitored. It deliberately does not search for media. If either restoration or
re-monitoring fails, Pacearr keeps its enrolment state so the operation can be
retried safely. Dry-run reports this action without changing Plex, Sonarr, or
the stored enrolment.

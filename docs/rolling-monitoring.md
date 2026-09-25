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
2. If baseline application is enabled, Pacearr immediately applies the all-season-pilot baseline using already stored active-viewer progress. Retained seasons remain fully monitored. This pass never deletes files.
3. If history import is enabled, Pacearr then performs a full verified Plex/Tautulli history read so older previously unmatched events can be repaired.
4. Pacearr applies every active viewer's position (season expansion, finale expansion, early prefetch). If baseline application is enabled, it then corrects monitoring and deletes non-pilot files, retaining what those positions expanded or prefetched.

A history read that returns errors is treated as incomplete: Pacearr records a warning and corrects monitoring from stored progress but leaves files intact for this run. Automatic new-show triage runs step 4 itself, once per enrollment batch after its own full history read, when Plex or enabled Tautulli history is configured.

The current UI enroll action sends both `applyBaseline: true` and `importHistory: true`.

## Early Season Prefetch

Early season prefetch is optional and disabled by default. When enabled, a watch
event within the configured remaining-episode threshold monitors and searches
E02 onward (up to the configured count) in the next real season. Sonarr only
receives episodes that actually exist, so short seasons are naturally capped.

Like expansion, prefetch is applied by every job, including the catch-up sweeps (see
Same Actions From Every Job), so a viewer inside the trigger is prefetched for even if
their watch was stored while prefetch was off.

Prefetched episodes are stored separately from `expanded_seasons`, including the
user and timestamp that triggered them. Reconciliation preserves those
individual episode targets without treating the entire season as expanded. When
a season expands from playback or is retained from active viewer progress, its
prefetch records are cleared. The show detail page displays the prefetched
episodes and triggering user. During
scheduled reconciliation, a prefetch is reclaimed after the progressive cleanup
delay when no active enabled viewer still needs that season (because viewers are
inactive or have progressed beyond it). Dry-run previews this cleanup without
clearing persisted prefetch state. This reclaim, like expanded-season cleanup,
is disabled when the **Progressive cleanup** setting is disabled.

The settings are under Settings → General → Rolling behaviour:

| Setting | Default | Meaning |
|---|---:|---|
| Early season prefetch | off | Enable early monitoring/searching of the next season |
| Episodes remaining trigger | 3 | Start when this many episodes remain after the watched episode |
| Episodes to prefetch | 2 | Number of next-season episodes after E01 to target |

### Expand Next Season On Finale

Optional and disabled by default, independent of early prefetch. When an enabled
user's watch event is for the last episode of a season, Pacearr fully expands the
next real season (see Expansion), so it downloads while the finale is still playing.

| Rule | Behaviour |
|---|---|
| Last episode | Exactly the highest episode number Sonarr lists for that season, aired or not — a season still airing only triggers on its announced finale, and a higher number than Sonarr lists never triggers |
| Next season | Next real season in Sonarr, skipping gaps and season `0`; nothing happens if none exists yet or it is already expanded |
| Trigger timing | Same as E01 expansion: the first live session poll that sees the episode playing, or a history import |
| Catch-up | The catch-up sweeps (see Same Actions From Every Job) also expand it for any active viewer whose stored progress is a finale, for example one watched before the setting was enabled |
| One-episode season | Its E01 expands that season and then the next |
| Early prefetch | A finale expansion replaces prefetching that season; its prefetch records are cleared |
| Retention | The next season is held while any active viewer's last watched season is at or before it, so a viewer still on the finale keeps it |
| Dry run | Records `dry_run.sonarr.expand_season` without changing Sonarr or `expanded_seasons` |

History entries record `source` as `<source>-finale` (for example `plex-session-finale`).

| Setting | Default | Meaning |
|---|---:|---|
| Expand next season on finale | off | Expand the whole next season when a season's last episode is watched |

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

Pacearr expands a season when an enabled user watches any episode of it (normally
E01), or, with **Expand next season on finale** enabled, the last episode of the
season before it.

### Same Actions From Every Job

Every rolling action is derived from a viewer's position (season, episode), not from
the job that noticed it. One routine, `applyViewerPositionActions`, applies them in
this order:

1. Expand the season the viewer is in, if not already expanded.
2. If the position is that season's finale and the setting is on, expand the next season.
3. Otherwise, if early prefetch is on and the position is inside the trigger, prefetch the next season.

Each step is idempotent, so running it again for the same position does nothing.

| Job | Positions applied | History `source` |
|---|---|---|
| Plex live session polling | The playing episode | `plex-session` |
| Tautulli active session polling | The playing episode | `tautulli-active-session` |
| Plex history import | Each newly imported watch that advances progress | `plex-history` |
| Tautulli history import | Each newly imported watch that advances progress | `tautulli` |
| Routine history import, catch-up | Every active viewer's stored progress | `active-progress-reconcile` |
| Rolling reconcile (every 6 hours) | Every active viewer's stored progress, before planning | `active-progress-reconcile` |
| Enrolment / auto-triage | Every active viewer's stored progress, after the baseline and before the pass that deletes files | `enroll` / `auto-triage-history` |

Finale expansions append `-finale` to the source. The catch-up sweeps cover a watch
that was stored while a setting was off, in dry run, or while another operation held
the series. Stored events are never reprocessed, so without them that watch would never act.

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

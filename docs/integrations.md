# Integrations

## Plex

Plex provides authentication, user discovery, playback history, and live session state.

### Auth

The UI uses Plex's PIN-based OAuth flow:

1. The browser requests a Plex PIN.
2. A popup opens Plex auth.
3. The client polls for an auth token.
4. The backend validates the token and stores the first successful account as the Pacearr owner.

Manual token entry remains available as a fallback.

### Server Connection

Pacearr stores:

- Plex server URL
- Plex machine identifier
- owner Plex token

### Optional rolling-season artwork

When **Rolling-season artwork** is enabled and Pacearr is in live mode, it
matches an enrolled Sonarr show to Plex using only TVDB or IMDb identifiers.
It never uses a title match for artwork changes.

| ID lookup finds | Result |
|---|---|
| One Plex item | That item gets artwork |
| Different Plex shows (different Plex GUIDs) | Skipped |
| One Plex show in several TV libraries | Only the copy whose Plex folder (`Location` path) equals Sonarr's `series.path` gets artwork; skipped if not exactly one does. Paths are compared exactly apart from a trailing path separator (`/` or `\`), so differing Sonarr/Plex mount points are skipped |

Pacearr saves each affected
season's original poster under `/config/plex-artwork`, overlays `WATCH E01 TO
UNLOCK` while that season is pilot-only, and restores the original image when
the season expands or the show is unenrolled. The original backup makes
restoration independent of Plex metadata refreshes.

Artwork writes are skipped entirely in dry-run mode.

The server connection is verified through the Plex server `/identity` endpoint.

### User Discovery

Pacearr stores the owner as a user and attempts to fetch Plex friends through `https://plex.tv/api/users`.

Users are persisted in `users` with:

- Plex user id
- Plex account id where available
- username
- display name
- avatar URL
- enabled flag

Only enabled users can trigger season expansion or block cleanup.

### Playback History

Plex playback history is the default backfill source.

Pacearr imports episode history through:

```text
/status/sessions/history/all
```

Imported episode events are normalised into `watch_events`.

### Live Sessions

The `session-check` job polls:

```text
/status/sessions
```

Only `episode` sessions are processed. Live sessions use the same normalization and expansion path as imported history.

### Matching

Pacearr associates history with Sonarr only through verified TVDB or IMDb IDs. For Plex history, it first resolves a supplied show rating key through Plex metadata. Sparse Plex history without that key may perform a library-title lookup only to find a Plex candidate; its metadata IDs must still uniquely agree with Sonarr before the event is linked. The live-session job never performs the title lookup.

Plex identity results are persisted by a hash of the configured Plex connection plus the rating key (or, for sparse history, library section and title), so repeated events do not repeat metadata requests and a different configured server never reuses the old server's result. Resolved identities are revalidated after seven days, preventing a reused local-library key from becoming a permanent association; missing and ambiguous identities are rechecked after one day, so later Plex metadata repairs can link them. During a history import, new Plex identities are resolved at most once per second across all Pacearr jobs; cached identities are immediate. After three consecutive Plex metadata failures in one job, further uncached Plex identities are left unmatched until the next job.

## Sonarr

Pacearr v1 supports one Sonarr instance.

The Sonarr settings are:

- base URL
- API key

Use the final, canonical base URL for every configured integration. Pacearr sends credentials with integration requests and deliberately rejects redirects, so a URL that redirects (for example, from HTTP to HTTPS or to another base path) will fail instead of being followed.

### Endpoints Used

| Purpose | Sonarr API |
|---|---|
| Test connection | `GET /api/v3/system/status` |
| List shows | `GET /api/v3/series` |
| Get one show | `GET /api/v3/series/{id}` |
| Get episodes | `GET /api/v3/episode?seriesId={id}` |
| Cache show posters | Sonarr `series.images[].remoteUrl` poster URLs, falling back to local media URLs |
| Update series/seasons | `PUT /api/v3/series/{id}` |
| Update episode monitoring | `PUT /api/v3/episode/monitor` |
| Search pilots | `POST /api/v3/command` with `EpisodeSearch` |
| Search full season | `POST /api/v3/command` with `SeasonSearch` |
| Search full series | `POST /api/v3/command` with `SeriesSearch` |
| Delete episode file | `DELETE /api/v3/episodefile/{id}` |
| Read / create Pacearr tags | `GET /api/v3/tag`, `POST /api/v3/tag` |
| Add / remove a Pacearr tag | `PUT /api/v3/series/editor` with `applyTags: "add"` or `"remove"` |

### Show Review Data

The Shows UI reads Sonarr series, season, episode, and poster metadata through the backend. Posters are downloaded by the server and served from the local image cache under `/images`, so browsers do not need direct Sonarr access. Pacearr prefers Sonarr's poster `remoteUrl` because local `/MediaCover` URLs can return the Sonarr web app HTML on deployments that protect media routes behind UI auth; the local URL remains a fallback when no remote URL is available.

The show detail view combines Sonarr's current library state with Pacearr's normalised `watch_events` table. This lets reviewers see which seasons and episodes have imported viewer activity before deciding whether a show is a good fit for rolling episode enrollment.

### Automatic new-show triage

When enabled, Pacearr polls Sonarr every five minutes by default; the interval
is configurable in Settings → Jobs. It ignores series that
were already present when the setting was enabled, then searches smaller new
series in full and enrolls series over the configured total-episode limit onto
the pilot baseline. Successful live decisions are persisted so a restart does
not repeat them; dry-run and failed arrivals remain pending for a later poll.
To minimise downloads that Pacearr subsequently purges, disable
**Search on Add** in any source that adds series to Sonarr.

### Tags

Pacearr can mirror its state onto Sonarr series as tags, for recovery after database
loss and for filtering in Sonarr. Pacearr's database stays the source of truth.

Writing is opt-in: Settings → Sonarr → **Write tags to Sonarr**
(`sonarrTagsEnabled`, off by default).

| Tag | On |
|---|---|
| `pacearr-enrolled` | every enrolled show, manual or auto-triaged |
| `pacearr-ignored` | every ignored show |

| Rule | Detail |
|---|---|
| Only Pacearr's tags | Writes go through the bulk series editor with `add`/`remove`, sending only these two tag IDs. Any other tag on a series is never touched. The tags are created in Sonarr if missing. |
| Adds are reconciled | Each Sonarr library refresh adds any tag an enrolled or ignored show is missing. |
| Removals need a Pacearr action | Unenrol, restore from ignored, and enrolling an ignored show queue a removal (`sonarr_tag_removals`). A show having no record never removes its tag, so an empty database cannot wipe the recovery data. |
| Failed removals retry | A queued removal is retried on every library refresh until Sonarr confirms it, or dropped if the show is back in that state or gone from Sonarr. |
| Off, or dry run | No tag request is sent at all. Removals are still queued, so a tag written before writing was turned off is removed once it is back on. Turning writing on (outside dry run), or dry run off with writing on, triggers a library refresh, which catches up. |
| Manual edits | Editing a Pacearr tag in Sonarr has no effect on Pacearr. A removed tag is added back on the next refresh. |
| Series deleted from Sonarr | No removal is sent; its tags went with it. |

A Pacearr tag has no effect in Sonarr unless someone links it to a release profile,
delay profile, indexer, download client or notification.

#### Import from Sonarr tags

Settings → Sonarr → **Import from Sonarr tags**. Never automatic. Available whether
or not tag writing is on, since a fresh install starts with it off.

1. `GET /api/sonarr/tag-import` previews: shows to enrol, shows to ignore, tagged
   shows already in Pacearr (left alone), and shows with both tags (skipped). A tag
   with a queued removal counts as absent.
2. After one confirmation, `POST /api/sonarr/tag-import` creates records only for
   the series IDs that preview listed and Pacearr still has no record of.

Re-adoption skips the enrolment pilot baseline and sends nothing to Sonarr. Seasons
Sonarr still monitors are recorded as expanded, so the rolling reconcile times them
out as usual instead of trimming them to pilots. When any show was re-adopted, the
import then runs a full history reconciliation (Plex and Tautulli; a run already in
progress is waited out and a fresh one started) and only after it finishes a rolling
reconciliation, so viewer progress is rebuilt before the shows are reconciled.

Until a full history reconciliation that started after the import completes
successfully, a re-adopted show is flagged (`rolling_shows.awaiting_history_since`):
the rolling reconcile skips it and watch events do not run progressive cleanup on it,
so its Sonarr monitoring is left as found. If that read fails, the show stays
protected until a later full reconciliation succeeds. Tags restore membership only: exclusions, prefetch records and Plex
poster backups are not recoverable from them.

Allowed in dry run, because it writes only Pacearr's own records, like a manual
enrolment.

### Non-Goals

Pacearr does not:

- add series to Sonarr
- choose root folders
- choose quality profiles
- manage release profiles
- submit requests to Seerr/Jellyseerr/Overseerr

## Tautulli

Tautulli is optional.

When enabled, Pacearr imports episode watch history through Tautulli's API:

```text
cmd=get_history
```

Tautulli events are normalised into the same `watch_events` table as Plex events.

For content matching, Pacearr resolves Tautulli's `grandparent_rating_key` through `cmd=get_metadata` and uses the returned TVDB/IMDb GUIDs. Tautulli identity results are cached separately from Plex results and are hashed with the configured Tautulli connection; one source or configured instance never supplies matching evidence for another. Resolved identities are revalidated after seven days; missing and ambiguous identities are rechecked after one day. During a history import, new Tautulli identities are resolved at most once per second across all Pacearr jobs; cached identities are immediate. After three consecutive Tautulli metadata failures in one job, further uncached Tautulli identities are left unmatched until the next job.

Tautulli is useful when it has longer or more reliable local watch history than Plex. It is not required for Pacearr to function.

### User Matching

`get_history` reports two names per event, and Pacearr treats them as independent signals with different trust levels:

| Tautulli field | Meaning | Trust |
|---|---|---|
| `username` | The real Plex username. Empty for Plex Home/managed users. | Tried first |
| `user` | The friendly name, editable per user in Tautulli's admin UI at any time. | Fallback only |

Matching is case-insensitive and follows this order:

1. A manually saved Tautulli `user_id` mapping wins outright. The Users page lists unmatched Tautulli identities in a collapsed section; mapping one saves its stable ID and displayed username against the Pacearr user, then re-links its stored unmatched history. The editable Tautulli user field is a fallback if the stable ID is unavailable.
2. Try the saved editable Tautulli username against the event `username`, then `user`. An ambiguous saved-name match stops the lookup rather than guessing.
3. Try `username` against Pacearr's Plex-sourced `users.username` then `users.display_name`. An unambiguous match wins outright.
4. A `username` match that is ambiguous (colliding case-insensitively across multiple Pacearr users) stops the lookup — the friendly name is not tried, since a coincidental match there could attribute the event to an unrelated third user.
5. If `username` produced no match at all (not ambiguous, just nothing), try the friendly name the same way.

A duplicate event (same `source_event_id`) that was previously imported with `user_id = NULL` is repaired in place once a later import resolves a match, and that user's rolling progress is refreshed — otherwise `INSERT OR IGNORE` would leave it orphaned forever.

Plex events stored with `user_id = NULL` are linked on each Plex user discovery (saving Plex settings or refreshing users):

1. Each is linked to the user with the same Plex.tv account ID. The owner also matches the server-local account ID `1`.
2. An account ID claimed by more than one user is skipped and logged as a warning.
3. Each linked user's rolling progress is refreshed. Expansion or prefetch follows on the next rolling reconcile.

## Failure Behaviour

External API failures should:

- return a useful API error to the UI for manual actions
- write a `history_events` error or warning for background/import work
- avoid corrupting persisted progress
- avoid repeated destructive cleanup when the desired state is unclear

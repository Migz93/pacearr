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
It never uses a title match for artwork changes. Pacearr saves each affected
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

Pacearr tries to match Plex/Tautulli events to enrolled Sonarr shows in this order:

1. TVDB id, when Plex show metadata can provide it
2. IMDB id, when Plex show metadata can provide it
3. normalised show title fallback

This means Plex events with a show rating key may trigger an extra Plex metadata fetch to read GUIDs.

## Sonarr

Pacearr v1 supports one Sonarr instance.

The Sonarr settings are:

- base URL
- API key

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
| Delete episode file | `DELETE /api/v3/episodefile/{id}` |

### Show Review Data

The Shows UI reads Sonarr series, season, episode, and poster metadata through the backend. Posters are downloaded by the server and served from the local image cache under `/images`, so browsers do not need direct Sonarr access. Pacearr prefers Sonarr's poster `remoteUrl` because local `/MediaCover` URLs can return the Sonarr web app HTML on deployments that protect media routes behind UI auth; the local URL remains a fallback when no remote URL is available.

The show detail view combines Sonarr's current library state with Pacearr's normalised `watch_events` table. This lets reviewers see which seasons and episodes have imported viewer activity before deciding whether a show is a good fit for rolling episode enrollment.

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

Tautulli is useful when it has longer or more reliable local watch history than Plex. It is not required for Pacearr to function.

### User Matching

`get_history` reports two names per event, and Pacearr treats them as independent signals with different trust levels:

| Tautulli field | Meaning | Trust |
|---|---|---|
| `username` | The real Plex username. Empty for Plex Home/managed users. | Tried first |
| `user` | The friendly name, editable per user in Tautulli's admin UI at any time. | Fallback only |

Matching order, against Pacearr's `users.username` then `users.display_name` (both sourced from Plex, case-insensitively):

1. Try `username`. An unambiguous match wins outright.
2. A `username` match that is ambiguous (colliding case-insensitively across multiple Pacearr users) stops the lookup — the friendly name is not tried, since a coincidental match there could attribute the event to an unrelated third user.
3. If `username` produced no match at all (not ambiguous, just nothing), try the friendly name the same way.

A duplicate event (same `source_event_id`) that was previously imported with `user_id = NULL` is repaired in place once a later import resolves a match, and that user's rolling progress is refreshed — otherwise `INSERT OR IGNORE` would leave it orphaned forever.

## Failure Behaviour

External API failures should:

- return a useful API error to the UI for manual actions
- write a `history_events` error or warning for background/import work
- avoid corrupting persisted progress
- avoid repeated destructive cleanup when the desired state is unclear

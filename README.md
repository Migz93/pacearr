# Pacearr

<img src="./public/logo.png" alt="Pacearr logo" width="256" height="256" />

[![GitHub Activity][commits-shield]][commits]
[![License][license-shield]][license]
[![Project Maintainer][maintainer-shield]][user_profile]
[![Buy me a coffee][buymecoffeebadge]][buymecoffee]

Pacearr is a self-hosted Plex and Sonarr companion that keeps selected shows in an all-season-pilot rolling state.

It works with series that already exist in Sonarr: Pacearr imports Plex and optional Tautulli watch history, lets you enrol specific shows, and expands a season only when an enabled viewer watches that season's first episode.

## What Pacearr Does

- Lists and enrols shows already managed by Sonarr
- Keeps the first episode of every real season available as a pilot
- Expands a season when an enabled viewer starts that season's first episode
- Imports playback history from Plex and optionally Tautulli
- Polls active Plex sessions so season expansion can happen without waiting for a history import
- Can progressively return older seasons to pilot-only monitoring after viewers move on
- Records its actions in a user-visible history and retains structured application logs

## Preview

### Dashboard

Enrolled shows, active viewers, retained seasons, and reclaimed disk space, with recent activity and the next operational signals.

![Pacearr preview](./public/pacearr-preview.png)

### Recommendations

Un-enrolled Sonarr shows ranked by how much disk space enrolling them would free up.

![Recommendations preview](./public/recommendations-preview.png)

## Key Features

- Plex sign-in with a manual-token fallback
- Sonarr integration for monitoring, searching, and optional episode-file cleanup
- Optional Tautulli history import for installations with richer local history
- Dry-run mode enabled by default, so every proposed Sonarr change can be reviewed safely
- Per-user progress, allowing multiple viewers to retain seasons that are still relevant
- Optional rolling-season Plex artwork that marks pilot-only seasons and restores the original artwork when they expand
- Scheduled reconciliation to recover from missed events and manual Sonarr changes

## How It Works

Pacearr maintains an all-season-pilot baseline for each enrolled show: the first episode of every real season remains monitored, while later episodes are unmonitored. When an enabled viewer watches a season's first episode, Pacearr expands that season, monitors it fully, and asks Sonarr to search for it.

Pacearr uses several background jobs:

- **Plex session checks** observe active episode playback
- **History imports** collect Plex and optional Tautulli watch history
- **Full history reconciliation** periodically recovers events that a source may have missed
- **Rolling reconciliation** brings enrolled shows back to the monitoring state implied by enabled viewers' progress

Together, these jobs make Pacearr responsive to new viewing activity while preserving a slower safety net for monitoring state.

## Quick Start

### Requirements

- A Plex Media Server you manage
- A Plex account
- A Sonarr v3 instance with series you want Pacearr to manage
- Network access from Pacearr to Plex and Sonarr
- Tautulli is optional, but useful when it has more complete local playback history

### Docker

```bash
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  ghcr.io/migz93/pacearr:latest
```

You can then open `http://localhost:9302` and complete setup in the browser.

### Docker Compose

```yaml
services:
  pacearr:
    image: ghcr.io/migz93/pacearr:latest
    container_name: pacearr
    network_mode: bridge
    restart: unless-stopped
    ports:
      - "9302:9302"
    volumes:
      - /opt/pacearr:/config
    environment:
      - TZ=UTC
```

```bash
docker compose up -d
```

### Configuration

Pacearr is configured through its web UI after first run. The main things you may want to adjust in your Docker setup before starting:

- **Port** — change the left side of `9302:9302` to expose Pacearr on a different host port (e.g. `8080:9302`)
- **Data directory** — change the left side of `/opt/pacearr:/config` to store Pacearr's database, artwork backups, image cache, and logs wherever you prefer on your host
- **Timezone** — set `TZ` to your preferred timezone if you do not want UTC

### First Setup

1. Sign in with Plex and select the Plex server Pacearr should use
2. Configure the Sonarr base URL and API key, then test the connection
3. Optionally configure Tautulli if you want its playback history included
4. Discover Plex users and enable the viewers whose progress should control season expansion
5. Review a show and enrol it while Pacearr remains in dry-run mode
6. Inspect the planned actions, then disable dry-run mode only when you are ready for Pacearr to update Sonarr

## Important Limitations

### Dry-Run Mode

Dry-run mode is enabled by default. While it is enabled, Pacearr reads Sonarr and calculates the monitoring, search, artwork, and cleanup actions it would take, but it does not send mutating requests to Sonarr or Plex. Disable dry-run mode explicitly in Settings only after you have reviewed the proposed behavior.

### Sonarr Changes And Cleanup

Pacearr does not add series to Sonarr, choose root folders, change quality profiles, or submit requests to other media-request applications. In live mode, it can monitor and unmonitor episodes, trigger searches, and—when cleanup is enabled—delete non-pilot episode files as part of its rolling-state maintenance. Its history and logs record those actions for review.

### Multiple Viewers

Only enabled Plex users can expand seasons or keep them from being cleaned up. Progressive cleanup is conservative: a season stays expanded while it remains relevant to any enabled viewer.

## AI Transparency

Pacearr was created with heavy AI assistance.

Claude, Codex, Leonardo.ai, and CodeRabbit were all used throughout the project for design exploration, implementation help, refactoring, review, explanation, and iteration. The intent is not to hide that. Pacearr has been built by combining hands-on product direction with a lot of AI-assisted development work.

## Credits And Inspiration

Pacearr was shaped in part by studying projects that solve adjacent problems well, especially Sonarr, Tautulli, Hubarr, and Pulsarr.

Those projects were helpful references for thinking about media automation, background-job design, Plex integration patterns, logging, and operational workflows. Pacearr has its own scope, but it would be unfair not to acknowledge their influence.

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/Sonarr/Sonarr">Sonarr</a>
    </td>
    <td align="center">
      <a href="https://github.com/Tautulli/Tautulli">Tautulli</a>
    </td>
    <td align="center">
      <a href="https://github.com/Migz93/hubarr">Hubarr</a>
    </td>
    <td align="center">
      <a href="https://github.com/jamcalli/pulsarr">Pulsarr</a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/Sonarr/Sonarr">
        <img src="https://raw.githubusercontent.com/Sonarr/Sonarr/develop/Logo/512.png" alt="Sonarr logo" width="72" height="72" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/Tautulli/Tautulli">
        <img src="https://raw.githubusercontent.com/Tautulli/Tautulli/master/data/interfaces/default/images/logo-circle.png" alt="Tautulli logo" width="72" height="72" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/Migz93/hubarr">
        <img src="https://raw.githubusercontent.com/Migz93/hubarr/refs/heads/main/public/logo.png" alt="Hubarr logo" width="72" height="72" />
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/jamcalli/pulsarr">
        <img src="https://raw.githubusercontent.com/jamcalli/Pulsarr/refs/heads/master/assets/icons/pulsarr.svg" alt="Pulsarr logo" width="72" height="72" />
      </a>
    </td>
  </tr>
</table>

[buymecoffee]: https://www.buymeacoffee.com/Migz93
[buymecoffeebadge]: https://img.shields.io/badge/buy%20me%20a%20coffee-donate-yellow.svg?style=for-the-badge
[commits-shield]: https://img.shields.io/github/commit-activity/y/Migz93/pacearr.svg?style=for-the-badge
[commits]: https://github.com/Migz93/pacearr/commits/main
[license]: https://github.com/Migz93/pacearr/blob/main/LICENSE
[license-shield]: https://img.shields.io/github/license/Migz93/pacearr.svg?style=for-the-badge
[maintainer-shield]: https://img.shields.io/badge/maintainer-Migz93-blue.svg?style=for-the-badge
[user_profile]: https://github.com/Migz93

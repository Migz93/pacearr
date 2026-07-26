# Testing

Pacearr currently has TypeScript checks, focused server/database tests, production build verification, and Docker smoke testing. Playwright end-to-end tests are not scaffolded yet.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Runs TypeScript checks for the client, shared types, and server |
| `npm run test:server` | Builds the server, compiles server tests, and runs Node's test runner |
| `npm run build` | Builds the Vite client and TypeScript server |
| `docker build -t pacearr .` | Builds the production Docker image |

## Live Container Smoke Test

Pacearr is intended to run as a live Docker container with persistent state under `/opt/pacearr`.

Use the Docker conventions in `AGENTS.md`:

```bash
docker build -t pacearr .
docker rm -f pacearr || true
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  pacearr
```

Then verify the app is listening:

```bash
docker logs --tail 20 pacearr
docker exec pacearr node -e "fetch('http://127.0.0.1:9302/api/health').then(r => r.text()).then(console.log)"
```

Depending on the devcontainer/DooD network behavior, `curl http://127.0.0.1:9302/api/health` from inside the devcontainer may not reach the host-published port. Testing from inside the container with `docker exec` is the most reliable smoke check.

## Server Test Suite

### `tests/server/db.test.ts` — Database invariants

Runs against a temporary SQLite database. Safe to run any time.

| Test | What it checks |
|---|---|
| Rolling show enrollment is idempotent | A Sonarr series can only create one Pacearr rolling-show row |
| Watch event import is idempotent | Duplicate source events are ignored and do not inflate watch history |
| Expanded seasons are monotonic and not duplicated | Expansion state is sorted and duplicate-safe |
| Expanded seasons can be removed during progressive cleanup | Progressive cleanup can remove a season from expansion state |
| Dry-run defaults are safe | New and legacy/partial settings resolve to dry-run enabled |

### `tests/server/sonarr-dry-run.test.ts` — Sonarr mutation boundary

| Test | What it checks |
|---|---|
| Dry-run blocks Sonarr mutations | Monitoring updates, searches, and file deletions send no HTTP requests while dry-run mode is enabled |

## Manual Verification Checklist

Use this after changes that touch external integrations, cleanup, or Docker behavior:

- Sign in with Plex OAuth or manual token fallback
- Configure Plex server URL and machine identifier
- Configure Sonarr base URL and API key
- Optionally configure Tautulli and save settings
- Open Shows and confirm Sonarr series load
- Enroll a known show and confirm Pacearr applies the all-season-pilot baseline
- Run Import History and confirm relevant SxxE01 history expands seasons
- Run Check Sessions while a Plex episode is active and confirm live expansion
- Run inactive reset only when you are comfortable with cleanup/deletion behavior

## Future Playwright Tests

When Playwright is added, follow these expectations:

- Tests should live in `tests/playwright/`
- Tests should run with `npm run test:e2e`
- Tests should hit a live running Pacearr instance, not a mocked app, unless the harness explicitly says otherwise
- Auth should use a `SESSION_COOKIE` env var in `.env.playwright` rather than browser-driven OAuth, because the devcontainer has no display
- Session state should be saved under `tests/playwright/.auth/`

When implementing a new feature, consider whether a Playwright test makes sense for it. If it does, suggest the test to the user before adding it.

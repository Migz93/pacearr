<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Testing

Pacearr has TypeScript checks, focused server/database tests, production build
verification, and Docker smoke testing. Server tests run against a temporary
SQLite database with no external services involved.

## Commands

| Command | What it does |
|---|---|
| `npm run test:server` | Builds the server, compiles server tests, and runs Node's test runner |
| `npm test` | Runs already-compiled server tests |
| `npm run check` | Runs TypeScript checks for the client, shared types, and server |
| `npm run build` | Builds the Vite client and TypeScript server |

## Server Tests

Server tests use Node's built-in test runner against a temporary SQLite
database. Safe to run any time — they touch no real data and make no network
calls.

## Playwright End-To-End Tests

Not implemented yet. Tracked in
[#50](https://github.com/Migz93/pacearr/issues/50).

When Playwright is added, copy the setup from
[hubarr](https://github.com/Migz93/hubarr) — `playwright.config.ts`,
`.env.playwright.example`, `tests/playwright/auth.setup.ts`, and the `test:e2e`
scripts — and adjust for Pacearr: the session cookie is `pacearr_session` and
`BASE_URL` points at port `9302`. Then replace this section with hubarr's
Playwright section, modified to suit.

---

## Test Suite

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

---

### `tests/server/recommendations.test.ts` — Service and Sonarr workflow behavior

| Test | What it checks |
|---|---|
| Reset clears prefetch targets before applying the pilot baseline | Reset removes persisted prefetch targets before reconciliation calculates which episodes to unmonitor and delete |


## Adding New Tests

Which layer to reach for — server test or Playwright — is covered in `AGENTS.md`
under Tests. Mechanically:

- **Server tests:** create a `*.test.ts` file under `tests/server/` and it is
  picked up by `npm run test:server`. Tests should build their own temporary
  database rather than sharing state.
- **Playwright:** not wired up yet — see
  [#50](https://github.com/Migz93/pacearr/issues/50). Say so rather than
  substituting a server test for a UI concern.

When a test is agreed and written, add a row for it in the relevant table above.

## Manual Smoke Test

For a local Docker verification:

```bash
docker build -t pacearr .
docker stop pacearr && docker rm pacearr
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  pacearr
docker logs pacearr 2>&1 | tail -5
```

Expected log line:

```text
Pacearr listening on port 9302
```

Depending on DooD network behaviour, `curl http://127.0.0.1:9302/api/health`
from inside the devcontainer may not reach the host-published port. Testing from
inside the container is the most reliable check:

```bash
docker exec pacearr node -e "fetch('http://127.0.0.1:9302/api/health').then(r => r.text()).then(console.log)"
```

Then open `http://localhost:9302` and smoke-test — use this after changes that
touch external integrations, cleanup, or Docker behaviour:

- Sign in with Plex OAuth or the manual token fallback
- Configure the Plex server URL and machine identifier
- Configure the Sonarr base URL and API key
- Optionally configure Tautulli and save settings
- Open Shows and confirm Sonarr series load
- Enroll a known show and confirm Pacearr applies the all-season-pilot baseline
- Run Import History and confirm relevant SxxE01 history expands seasons
- Run Check Sessions while a Plex episode is active and confirm live expansion
- Run inactive reset only when you are comfortable with cleanup/deletion
  behaviour

This section needs Docker. See "Where You're Running" in `AGENTS.md` — where it
is unavailable, say so rather than substituting a workspace check.

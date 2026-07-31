# Deployment

## Image And Container

| Thing | Value |
|---|---|
| Image name | `pacearr` |
| Container name | `pacearr` |
| Port | `9302` |
| Host data directory | `/opt/pacearr` |
| Container data directory | `/config` |

The image holds the built React client in `dist/client`, the compiled Express server in `dist/server`, and production dependencies only. The server command is `node dist/server/server/index.js`.

## Running It

```bash
docker compose up -d --build
```

Or without compose:

```bash
docker build -t pacearr .
docker rm -f pacearr
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  pacearr
```

Keep the image and container name as `pacearr`, use bridge networking, and preserve the `/opt/pacearr:/config` bind mount so configuration, database, and logs remain intact while the container is recreated.

Workspace checks are useful, but they don't verify the running deployment. Whenever implementation changes need end-to-end verification, rebuild the image from the current workspace and recreate the live container from it.

## Persistent Data

Everything Pacearr keeps — config, SQLite database, logs — lives in `/config`, bind-mounted from `/opt/pacearr` on the host. Keep it flat; don't add `config/`, `data/`, or `logs/` subdirectories. Don't use named Docker volumes for this app; the user needs host-visible files.

## Container User

The container starts as root, but the app process (PID 1) ends up as the unprivileged `node` user. `docker-entrypoint.sh` gets it there:

1. Pins `PATH` to system directories, so nothing it runs as root can be shadowed by a binary from a writable mount.
2. Canonicalises `DATA_DIR` and refuses to start unless it resolves to exactly `/config` — not a subpath, because the components of a subpath would live inside the bind mount and could be swapped for symlinks between validation and use.
3. Repairs ownership of `/config` via `docker-ownership-repair.py`, which walks the tree using directory descriptors and no-follow operations at every level, and chowns only entries that don't already match `node`.
4. Drops privileges with `gosu node` before `exec`ing the real `CMD`.

No host-side setup is needed. A brand-new empty bind mount (root-owned when Docker creates it) is repaired on first start, and an existing mount from an older root-run container is repaired on upgrade. `/app` stays root-owned, so `node` can read but not write application code.

Steps 1–3 only run when the container starts as root. An unsupported non-root launch (`docker run --user`) skips straight to `exec` with whatever `DATA_DIR` and UID it was given, and none of the validation or repair applies.

**Known limitation — hard links.** The symlink protections can't extend to hard links: `chown` acts on the inode, so a hard link inside `/config` sharing an inode with a file elsewhere on the same host filesystem would be re-owned too. This is inherent to recursively chowning any directory whose contents aren't fully trusted, and applies equally to official images that repair their own data directories. Linux's `fs.protected_hardlinks` (enabled by default on modern distributions) blocks creating such a link without access to the target.

## Runtime Config

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9302` | HTTP listen port |
| `DATA_DIR` | `/config` | Persistent config/database/log directory |
| `LOG_LEVEL` | `info` | Server log level |
| `TZ` | `UTC` | Container timezone |
| `BUILD_CHANNEL` | `custom` | Build metadata shown by the app |
| `COMMIT_SHA` | `local` | Build metadata shown by the app |

## Base Image Pinning

The `Dockerfile` pins `node:22-trixie-slim` by digest so a rebuild can't silently pull a different toolchain under the same tag. Bumping it is a deliberate step — resolve the new digest and replace it in all four `FROM` lines:

```bash
docker buildx imagetools inspect node:22-trixie-slim
```

## DooD Notes

The devcontainer talks to the host Docker daemon through Docker-outside-of-Docker:

- always use bridge networking; never `network_mode: host`
- don't browse or inspect `/opt/pacearr` from inside the devcontainer
- referencing `/opt/pacearr` in Docker bind mounts is fine

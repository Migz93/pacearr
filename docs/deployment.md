# Deployment

## Runtime

Pacearr runs as a single Node 22 container.

The image contains:

- built React client in `dist/client`
- compiled Express server in `dist/server`
- production dependencies

The server command is:

```bash
node dist/server/server/index.js
```

## Ports

Default internal port:

```text
9302
```

Recommended host mapping:

```text
9302:9302
```

## Persistent Data

Pacearr expects persistent data under `/config` inside the container.

On this host, bind mount:

```text
/opt/pacearr:/config
```

Do not use named Docker volumes for this app. The user needs host-visible files.

## Docker Run

```bash
docker run -d \
  --name pacearr \
  --network bridge \
  -p 9302:9302 \
  -v /opt/pacearr:/config \
  --restart unless-stopped \
  pacearr
```

## Docker Compose

```yaml
services:
  pacearr:
    image: pacearr
    container_name: pacearr
    network_mode: bridge
    restart: unless-stopped
    ports:
      - "9302:9302"
    volumes:
      - /opt/pacearr:/config
```

## Rebuilding After Changes

Workspace checks are useful, but they do not verify the running deployment.
Whenever implementation changes need end-to-end verification, build the image
from the current workspace and recreate the live `pacearr` container from it.

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

Keep the image and container name as `pacearr`, use bridge networking, and
preserve the `/opt/pacearr:/config` bind mount so configuration, database, and
logs remain intact while the container is recreated.

## DooD Notes

This devcontainer talks to the host Docker daemon through Docker-outside-of-Docker.

Important constraints:

- always use bridge networking
- do not use `network_mode: host`
- do not browse or inspect `/opt/pacearr` from inside the devcontainer
- it is fine to reference `/opt/pacearr` in Docker bind mounts

## Container User

The container's actual process (PID 1) runs as the non-root `node` user. It gets there via `docker-entrypoint.sh`, which starts as root, then:

1. Refuses to start if `DATA_DIR` isn't a non-root absolute path (rejects empty/unset and `/`). `DATA_DIR` is a user-configurable env var that's about to be recursively `chown`ed as root, so a misconfigured override can't be allowed to turn into a recursive chown of the whole container filesystem.
2. Creates `DATA_DIR` (`/config`) if it doesn't exist yet.
3. Runs `chown -R -h node:node "$DATA_DIR"`. The `-R` walk uses coreutils' own fd-relative traversal rather than re-resolving path strings, so a directory swapped out from under the walk can't redirect it outside `DATA_DIR`. The `-h` flag makes `chown` act on symlinks themselves rather than following them, so a symlink under `/config` pointing outside it gets re-owned itself without touching whatever it points to.
4. Drops privileges via `gosu node` before `exec`ing the real `CMD`.

This means no host-side ownership setup step is required: a brand-new, empty `/opt/pacearr` bind mount (root-owned by default when Docker creates it) is repaired on first start, and an existing `/opt/pacearr` from an older root-run container is repaired on upgrade. `/app` itself stays root-owned — the `node` user can read but not write application code/dependencies.

## Runtime Config

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9302` | HTTP listen port |
| `DATA_DIR` | `/config` | Persistent config/database/log directory |
| `LOG_LEVEL` | `info` | Server log level |
| `BUILD_CHANNEL` | `custom` | Build metadata shown by the app |
| `COMMIT_SHA` | `local` | Build metadata shown by the app |

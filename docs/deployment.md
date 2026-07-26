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

The current Docker image runs as the default container user so it can write to a host-created `/opt/pacearr` bind mount even when that directory is root-owned.

If the image is changed to run as the `node` user later, make sure deployment instructions include a reliable host-side ownership setup step.

## Runtime Config

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9302` | HTTP listen port |
| `DATA_DIR` | `/config` | Persistent config/database/log directory |
| `LOG_LEVEL` | `info` | Server log level |
| `BUILD_CHANNEL` | `custom` | Build metadata shown by the app |
| `COMMIT_SHA` | `local` | Build metadata shown by the app |

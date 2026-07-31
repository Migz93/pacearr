#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  # DATA_DIR is a user-configurable env var that we're about to recursively
  # chown as root. No supported deployment sets it to anything but /config
  # (see docs/deployment.md), so require that exact literal value rather
  # than /config-or-below: allowing a subpath would mean mkdir -p and
  # chown -R both have to walk through path components that live inside the
  # attacker-writable bind mount, and a component swapped for a symlink
  # between the realpath check below and the mkdir/chown that follow it
  # could redirect them outside /config (chown -h only protects the final
  # symlink in a path, not intermediate components — see the interior-walk
  # note below for why that's fine once we're inside /config itself, but
  # it does NOT cover resolving down to /config in the first place). Pinning
  # to the literal path removes that resolution step entirely: mkdir -p
  # becomes a no-op against the trusted mountpoint, not a walk through
  # untrusted content.
  # realpath -m (components don't need to exist yet, since DATA_DIR may not
  # exist on a fresh mount) catches equivalent forms like "//", "/./", or
  # "/config/.." that a raw string check would miss.
  case "$DATA_DIR" in
    /*) ;;
    *) echo "entrypoint: DATA_DIR must be an absolute path, got '$DATA_DIR'" >&2; exit 1 ;;
  esac
  DATA_DIR="$(realpath -m "$DATA_DIR")"
  if [ "$DATA_DIR" != "/config" ]; then
    echo "entrypoint: DATA_DIR resolves to '$DATA_DIR', which must be exactly /config" >&2
    exit 1
  fi
  export DATA_DIR
  mkdir -p "$DATA_DIR"
  # Use chown's own -R walk rather than `find -exec chown {} +`: coreutils
  # recurses via fts()/openat-relative syscalls against already-opened
  # directory file descriptors, so a parent directory swapped for a symlink
  # mid-walk can't redirect a later chown outside DATA_DIR the way
  # re-resolving each path string (as `find -exec` does) could.
  # -h is still required: without it, chown follows a symlink to its target,
  # so a symlink under DATA_DIR pointing outside it would let this root-run
  # repair change ownership of an arbitrary file elsewhere on the
  # filesystem. (Verified: -R -h re-owns a symlinked directory entry itself
  # but does not traverse into it, so contents outside DATA_DIR are
  # untouched either way.)
  chown -R -h node:node "$DATA_DIR"
  exec gosu node "$@"
fi

exec "$@"

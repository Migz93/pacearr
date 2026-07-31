#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  # DATA_DIR is a user-configurable env var that we're about to recursively
  # chown as root. Canonicalise it first (realpath -m: components don't need
  # to exist yet, since DATA_DIR may not exist on a fresh mount) — a raw
  # string check would miss forms like "//", "/./", or "/config/../.." that
  # also resolve to "/". Refuse the resolved path if it's root, or /app,
  # so a misconfigured override can't turn this into a recursive chown of
  # the whole container filesystem or silently defeat the /app read-only
  # guarantee below.
  case "$DATA_DIR" in
    /*) ;;
    *) echo "entrypoint: DATA_DIR must be an absolute path, got '$DATA_DIR'" >&2; exit 1 ;;
  esac
  DATA_DIR="$(realpath -m "$DATA_DIR")"
  case "$DATA_DIR" in
    /|/app|/app/*) echo "entrypoint: DATA_DIR resolves to '$DATA_DIR', which is not a safe data directory" >&2; exit 1 ;;
  esac
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

#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  # DATA_DIR is a user-configurable env var that we're about to recursively
  # chown as root. Refuse the unset/root-path cases so a misconfigured
  # override (e.g. DATA_DIR left empty, or set to "/") can't turn this into
  # a recursive chown of the whole container filesystem, which would also
  # silently defeat the /app read-only guarantee below.
  case "$DATA_DIR" in
    /) echo "entrypoint: refusing to run with DATA_DIR set to '/' — this would chown the entire filesystem" >&2; exit 1 ;;
    /*) ;;
    *) echo "entrypoint: DATA_DIR must be an absolute path, got '$DATA_DIR'" >&2; exit 1 ;;
  esac
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

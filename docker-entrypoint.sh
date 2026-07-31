#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  # DATA_DIR is a user-configurable env var that we're about to recursively
  # chown as root, so it needs to be constrained to the one directory the
  # image actually promises this repair for, rather than blocklisting
  # individual dangerous values. Canonicalise first (realpath -m: components
  # don't need to exist yet, since DATA_DIR may not exist on a fresh mount)
  # so forms like "//", "/./", or "/config/../.." can't slip past a raw
  # string check, then require the resolved path to be /config or below it.
  # A misconfigured override (e.g. DATA_DIR=/etc) is refused outright rather
  # than being allowed to turn into a recursive chown of arbitrary container
  # paths.
  case "$DATA_DIR" in
    /*) ;;
    *) echo "entrypoint: DATA_DIR must be an absolute path, got '$DATA_DIR'" >&2; exit 1 ;;
  esac
  DATA_DIR="$(realpath -m "$DATA_DIR")"
  case "$DATA_DIR" in
    /config|/config/*) ;;
    *) echo "entrypoint: DATA_DIR resolves to '$DATA_DIR', which must be /config or a path below it" >&2; exit 1 ;;
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

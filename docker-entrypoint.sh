#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
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

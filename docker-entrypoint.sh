#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only chown entries that actually need it — DATA_DIR can hold a large
  # image cache/artwork backups, and most restarts touch nothing here.
  # Still walks the tree so nested mismatches are caught, not just the
  # top-level directory.
  # -h is required: without it, chown follows a symlink to its target, so a
  # symlink under DATA_DIR pointing outside it would let this root-run
  # repair change ownership of an arbitrary file elsewhere on the
  # filesystem.
  find "$DATA_DIR" \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
  exec gosu node "$@"
fi

exec "$@"

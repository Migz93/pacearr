#!/bin/sh
set -e

# Pin PATH to trusted system directories only. Without this, an env var
# override at container launch could shadow `id` or `gosu` with a binary
# from a writable mount, which matters here because everything below runs
# as root before privileges are dropped.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Resolved as its own assignment rather than inside the `if` test below:
# a command substitution's exit status doesn't propagate through `[ ]` to
# trigger `set -e`, so if `id -u` itself failed inside the condition, the
# comparison would just silently evaluate to "not root" and this script
# would fall through to running the app directly, without ever dropping to
# gosu node. As a plain assignment, a failing `id -u` aborts the script via
# set -e instead of being swallowed into a wrong answer.
current_uid="$(id -u)"

if [ "$current_uid" = "0" ]; then
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
  # Skip the recursive repair once it's already done, rather than walking
  # the whole tree unconditionally on every start. chown -R always chowns
  # the directory argument itself as part of the same operation, so
  # DATA_DIR only ends up node-owned after a full repair has completed —
  # that reliably distinguishes "never repaired" (a fresh bind mount, or an
  # existing directory from an old root-run container: the two cases this
  # fix actually needs to handle) from "already repaired" (every restart
  # after the first), without re-walking a potentially large image cache /
  # log / database tree on every start. It does not re-verify every nested
  # entry once the top level looks correct, so a file dropped into DATA_DIR
  # out-of-band as root after a prior successful repair (e.g. a manual
  # host-side copy) won't be caught until ownership is reset — that's an
  # app-level write failure on that one file, not a security gap, since
  # skipping this step never causes us to touch anything we otherwise
  # wouldn't have.
  current_data_dir_owner="$(stat -c '%u:%g' "$DATA_DIR")"
  node_ids="$(id -u node):$(id -g node)"
  if [ "$current_data_dir_owner" != "$node_ids" ]; then
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
    # -P (GNU's default for -R, spelled out here rather than relied on) means
    # a directory symlink is re-owned like any other entry but never walked
    # into — reinforcing that -h can't be defeated by nesting the escape one
    # level deeper via a symlinked subdirectory.
    chown -R -P -h node:node "$DATA_DIR"
  fi
  exec gosu node "$@"
fi

exec "$@"

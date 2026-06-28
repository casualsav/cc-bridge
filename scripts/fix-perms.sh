#!/usr/bin/env bash
# Renormalize this repo's permissions so every account sharing it can read, edit, commit, and
# push without tripping over owner-only files.
#
# Why this exists: when several accounts share the checkout they're in a common group and the repo
# is group-owned by it, with setgid dirs + `git config core.sharedRepository=group` + umask 002 — so
# normal file creation is already group-writable (664). The thing that breaks it is a session that
# *explicitly* chmods tracked files to restrictive modes (600/444/464); those then can't be read or
# overwritten by the others, and `bun run deploy`'s file copy aborts on the unreadable ones.
#
# This script re-establishes the invariant: dirs = setgid + group-writable, files = group-rw +
# world-r, execute bits preserved, group set to the shared group. Idempotent — safe to re-run.
#
#   sudo bash scripts/fix-perms.sh        # run from anywhere; resolves the repo from its own path
#
# It needs sudo only because it touches files another account owns; ownership itself is left alone
# (the shared group + group perms are what grant access, not the owner).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GROUP="${TG_REPO_GROUP:-$(stat -c %G "$REPO")}"   # the repo's shared group; override via TG_REPO_GROUP

cd "$REPO"
echo "Normalizing $REPO (shared group: $GROUP)…"

# Shared group everywhere so group perms actually grant cross-user access.
chgrp -R "$GROUP" .

# Dirs: setgid (so new files inherit the group) + group-writable + traversable.
find . -type d -exec chmod 2775 {} +

# Files: owner rw, group rw, world r — without disturbing execute bits (scripts/bin stay runnable).
find . -type f -exec chmod ug+rw,o+r {} +

# Git's own writes (loose objects, index, refs) stay group-writable. Tolerate git's
# dubious-ownership guard when this runs under sudo (root) on a user-owned .git — the setting
# persists in .git/config regardless of who sets it, and it's almost always already in place.
git -c safe.directory="$REPO" config core.sharedRepository group 2>/dev/null \
  || echo "  (skipped git config — ensure core.sharedRepository=group stays set)"

echo "Done. No owner-only files remain; every account in the group can read/edit/commit/push."

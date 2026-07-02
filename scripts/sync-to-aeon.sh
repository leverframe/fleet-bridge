#!/usr/bin/env bash
# Build agents.json from live OpenClaw configs and push to AEON.
# Usage: sync-to-aeon.sh [aeon-ssh-alias]
# Default alias: aeon (configure in ~/.ssh/config or pass explicit host).
#
# Idempotent: if AEON's deployed agents.json already matches the build, no scp happens.
set -euo pipefail

AEON_HOST="${1:-aeon}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_NEW="$(mktemp)"
TMP_OLD="$(mktemp)"
trap 'rm -f "$TMP_NEW" "$TMP_OLD"' EXIT

# Build fresh
bash "$DIR/build-agents.json.sh" "$TMP_NEW" >&2

AEON_PATH="/c/Users/jrnew/.claude/mcp-servers/fleet-bridge/agents.json"

# Fetch current deployed for comparison (if present)
if ssh "$AEON_HOST" "test -f '$AEON_PATH'" 2>/dev/null; then
  scp -q "$AEON_HOST:$AEON_PATH" "$TMP_OLD" 2>/dev/null || true
  # Compare normalized (ignore key ordering)
  if diff -q \
      <(jq -S '.agents | sort_by(.name)' "$TMP_NEW") \
      <(jq -S '.agents | sort_by(.name)' "$TMP_OLD") >/dev/null 2>&1; then
    echo "already in sync (no changes)"
    exit 0
  fi
fi

# Stage atomically — scp to .new then mv on remote
scp -q "$TMP_NEW" "$AEON_HOST:$AEON_PATH.new"
ssh "$AEON_HOST" "mv '$AEON_PATH.new' '$AEON_PATH' && chmod 600 '$AEON_PATH'"
echo "synced to $AEON_HOST:$AEON_PATH"
echo ""
echo "NOTE: ZCode and Claude Code cache agents.json at process start."
echo "      Restart them to pick up token changes."

#!/usr/bin/env bash
# Pull a fresh agents.json from userve1 (source of truth) to this machine.
# Runs ON AEON (or any machine that can SSH to userve1). This direction is used
# because userve1 → AEON SSH has a Windows OpenSSH MAC compatibility bug.
#
# Usage: sync-to-aeon.sh [userve1-ssh-alias]
# Default alias: userve1 (configure in ~/.ssh/config or pass explicit host).
#
# Idempotent: skips scp if local agents.json already matches the build.
set -euo pipefail

USERVE1="${1:-userve1}"
SELF="${BASH_SOURCE[0]:-$0}"
DIR="$(cd "$(dirname "$(readlink -f "$SELF")")" && pwd)"

LOCAL_PATH="${FLEET_BRIDGE_AGENTS:-$HOME/.claude/mcp-servers/fleet-bridge/agents.json}"
TMP_NEW="$(mktemp)"
TMP_OLD="$(mktemp)"
trap 'rm -f "$TMP_NEW" "$TMP_OLD"' EXIT

# Build on userve1 (reads live OpenClaw configs as source of truth)
ssh "$USERVE1" "bash /opt/fleet-bridge-ops/scripts/build-agents.json.sh /tmp/agents-$$.json && cat /tmp/agents-$$.json && rm /tmp/agents-$$.json" > "$TMP_NEW"

# Compare against current deployed
if [ -f "$LOCAL_PATH" ]; then
  if diff -q \
      <(jq -S '.agents | sort_by(.name)' "$TMP_NEW") \
      <(jq -S '.agents | sort_by(.name)' "$LOCAL_PATH") >/dev/null 2>&1; then
    echo "already in sync (no changes)"
    exit 0
  fi
fi

# Atomic install
mkdir -p "$(dirname "$LOCAL_PATH")"
install -m 600 "$TMP_NEW" "$LOCAL_PATH"
echo "synced to $LOCAL_PATH"
echo ""
echo "NOTE: ZCode and Claude Code cache agents.json at process start."
echo "      Restart them to pick up token changes."

#!/usr/bin/env bash
# INTERNAL fleet ops script — not required for using fleet-bridge; kept for
# the maintainer's deployment. Pulls a freshly built agents.json from an ops
# host (where the OpenClaw configs live) to the machine running the bridge.
#
# Usage: sync-to-aeon.sh <ssh-alias-of-ops-host>
# Configure the alias in ~/.ssh/config or pass an explicit host.
#
# Idempotent: skips scp if local agents.json already matches the build.
set -euo pipefail

REMOTE="${1:?usage: sync-to-aeon.sh <ssh-alias-of-ops-host>}"
SELF="${BASH_SOURCE[0]:-$0}"
DIR="$(cd "$(dirname "$(readlink -f "$SELF")")" && pwd)"

LOCAL_PATH="${FLEET_BRIDGE_AGENTS:-$HOME/.claude/mcp-servers/fleet-bridge/agents.json}"
TMP_NEW="$(mktemp)"
TMP_OLD="$(mktemp)"
trap 'rm -f "$TMP_NEW" "$TMP_OLD"' EXIT

# Build on the ops host (reads live OpenClaw configs as source of truth)
OPS_DIR="${FLEET_BRIDGE_OPS_DIR:-/opt/fleet-bridge-ops}"
ssh "$REMOTE" "bash $OPS_DIR/scripts/build-agents.json.sh /tmp/agents-$$.json && cat /tmp/agents-$$.json && rm /tmp/agents-$$.json" > "$TMP_NEW"

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
echo "NOTE: MCP clients cache agents.json at process start."
echo "      Restart them to pick up token changes."

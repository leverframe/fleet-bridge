#!/usr/bin/env bash
# Compare local agents.json (on this machine) against expected built from userve1.
# Runs ON AEON (or any machine that can SSH to userve1). Alerts via notify.sh on
# userve2 if drift detected. Debounced 1hr per alert type.
#
# Designed for hourly cron on AEON. Exit codes:
#   0 = no drift (or debounced)
#   1 = drift detected + alert sent
#   2 = couldn't build expected or read local
set -euo pipefail

USERVE1="${1:-userve1}"
SELF="${BASH_SOURCE[0]:-$0}"
DIR="$(cd "$(dirname "$(readlink -f "$SELF")")" && pwd)"
STATE_DIR="${FLEET_DRIFT_STATE:-$HOME/.fleet-bridge-drift}"
DEBOUNCE_SECS=3600

mkdir -p "$STATE_DIR" 2>/dev/null || true

LOCAL_PATH="${FLEET_BRIDGE_AGENTS:-$HOME/.claude/mcp-servers/fleet-bridge/agents.json}"
EXPECTED="$(mktemp)"
trap 'rm -f "$EXPECTED"' EXIT

# Build expected by SSH'ing to userve1
if ! ssh "$USERVE1" "bash /opt/fleet-bridge-ops/scripts/build-agents.json.sh /tmp/agents-$$.json && cat /tmp/agents-$$.json && rm /tmp/agents-$$.json" > "$EXPECTED" 2>/dev/null; then
  echo "ERROR: couldn't build expected via $USERVE1" >&2
  exit 2
fi

if [ ! -f "$LOCAL_PATH" ]; then
  echo "ERROR: local $LOCAL_PATH missing" >&2
  exit 2
fi

# Compare name + port + token only (role/tier are decorative)
if diff -q \
    <(jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$EXPECTED") \
    <(jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$LOCAL_PATH") >/dev/null; then
  # Clear debounce on clean state
  rm -f "$STATE_DIR/last-alert" 2>/dev/null || true
  echo "OK: no drift"
  exit 0
fi

# Drift detected — check debounce
if [ -f "$STATE_DIR/last-alert" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$STATE_DIR/last-alert" 2>/dev/null || echo 0) ))
  if [ "$AGE" -lt "$DEBOUNCE_SECS" ]; then
    echo "drift detected but debounced (${AGE}s since last alert)"
    exit 0
  fi
fi
touch "$STATE_DIR/last-alert"

# Show drift
echo "DRIFT DETECTED:"
diff -u \
  <(jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$LOCAL_PATH") \
  <(jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$EXPECTED") | head -50 || true

# Alert via notify.sh on userve2
MSG="fleet-bridge token drift: local agents.json doesn't match userve1 configs. Run: bash ~/.claude/mcp-servers/fleet-bridge/scripts/sync-to-aeon.sh"
if ssh newell@100.115.150.19 "notify.sh --channel infra-alerts '$MSG'" 2>/dev/null; then
  echo "alert sent via notify.sh"
else
  echo "WARN: notify.sh unreachable, drift details logged above" >&2
fi

exit 1

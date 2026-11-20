#!/usr/bin/env bash
# INTERNAL fleet ops script — not required for using fleet-bridge; kept for
# the maintainer's deployment. Compares the local agents.json against one
# freshly built on an ops host (where the OpenClaw configs live), with a
# 1hr debounce. Designed for hourly cron on the machine running the bridge.
#
# Exit codes:
#   0 = no drift (or debounced)
#   1 = drift detected (alert hook runs, if configured)
#   2 = couldn't build expected or read local
set -euo pipefail

REMOTE="${1:?usage: drift-check.sh <ssh-alias-of-ops-host>}"
SELF="${BASH_SOURCE[0]:-$0}"
DIR="$(cd "$(dirname "$(readlink -f "$SELF")")" && pwd)"
STATE_DIR="${FLEET_DRIFT_STATE:-$HOME/.fleet-bridge-drift}"
DEBOUNCE_SECS=3600

mkdir -p "$STATE_DIR" 2>/dev/null || true

LOCAL_PATH="${FLEET_BRIDGE_AGENTS:-$HOME/.claude/mcp-servers/fleet-bridge/agents.json}"
EXPECTED="$(mktemp)"
trap 'rm -f "$EXPECTED"' EXIT

# Build expected by SSH'ing to the ops host
OPS_DIR="${FLEET_BRIDGE_OPS_DIR:-/opt/fleet-bridge-ops}"
if ! ssh "$REMOTE" "bash $OPS_DIR/scripts/build-agents.json.sh /tmp/agents-$$.json && cat /tmp/agents-$$.json && rm /tmp/agents-$$.json" > "$EXPECTED" 2>/dev/null; then
  echo "ERROR: couldn't build expected via $REMOTE" >&2
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

# Alert hook (optional): set ALERT_CMD to a shell command that takes the
# alert message as $1. The original fleet-specific notify.sh leg was removed.
MSG="fleet-bridge token drift: local agents.json doesn't match ops-host configs. Run: bash scripts/sync-to-aeon.sh"
if [ -n "${ALERT_CMD:-}" ]; then
  if "$ALERT_CMD" "$MSG"; then
    echo "alert sent"
  else
    echo "WARN: ALERT_CMD failed, drift details logged above" >&2
  fi
else
  echo "WARN: no ALERT_CMD configured, drift details logged above" >&2
fi

exit 1

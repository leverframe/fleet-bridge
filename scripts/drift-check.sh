#!/usr/bin/env bash
# Compare deployed agents.json on AEON against expected (built from live configs).
# Alerts via notify.sh on userve2 if drift detected. Debounced 1hr per alert type.
#
# Designed for hourly cron on userve1. Exit codes:
#   0 = no drift (or debounced)
#   1 = drift detected + alert sent
#   2 = couldn't fetch deployed (AEON down, agents.json missing)
set -euo pipefail

AEON_HOST="${1:-aeon}"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${FLEET_DRIFT_STATE:-/var/lib/fleet-bridge-drift}"
DEBOUNCE_SECS=3600

mkdir -p "$STATE_DIR" 2>/dev/null || true

EXPECTED="$(mktemp)"
DEPLOYED="$(mktemp)"
trap 'rm -f "$EXPECTED" "$DEPLOYED"' EXIT

# Build expected
bash "$DIR/build-agents.json.sh" "$EXPECTED" >&2

# Fetch deployed
AEON_PATH="/c/Users/jrnew/.claude/mcp-servers/fleet-bridge/agents.json"
if ! scp -q "$AEON_HOST:$AEON_PATH" "$DEPLOYED" 2>/dev/null; then
  echo "ERROR: couldn't fetch $AEON_HOST:$AEON_PATH" >&2
  exit 2
fi

# Compare name + port + token only (role/tier are decorative)
jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$EXPECTED" > "$EXPECTED.cmp"
jq -S '.agents | map({name, port, token}) | sort_by(.name)' "$DEPLOYED" > "$DEPLOYED.cmp"
trap 'rm -f "$EXPECTED" "$DEPLOYED" "$EXPECTED.cmp" "$DEPLOYED.cmp"' EXIT

if diff -q "$EXPECTED.cmp" "$DEPLOYED.cmp" >/dev/null; then
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

# Show the actual drift
echo "DRIFT DETECTED:"
diff -u "$DEPLOYED.cmp" "$EXPECTED.cmp" | head -50 || true

# Alert via notify.sh on userve2 (where it lives per fleet convention)
MSG="fleet-bridge token drift: deployed agents.json on AEON doesn't match live OpenClaw configs. Run: ssh userve1 'bash /opt/fleet-bridge-ops/scripts/sync-to-aeon.sh aeon'"
if ssh newell@100.115.150.19 "notify.sh --channel infra-alerts '$MSG'" 2>/dev/null; then
  echo "alert sent via notify.sh"
else
  echo "WARN: notify.sh unreachable, message only logged above" >&2
  echo "$MSG" >&2
fi

exit 1

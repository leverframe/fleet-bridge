#!/usr/bin/env bash
# Build agents.json for fleet-bridge from the OpenClaw configs on this box.
# Scans $HOME/.openclaw-<name>/openclaw.json for every agent found and extracts
# its gateway port + auth token — no agents or tokens hardcoded here.
# Output: $1 (default: /tmp/agents.json)
set -euo pipefail

OUTPUT="${1:-/tmp/agents.json}"
HOST="${FLEET_HOST:-127.0.0.1}"

shopt -s nullglob
MISSING=()
(
  for cfg in "$HOME"/.openclaw-*/openclaw.json; do
    a="$(basename "$(dirname "$cfg")")"
    a="${a#.openclaw-}"
    if [ ! -r "$cfg" ]; then
      MISSING+=("$a")
      continue
    fi
    port=$(jq -r '.gateway.port' "$cfg")
    token=$(jq -r '.gateway.auth.token' "$cfg")
    role=$(jq -r '.gateway.role // "agent"' "$cfg")
    tier=$(jq -r '.gateway.tier // ""' "$cfg")
    jq -n \
      --arg n "$a" \
      --arg r "$role" \
      --arg t "$tier" \
      --argjson p "$port" \
      --arg h "$HOST" \
      --arg tok "$token" \
      '{name:$n, role:$r, tier:$t, port:$p, host:$h, token:$tok}'
  done | jq -s '{agents: .}'
) > "$OUTPUT"

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "WARN: missing/unreadable configs for: ${MISSING[*]}" >&2
fi

echo "wrote $OUTPUT ($(jq '.agents | length' "$OUTPUT") agents)" >&2

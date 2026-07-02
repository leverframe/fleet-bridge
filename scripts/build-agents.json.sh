#!/usr/bin/env bash
# Build agents.json for fleet-bridge from live OpenClaw configs on userve1.
# Tokens read from /home/newell/.openclaw-<name>/openclaw.json — no tokens hardcoded here.
# Output: $1 (default: /tmp/agents.json)
set -euo pipefail

OUTPUT="${1:-/tmp/agents.json}"

declare -A ROLES=(
  [ada]="Tech Writer & Docs"        [andy]="Content & Social"
  [angela]="Full-Stack Dev"         [cameron]="Senior Builder"
  [cj]="Data Engineer"              [clifford]="Fleet Generalist"
  [darlene]="DevOps Lead"           [donna]="QA/Test Engineer"
  [jessica]="Ops Manager"           [kate]="Frontend Specialist"
  [lucy]="Head of Dev"              [peggy]="Exec Assistant / Discord Manager"
  [scully]="SRE/Reliability"        [shield]="Security Specialist (Trinity)"
  [wendy]="Performance Coach"
)
declare -A TIERS=(
  [ada]="4.7"      [andy]="4.7"     [angela]="4.7"   [cameron]="5-turbo"
  [cj]="4.7"       [clifford]="air" [darlene]="5-turbo" [donna]="4.7"
  [jessica]="4.7"  [kate]="5-turbo" [lucy]="4.7"     [peggy]="air"
  [scully]="5-turbo" [shield]="4.7" [wendy]="4.7"
)
HOST="${FLEET_HOST:-100.116.218.123}"
AGENTS_LIST="ada andy angela cameron cj clifford darlene donna jessica kate lucy peggy scully shield wendy"

MISSING=()
(
  for a in $AGENTS_LIST; do
    cfg="$HOME/.openclaw-$a/openclaw.json"
    if [ ! -r "$cfg" ]; then
      MISSING+=("$a")
      continue
    fi
    port=$(jq -r .gateway.port "$cfg")
    token=$(jq -r .gateway.auth.token "$cfg")
    jq -n \
      --arg n "$a" \
      --arg r "${ROLES[$a]}" \
      --arg t "${TIERS[$a]}" \
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

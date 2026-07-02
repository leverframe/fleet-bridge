# fleet-bridge

MCP server that exposes Jordan's OpenClaw fleet agents as tools for ZCode and Claude Code. v0.2.0 — streaming + git-tracked + token-sync scripts.

## What it does

Three tools over stdio MCP:

- `list_agents()` → array of `{name, role, tier, host, port}` (no tokens in output)
- `agent_health({name})` → calls `/health` on the agent, returns JSON
- `invoke_agent({name, prompt, timeout_ms?})` → streams via OpenAI SSE internally, emits `notifications/progress` if client passes `_meta.progressToken`, returns assistant reply text

## Agent coverage: all 15 (Stage A + B shipped 2026-07-02)

| Name | Role | Port | Tier |
|---|---|---|---|
| darlene | DevOps Lead | 18789 | 5-turbo |
| kate | Frontend Specialist | 18790 | 5-turbo |
| scully | SRE/Reliability | 18791 | 5-turbo |
| donna | QA/Test Engineer | 18792 | 4.7 |
| angela | Full-Stack Dev | 18793 | 4.7 |
| cameron | Senior Builder | 18794 | 5-turbo |
| shield (Trinity) | Security Specialist | 18795 | 4.7 |
| lucy | Head of Dev | 18796 | 4.7 |
| cj | Data Engineer | 18797 | 4.7 |
| andy | Content & Social | 18798 | 4.7 |
| jessica | Ops Manager | 18799 | 4.7 |
| peggy | Exec Assistant / Discord Manager | 18800 | air |
| wendy | Performance Coach | 18801 | 4.7 |
| clifford | Fleet Generalist | 18802 | air |
| ada | Tech Writer & Docs | 18803 | 4.7 |

## Files

- `index.ts` — TypeScript source (v0.2.0: SSE streaming + progress notifications)
- `dist/index.js` — compiled output (gitignored)
- `agents.json` — agent registry with tokens (`chmod 600`, **gitignored**)
- `package.json` / `tsconfig.json` — Node + TS config
- `scripts/` — sync/drift scripts (run on userve1)
- `.gitignore` — protects secrets

## Development

```bash
cd ~/.claude/mcp-servers/fleet-bridge
npm install
npm run build          # recompile after editing index.ts
```

Smoke test (no ZCode/CC needed):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"name":"donna","prompt":"reply with exactly: pong"}}}' \
  | node dist/index.js
```

For streaming test (with progress notifications):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"name":"donna","prompt":"count to 10"},"_meta":{"progressToken":"t1"}}}' \
  | node dist/index.js
```

Expect multiple `notifications/progress` messages before the final `tools/call` result.

## agents.json management (operators)

`agents.json` is the runtime artifact — never commit it. Tokens are pulled from live OpenClaw configs by the build script.

**Build locally on userve1:**
```bash
bash scripts/build-agents.json.sh /tmp/agents.json
```

**Sync to AEON (idempotent):**
```bash
bash scripts/sync-to-aeon.sh aeon
```

**Drift check (cron-friendly):**
```bash
bash scripts/drift-check.sh aeon
# exit 0 = no drift, 1 = drift + alert sent, 2 = fetch failed
```

## Adding a new agent

1. Set up the OpenClaw agent on userve1 (port assigned, chatCompletions enabled in config, bind = tailnet).
2. Restart the agent to pick up the new config: `sudo systemctl restart openclaw-<name>`.
3. Add name + role + tier to `scripts/build-agents.json.sh` (the `ROLES` and `TIERS` associative arrays).
4. Commit + push.
5. On userve1: `cd /opt/fleet-bridge-ops && git pull && bash scripts/sync-to-aeon.sh aeon`.
6. Restart ZCode/CC.

## Token rotation flow

1. Rotate one agent's token on userve1:
   ```bash
   sudo jq '.gateway.auth.token = "NEW_TOKEN"' /home/newell/.openclaw-<name>/openclaw.json > /tmp/x
   sudo install -m 600 -o newell -g newell /tmp/x /home/newell/.openclaw-<name>/openclaw.json
   sudo systemctl restart openclaw-<name>
   ```
2. Run sync: `bash /opt/fleet-bridge-ops/scripts/sync-to-aeon.sh aeon`
3. Restart ZCode/CC.

The hourly drift-check cron will catch rotation events you forget to sync.

## Operator notes

- **Streaming**: invokes use `stream: true` internally for fast perceived feedback. Progress notifications only emit when client passes `_meta.progressToken`. ZCode/CC client support for progress notifications is implementation-dependent — verify in your client.
- **Timeout**: default 60s. Override per-call with `timeout_ms`. Long deploys (Darlene, Cameron) may need 120s+.
- **Backward compat**: clients without progressToken get the same final result, just no intermediate updates.
- **Debug**: agent-side: `journalctl -u openclaw-<name> -f` on userve1. Bridge-side: run smoke test above.

## Why "shield" not "trinity"

OpenClaw uses `shield` as the system identifier (profile dir, service name, port assignment) even though the user-facing name is "Trinity". The bridge uses `shield` for consistency with the underlying system.

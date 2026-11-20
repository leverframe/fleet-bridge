# fleet-bridge

MCP server that bridges OpenClaw gateway agents and Hermes agents to any MCP client. v0.3.0 — sessions + Hermes integration.

## What it does

Six tools over stdio MCP:

- `list_agents()` → array of OpenClaw agents with `{name, role, tier, host, port}` (no tokens in output)
- `agent_health({name})` → calls `/health` on the agent gateway, returns JSON
- `start_session({agent?})` → returns `{session_key}` for multi-turn conversations
- `invoke_agent({name, prompt, timeout_ms?, session_key?})` → streams via OpenAI SSE internally; emits `notifications/progress` if client passes `_meta.progressToken`. Pass `session_key` for multi-turn.
- `list_hermes_agents()` → array of Hermes agents with `{name, role, model, host}`
- `invoke_hermes({name, prompt, timeout_ms?})` → SSH-spawns `hermes -z "<prompt>"` on the agent's host. Always stateless.

## v0.3.0 highlights

- **Sessions**: pass `session_key` (from `start_session`) to `invoke_agent` for multi-turn. The agent gateway persists conversation state server-side under the key. Stateless when absent — full backward compat.
- **Hermes integration**: invoke Hermes agents (a different runtime — SSH + `hermes` CLI transport) through the same tool surface as OpenClaw agents.
- Five tools before, six now.

## Configuration

The bridge is file-driven at startup. It reads two roster files (both `chmod 600`, **gitignored** — never commit them, they contain tokens/SSH details):

- `agents.json` — OpenClaw agents: `{"agents": [{"name", "role", "tier", "port", "host", "token"}]}`
- `hermes-agents.json` — Hermes agents: `{"agents": [{"name", "role", "model", "host", "ssh_user", "binary"}]}`

Paths default to the repo root; override with `FLEET_BRIDGE_AGENTS` / `FLEET_BRIDGE_HERMES`. Both fall back to an empty roster if missing — tools will report `unknown agent` until you provide a roster.

Build `agents.json` from the live OpenClaw configs on the box running your agents (requires `jq`):

```bash
bash scripts/build-agents.json.sh /tmp/agents.json
```

The script scans `$HOME/.openclaw-*/openclaw.json` and extracts each agent's port and token. Set `FLEET_HOST` if the agents are reachable on a host other than the default (`127.0.0.1`). Copy the output to `agents.json` (or point `FLEET_BRIDGE_AGENTS` at it).

## Files

- `index.ts` — TypeScript source
- `dist/index.js` — compiled output (gitignored)
- `agents.json` — OpenClaw agent registry with tokens (`chmod 600`, **gitignored**)
- `hermes-agents.json` — Hermes agent registry with SSH targets (`chmod 600`, **gitignored**)
- `package.json` / `tsconfig.json` — Node + TS config
- `scripts/` — roster build + internal fleet ops scripts (see below)
- `.gitignore` — protects secrets

## Development

```bash
npm install
npm run build          # recompile after editing index.ts
```

Smoke test (no MCP client needed) — substitute an agent name from your roster:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"name":"my-agent","prompt":"reply with exactly: pong"}}}' \
  | node dist/index.js
```

For streaming test (with progress notifications):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"name":"my-agent","prompt":"count to 10"},"_meta":{"progressToken":"t1"}}}' \
  | node dist/index.js
```

Expect multiple `notifications/progress` messages before the final `tools/call` result.

## agents.json management (operators)

`agents.json` is a runtime artifact — never commit it. Tokens are pulled from live OpenClaw configs by the build script.

**Build locally on the box running your OpenClaw agents:**
```bash
bash scripts/build-agents.json.sh /tmp/agents.json
```

`scripts/sync-to-aeon.sh` and `scripts/drift-check.sh` are **internal fleet ops scripts** — not required for using fleet-bridge. They are kept for the maintainer's deployment (pull-sync the roster from an ops host; cron-friendly drift detection with debounced alerts). Adapt them to your own deployment if useful.

## Adding a new agent

1. Set up the OpenClaw agent (port assigned, chatCompletions enabled in its config) and restart its service to pick up the config.
2. Re-run `scripts/build-agents.json.sh` — it auto-discovers agents from `$HOME/.openclaw-*/openclaw.json`.
3. Deploy the refreshed roster (`agents.json` or `FLEET_BRIDGE_AGENTS`) and restart your MCP client.

## Token rotation flow

1. Rotate the token in the agent's `$HOME/.openclaw-<name>/openclaw.json` and restart that agent's service.
2. Re-run the build script and deploy the refreshed roster.
3. Restart your MCP client.

If you deploy the drift-check script, it will catch rotation events you forget to sync.

## Operator notes

- **Streaming**: invokes use `stream: true` internally for fast perceived feedback. Progress notifications only emit when client passes `_meta.progressToken`. Client support for progress notifications is implementation-dependent — verify in your client.
- **Timeout**: default 60s. Override per-call with `timeout_ms`. Long-running tasks may need 120s+.
- **Transport security**: agent traffic is plain `http://`. Run the bridge on a trusted network (loopback, LAN, or a private overlay) — do not expose agent gateways to the public internet.
- **Backward compat**: clients without progressToken get the same final result, just no intermediate updates.
- **Debug**: agent-side: `journalctl` on the agent host (OpenClaw systemd units log there). Bridge-side: run the smoke test above.

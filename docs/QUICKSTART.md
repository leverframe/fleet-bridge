# Quickstart

Zero to a working bridge in five minutes: build, point at one agent,
wire it into any stdio MCP client, smoke test.

## Prereqs

- Node >= 22 (current LTS). The repo pins no `engines` field; the MCP
  SDK floor is Node >= 18, but run a current LTS.
- One of:
  - an **OpenClaw agent** with its gateway enabled (HTTP, `port` +
    auth token in its config), or
  - a **Hermes CLI** install on a host you can SSH to with key-based
    auth (no password prompts).
- An MCP client that supports stdio servers (Claude Code, Zed, etc.).

## Install & build

```bash
git clone <repo-url> fleet-bridge
cd fleet-bridge
npm ci        # or: npm install
npm run build # emits dist/index.js
```

## Configure

Create `agents.json` in the repo root (or anywhere, via
`FLEET_BRIDGE_AGENTS`) with one agent:

```json
{
  "agents": [
    {
      "name": "researcher",
      "role": "Research Analyst",
      "tier": "pro",
      "model": "openclaw",
      "port": 18800,
      "host": "127.0.0.1",
      "token": "REPLACE_WITH_GATEWAY_TOKEN"
    }
  ]
}
```

Fields:

- `name` — unique handle clients pass to tools.
- `role` — free text, shown in `list_agents` output.
- `tier` — optional metadata, passed through unused.
- `model` — optional; defaults to `openclaw`, which OpenClaw gateways expect. Set a real model name to target any OpenAI-compatible gateway.
- `port` — gateway port (`/health` and `/v1/chat/completions` are called there).
- `host` — gateway IP or hostname.
- `token` — gateway auth token, sent as `Authorization: Bearer`.

**Tokens are secrets.** `chmod 600 agents.json`, never commit it (it
is gitignored by default), never paste the token into examples or
issues. `list_agents` strips tokens from its output.

Hermes instead (or additionally): create `hermes-agents.json` the same
way — copy `hermes-agents.example.json`, fill in your host, SSH user,
and the absolute path to the `hermes` binary on that host. Key-based
SSH must already work. Same hygiene: `chmod 600`, never commit.

**Rosters load once at startup.** Edit a roster → restart the bridge
(or restart your MCP client, which restarts the bridge). No hot reload.

## Wire into your MCP client

The bridge is a stdio MCP server. Point your client at it:

```json
{
  "mcpServers": {
    "fleet-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/fleet-bridge/dist/index.js"]
    }
  }
}
```

Set env vars on the server entry if your rosters live outside the repo:

```json
{
  "mcpServers": {
    "fleet-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/fleet-bridge/dist/index.js"],
      "env": {
        "FLEET_BRIDGE_AGENTS": "/absolute/path/to/agents.json",
        "FLEET_BRIDGE_HERMES": "/absolute/path/to/hermes-agents.json"
      }
    }
  }
}
```

Claude Code, Zed, and most MCP clients use this same stdio shape
(`command` + `args` + optional `env`) — check your client's MCP config
docs for where the block lives.

## Smoke test

No client needed — drive the stdio protocol directly. Substitute your
agent's `name` for `researcher`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"invoke_agent","arguments":{"name":"researcher","prompt":"reply with exactly: pong"}}}' \
  | node dist/index.js
```

Expected:

- The first response line carries
  `"serverInfo":{"name":"fleet-bridge","version":"0.1.1"}`.
- `tools/list` returns six tools (`list_agents`, `agent_health`,
  `start_session`, `invoke_agent`, `list_hermes_agents`,
  `invoke_hermes`).
- The `tools/call` result contains your agent's reply (`pong`).

If you see `fleet-bridge error: unknown agent: researcher`, the roster
did not load — see Troubleshooting.

## Scale to twenty

The roster is flat: one array entry = one agent, same six fields each.
Add entries and restart — all agents appear via `list_agents`. Full
schema and field reference: [docs/CONFIG.md](CONFIG.md).

OpenClaw users can generate the roster instead of hand-writing it:

```bash
bash scripts/build-agents.json.sh /tmp/agents.json
```

The script auto-discovers `$HOME/.openclaw-*/openclaw.json` on the box
running your agents, extracts each gateway port + token (requires
`jq`), and writes the roster. Set `FLEET_HOST` if the agents are not on
`127.0.0.1`. Copy the output to `agents.json` or point
`FLEET_BRIDGE_AGENTS` at it, then restart.

## Troubleshooting

- **`unknown agent: <name>`** — roster path wrong or file
  unparseable; the bridge silently falls back to an empty roster and
  keeps running. Check the path your env var (or default repo root)
  points at, and that the JSON parses.
- **Bad roster fields fail late, not at load.** The loader does no
  validation — a missing `port`, `token`, or `binary` sails through
  startup and only errors (or fails silently) when you invoke that
  agent. Validate your roster by hand before the first invoke.
- **Connection refused** — the gateway `host:port` is wrong or the
  agent's gateway service is down. Check the port in the agent's
  OpenClaw config and that its service is running.
- **Invokes time out** — tune `FLEET_BRIDGE_INVOKE_TIMEOUT_MS`
  (default 60000) for slow agents, or pass per-call `timeout_ms`.
  Health checks: `FLEET_BRIDGE_HEALTH_TIMEOUT_MS` (default 5000).
  Non-numeric values fall back silently to defaults.
- **Plain http, by design** — the bridge speaks unencrypted `http://`
  to agent gateways. Run it on a trusted network (loopback, LAN, or
  private overlay); there is no TLS option.

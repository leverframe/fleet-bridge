# Configuration

fleet-bridge is configured entirely through two JSON roster files plus
environment variables. No CLI flags, no config wizard.

## Roster files

At startup the bridge reads two rosters:

| File                 | Contents                       | Path source                                                            |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `agents.json`        | OpenClaw agents (HTTP gateway) | `FLEET_BRIDGE_AGENTS` env var, default `<repoRoot>/agents.json`        |
| `hermes-agents.json` | Hermes agents (SSH + CLI)      | `FLEET_BRIDGE_HERMES` env var, default `<repoRoot>/hermes-agents.json` |

Both paths are absolute-or-relative as given; set the env vars to keep
rosters outside the repo entirely. Both files should be `chmod 600`.

**Rosters load once at startup.** Edit a roster → restart the bridge.

On a missing or unparseable roster file the bridge falls back to an
empty roster for that type and keeps running (all invoke tools return
`unknown agent` until a valid file is supplied).

### agents.json — OpenClaw agents

Top-level shape: `{"agents": [ ... ]}`. One array entry = one agent.

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
      "token": "<gateway auth token>"
    }
  ]
}
```

| Field   | Type   | Required | Notes                                                                                                                                                                                               |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`  | string | yes      | Unique. The value clients pass to `invoke_agent`, `agent_health`, `start_session`.                                                                                                                  |
| `role`  | string | yes      | Free text, shown in `list_agents` output.                                                                                                                                                           |
| `tier`  | string | no       | Your own model-tier metadata (e.g. `pro`, `free`). Passed through to `list_agents`; unused by the bridge.                                                                                           |
| `model` | string | no       | Model name sent in the chat-completions body. Defaults to `openclaw` when omitted, which is what OpenClaw gateways expect — point it at any OpenAI-compatible gateway by setting a real model name. |
| `port`  | number | yes      | Gateway port. The bridge calls `http://{host}:{port}/health` and `/v1/chat/completions`.                                                                                                            |
| `host`  | string | yes      | IP or hostname of the gateway.                                                                                                                                                                      |
| `token` | string | yes      | Gateway auth token, sent as `Authorization: Bearer {token}`.                                                                                                                                        |

**Tokens are secrets.** Never commit `agents.json`, never paste real
tokens into example files or issues. The file is gitignored by default;
if you relocate it via `FLEET_BRIDGE_AGENTS`, keep it out of any
synced/backed-up tree you don't control, and keep `chmod 600` on it.
Tokens never appear in tool output — `list_agents` strips the field
before returning the roster.

See `agents.example.json` in the repo root for a working skeleton.

### hermes-agents.json — Hermes agents

Top-level shape: same `{"agents": [ ... ]}` wrapper. One entry = one agent.

```json
{
  "agents": [
    {
      "name": "reviewer",
      "role": "Code Review",
      "model": "gemini-2.5-flash",
      "host": "127.0.0.1",
      "ssh_user": "deploy",
      "binary": "/usr/local/bin/hermes"
    }
  ]
}
```

| Field      | Type   | Required | Notes                                                                                                          |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `name`     | string | yes      | Unique. Passed to `invoke_hermes` / `list_hermes_agents`.                                                      |
| `role`     | string | yes      | Free text, shown in `list_hermes_agents` output.                                                               |
| `model`    | string | no       | Display metadata only; the bridge never reads it. Omit freely.                                                 |
| `host`     | string | yes      | Host the bridge SSHes into.                                                                                    |
| `ssh_user` | string | yes      | Remote SSH user. Key-based auth must already work (the bridge uses `BatchMode=yes` — no password prompts).     |
| `binary`   | string | yes      | Absolute path to the Hermes CLI on the remote host. Invoked as `ssh {ssh_user}@{host} {binary} -z '<prompt>'`. |

`ssh_user` and `binary` are stripped from `list_hermes_agents` output
(they leak your infra layout to anyone with client access). `model`
is displayed.

See `hermes-agents.example.json` for a working skeleton.

## Environment variables

| Variable                         | Status  | Default                         | Purpose                                                                                |
| -------------------------------- | ------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `FLEET_BRIDGE_AGENTS`            | shipped | `<repoRoot>/agents.json`        | Path to the OpenClaw roster.                                                           |
| `FLEET_BRIDGE_HERMES`            | shipped | `<repoRoot>/hermes-agents.json` | Path to the Hermes roster.                                                             |
| `FLEET_BRIDGE_HEALTH_TIMEOUT_MS` | shipped | 5000                            | Abort timeout for `agent_health` HTTP calls.                                           |
| `FLEET_BRIDGE_INVOKE_TIMEOUT_MS` | shipped | 60000                           | Default timeout for `invoke_agent` / `invoke_hermes` when the call omits `timeout_ms`. |

Non-numeric or non-positive values for the two `*_TIMEOUT_MS`
variables fall back silently to the default (no error at startup).
Per-call `timeout_ms` (tool argument) overrides the invoke default
when set.

## Scaling from one agent to twenty

The roster is flat: one array entry = one agent. There is no grouping,
no tiers of configuration, no per-agent config sections beyond the
fields above.

- **Agent 1:** add one entry to `agents.json`, point `host`/`port` at
  its gateway, restart the bridge. Done — six tools work against it.
- **Agent 20:** add nineteen more entries. Same fields, nothing else
  changes. All agents become visible to the client via `list_agents`
  immediately.

Practical notes at scale:

- Each `invoke_agent` call is an independent HTTP request to that
  agent's gateway; agents are invoked one at a time per tool call. No
  cross-agent coordination happens in the bridge.
- Use multi-turn sessions (`start_session` → `session_key`) instead of
  stuffing context into prompts; the gateway persists state server-side.
- Give slow agents a larger per-call `timeout_ms` rather than raising
  the global default.
- Duplicate `name` values: first match wins (`Array.find`), and the
  duplicate is unreachable. Keep names unique.

## Transport security

The bridge speaks plain `http://` to agent gateways. Run it on a
network you trust (loopback, LAN, or a private overlay network). There
is no TLS option in v0.1.

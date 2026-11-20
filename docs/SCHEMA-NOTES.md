# SCHEMA-NOTES.md — internal notes on the config surface

Notes for maintainers, not operators. Operator-facing reference:
`docs/CONFIG.md`. Written during the v0.1.0 extraction; facts as of
the pre-extraction source.

## Current implicit schema

The roster format has never been written down — it lives in two
TypeScript interfaces at the top of `index.ts`:

- `AgentEntry` — `{name, role, tier, port, host, token}` (`index.ts:13-20`)
- `HermesEntry` — `{name, role, model, host, ssh_user, binary}` (`index.ts:22-29`)

Both rosters load through a `loadJson` helper (`index.ts:40-46`) with a
bare `as T` cast: **there is no runtime validation.** A roster with a
missing or mistyped field does not error at load; it fails later (or
silently) at invoke time. Any schema loosening below therefore works
at runtime today without code changes — the interface is compile-time
documentation only.

Loader call sites: `index.ts:48-49`. Both fall back to `{agents: []}`
on any read/parse failure, and both are read once at module load — no
hot reload.

## The `{agents: [...]}` wrapper

Decided: **keep it.** Both loaders already expect it (`.agents` property
on the parsed object). A bare top-level array would be marginally
simpler but buys nothing, breaks every existing roster, and makes
future top-level metadata (defaults, schema version) harder. The
wrapper stays as the documented shape.

## Per-agent optional `model` for OpenClaw agents

Decided: **shipped in public v0.1.0.** `AgentEntry` carries an optional
`model` field; when absent, the chat-completions body sends
`model: "openclaw"` (preserves behavior for existing rosters).

- Rationale: the literal was an OpenClaw-gateway contract baked into
  code. A per-agent field lets operators point the bridge at any
  OpenAI-compatible gateway without touching source, and is consistent
  with `HermesEntry` already carrying `model`.
- Touch points as implemented: `AgentEntry` interface, the request body
  in `invokeAgentStreamed`, `list_agents` output (strips only
  `token`), `docs/CONFIG.md` schema table, `agents.example.json`.

## Optional `tier` on AgentEntry

`tier` is load-bearing nowhere in the bridge — it is pass-through
metadata surfaced by `list_agents`. It stays in the schema but is
documented as optional. No code change needed (no runtime validation).

## Env var knobs: health/invoke timeouts

Documented in `docs/CONFIG.md` as planned:

- `FLEET_BRIDGE_HEALTH_TIMEOUT_MS` (default 5000) — **shipped**: read at
  module load, overrides the hardcoded abort timeout in `agentHealth`.
- `FLEET_BRIDGE_INVOKE_TIMEOUT_MS` (default 60000) — **shipped**: read at
  module load and used as the default when an invoke call omits
  `timeout_ms`; surfaced in both invoke tool descriptions.

Non-numeric or non-positive values fall back silently to the default.

## Internal ops scripts DROPPED from public v0.1

Ruling (2026-11-19): **dropped from the public tree.** They live on in the
maintainer's private deployment; restoring later is trivial (git history keeps
them). They are fleet-topology-specific by design:

- a roster-sync script — copies a roster from one named machine to
  another over a fixed ssh-alias convention; direction and defaults are
  this fleet's topology.
- a drift-check script — hourly cron diff of roster vs live configs plus
  a debounced alert leg that SSHes to a second box to run a notify
  script. The alert leg is pure private infra and was already pointing
  at a decommissioned host pre-extraction.
- a private roster-generator variant (not to be confused with the
  generic `scripts/build-agents.json.sh` that DOES ship) read the
  `$HOME/.openclaw-<name>/openclaw.json` layout and embedded the full
  agent roster by name — same problem class.

A generic equivalent (any ssh source, any destination, any alert
command) is post-v0.1 work if there is demand. For v0.1, operators
maintain rosters by hand from the documented schema + example files;
the rosters are small JSON files and hand-maintenance is fine at
1-20 agents.

## Version string

The private line carried `0.3.0` in both spots (server metadata +
manifest). Public v0.1.0 restarts the version at `0.1.0`; both were
bumped, and `package-lock.json`'s root version was synced to match.

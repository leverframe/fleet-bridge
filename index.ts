import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

interface AgentEntry {
  name: string;
  role: string;
  tier: string;
  model?: string;
  port: number;
  host: string;
  token: string;
}

interface HermesEntry {
  name: string;
  role: string;
  model: string;
  host: string;
  ssh_user: string;
  binary: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const AGENTS_PATH = process.env.FLEET_BRIDGE_AGENTS
  ? process.env.FLEET_BRIDGE_AGENTS
  : join(REPO_ROOT, "agents.json");
const HERMES_PATH = process.env.FLEET_BRIDGE_HERMES
  ? process.env.FLEET_BRIDGE_HERMES
  : join(REPO_ROOT, "hermes-agents.json");

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const AGENTS: AgentEntry[] = loadJson<{ agents: AgentEntry[] }>(AGENTS_PATH, {
  agents: [],
}).agents;
const HERMES: HermesEntry[] = loadJson<{ agents: HermesEntry[] }>(HERMES_PATH, {
  agents: [],
}).agents;

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HEALTH_TIMEOUT_MS = parseTimeoutMs(
  process.env.FLEET_BRIDGE_HEALTH_TIMEOUT_MS,
  5000,
);
const INVOKE_TIMEOUT_MS = parseTimeoutMs(
  process.env.FLEET_BRIDGE_INVOKE_TIMEOUT_MS,
  60000,
);

function findAgent(name: string): AgentEntry | undefined {
  return AGENTS.find((a) => a.name === name);
}

function findHermes(name: string): HermesEntry | undefined {
  return HERMES.find((a) => a.name === name);
}

async function agentHealth(a: AgentEntry): Promise<object> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const r = await fetch(`http://${a.host}:${a.port}/health`, {
      signal: ctrl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

interface ProgressEmitter {
  sendProgress(progress: number, total: number, message: string): Promise<void>;
}

function makeProgressEmitter(extra: any): ProgressEmitter | null {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return null;
  const send = extra?.sendNotification as
    | ((n: { method: string; params: object }) => Promise<void>)
    | undefined;
  if (!send) return null;
  return {
    async sendProgress(progress, total, message) {
      try {
        await send({
          method: "notifications/progress",
          params: { progressToken: token, progress, total, message },
        });
      } catch {
        // Client may have disconnected; ignore.
      }
    },
  };
}

async function invokeAgentStreamed(
  a: AgentEntry,
  prompt: string,
  timeoutMs: number,
  sessionKey: string | null,
  progress: ProgressEmitter | null,
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  if (progress) {
    await progress.sendProgress(0, -1, `Connecting to ${a.name}...`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${a.token}`,
  };
  if (sessionKey) {
    headers["x-openclaw-session-key"] = sessionKey;
  }

  const r = await fetch(`http://${a.host}:${a.port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      model: a.model ?? "openclaw",
      stream: true,
    }),
    signal: ctrl.signal,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} from ${a.name}: ${body.slice(0, 200)}`);
  }
  if (!r.body) {
    const json: any = await r.json();
    const content: string | undefined = json?.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error(`unexpected response shape from ${a.name}`);
    }
    return content;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buf = "";
  let lastProgress = Date.now();
  const PROGRESS_INTERVAL_MS = 2000;
  const PROGRESS_EVERY_CHARS = 500;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          return accumulated;
        }
        try {
          const json = JSON.parse(data);
          const delta: string | undefined = json?.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
        } catch {
          // Partial JSON across chunk boundaries.
        }
      }

      if (progress) {
        const now = Date.now();
        const sinceTime = now - lastProgress >= PROGRESS_INTERVAL_MS;
        const sinceChars =
          accumulated.length > 0 &&
          accumulated.length % PROGRESS_EVERY_CHARS < 50;
        if (sinceTime || sinceChars) {
          await progress.sendProgress(
            accumulated.length,
            -1,
            `Generated ${accumulated.length} chars`,
          );
          lastProgress = now;
        }
      }
    }
  } finally {
    clearTimeout(t);
  }

  return accumulated;
}

async function invokeHermes(
  h: HermesEntry,
  prompt: string,
  timeoutMs: number,
  progress: ProgressEmitter | null,
): Promise<string> {
  if (progress) {
    await progress.sendProgress(0, -1, `Connecting to ${h.name} over SSH...`);
  }
  const sshTarget = `${h.ssh_user}@${h.host}`;
  // ssh concatenates argv[2..] into a single remote command string the remote
  // shell then parses. So a prompt with spaces needs to arrive on the remote
  // side wrapped in single quotes — wrap here, escape any embedded quotes.
  const shellEscaped = `'${prompt.replace(/'/g, `'\\''`)}'`;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    sshTarget,
    h.binary,
    "-z",
    shellEscaped,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms invoking ${h.name}`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (progress && stdout.length > 0 && stdout.length % 500 < 50) {
        progress
          .sendProgress(stdout.length, -1, `Generated ${stdout.length} chars`)
          .catch(() => {});
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`ssh spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${h.name} exited ${code}: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

const server = new Server(
  { name: "fleet-bridge", version: "0.1.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_agents",
      description:
        "List fleet agents reachable through this bridge. Returns name, role, tier, host, port for each.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "agent_health",
      description:
        "Check whether a specific fleet agent is healthy. Returns the agent gateway's /health JSON.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "start_session",
      description:
        "Generate a fresh session_key for multi-turn conversation with a fleet agent. Pass the returned key to subsequent invoke_agent calls to preserve context. Conversation state is persisted server-side by the agent gateway under this key.",
      inputSchema: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description:
              "Optional agent name to validate. The returned key works for any agent but pre-validation surfaces typos early.",
          },
        },
      },
    },
    {
      name: "invoke_agent",
      description:
        "Send a prompt to a fleet agent and return its reply. Streams internally; emits progress notifications if client passes _meta.progressToken. Pass session_key from start_session for multi-turn conversations.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Agent name (e.g. 'researcher')",
          },
          prompt: { type: "string", description: "User message to send" },
          timeout_ms: {
            type: "number",
            description: `Optional timeout in milliseconds (default ${INVOKE_TIMEOUT_MS})`,
          },
          session_key: {
            type: "string",
            description:
              "Optional session key from start_session for multi-turn. When absent, call is stateless.",
          },
        },
        required: ["name", "prompt"],
      },
    },
    {
      name: "list_hermes_agents",
      description:
        "List Hermes agents (different runtime than OpenClaw — invoked via SSH + hermes CLI). Returns name, role, model, host for each.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "invoke_hermes",
      description:
        "Send a one-shot prompt to a Hermes agent via SSH. Always stateless — Hermes -z mode does not preserve context across calls.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Hermes agent name (e.g. 'my-pm-agent')",
          },
          prompt: { type: "string", description: "User message to send" },
          timeout_ms: {
            type: "number",
            description: `Optional timeout in milliseconds (default ${INVOKE_TIMEOUT_MS})`,
          },
        },
        required: ["name", "prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "list_agents") {
      const visible = AGENTS.map(({ token: _t, ...rest }) => rest);
      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
      };
    }
    if (name === "agent_health") {
      const a = findAgent(String(args?.name ?? ""));
      if (!a) throw new Error(`unknown agent: ${args?.name}`);
      const result = await agentHealth(a);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }
    if (name === "start_session") {
      // Optional validation: surface typos early. The key itself is opaque
      // and works for any agent.
      const agentName = args?.agent ? String(args.agent) : null;
      if (agentName && !findAgent(agentName)) {
        throw new Error(`unknown agent: ${agentName}`);
      }
      const session_key = randomUUID();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ session_key }),
          },
        ],
      };
    }
    if (name === "invoke_agent") {
      const a = findAgent(String(args?.name ?? ""));
      if (!a) throw new Error(`unknown agent: ${args?.name}`);
      const prompt = String(args?.prompt ?? "");
      const timeoutMs = Number(args?.timeout_ms ?? INVOKE_TIMEOUT_MS);
      const sessionKey = args?.session_key ? String(args.session_key) : null;
      const progress = makeProgressEmitter(extra);
      const reply = await invokeAgentStreamed(
        a,
        prompt,
        timeoutMs,
        sessionKey,
        progress,
      );
      return { content: [{ type: "text", text: reply }] };
    }
    if (name === "list_hermes_agents") {
      const visible = HERMES.map(
        ({ ssh_user: _u, binary: _b, ...rest }) => rest,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
      };
    }
    if (name === "invoke_hermes") {
      const h = findHermes(String(args?.name ?? ""));
      if (!h) throw new Error(`unknown hermes agent: ${args?.name}`);
      const prompt = String(args?.prompt ?? "");
      const timeoutMs = Number(args?.timeout_ms ?? INVOKE_TIMEOUT_MS);
      const progress = makeProgressEmitter(extra);
      const reply = await invokeHermes(h, prompt, timeoutMs, progress);
      return { content: [{ type: "text", text: reply }] };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `fleet-bridge error: ${msg}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

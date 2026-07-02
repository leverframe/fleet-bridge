import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface AgentEntry {
  name: string;
  role: string;
  tier: string;
  port: number;
  host: string;
  token: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = process.env.FLEET_BRIDGE_AGENTS
  ? process.env.FLEET_BRIDGE_AGENTS
  : join(__dirname, "..", "agents.json");

function loadAgents(): AgentEntry[] {
  const raw = readFileSync(AGENTS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { agents: AgentEntry[] };
  return parsed.agents;
}

const AGENTS = loadAgents();

function findAgent(name: string): AgentEntry | undefined {
  return AGENTS.find((a) => a.name === name);
}

async function agentHealth(a: AgentEntry): Promise<object> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
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
  const token = (extra as any)?._meta?.progressToken;
  if (token === undefined || token === null) return null;
  const send = (extra as any).sendNotification as
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
  progress: ProgressEmitter | null
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  if (progress) {
    await progress.sendProgress(0, -1, `Connecting to ${a.name}...`);
  }

  const r = await fetch(`http://${a.host}:${a.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${a.token}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      model: "openclaw",
      stream: true,
    }),
    signal: ctrl.signal,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} from ${a.name}: ${body.slice(0, 200)}`);
  }
  if (!r.body) {
    // Server didn't stream despite our request — fall back to JSON parse.
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
          // Partial JSON across chunk boundaries — wait for more data.
        }
      }

      if (progress) {
        const now = Date.now();
        const sinceTime = now - lastProgress >= PROGRESS_INTERVAL_MS;
        const sinceChars = accumulated.length > 0 && accumulated.length % PROGRESS_EVERY_CHARS < 50;
        if (sinceTime || sinceChars) {
          await progress.sendProgress(
            accumulated.length,
            -1,
            `Generated ${accumulated.length} chars`
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

const server = new Server(
  { name: "fleet-bridge", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_agents",
      description:
        "List OpenClaw fleet agents reachable through this bridge. Returns name, role, tier, host, port for each.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "agent_health",
      description:
        "Check whether a specific fleet agent is healthy. Returns the OpenClaw /health JSON.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "invoke_agent",
      description:
        "Send a prompt to a fleet agent and return its reply. Streams internally; emits progress notifications if client passes _meta.progressToken.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Agent name (e.g. 'donna')" },
          prompt: { type: "string", description: "User message to send" },
          timeout_ms: {
            type: "number",
            description: "Optional timeout in milliseconds (default 60000)",
          },
        },
        required: ["name", "prompt"],
      },
    },
  ],
}));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request, extra) => {
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
      if (name === "invoke_agent") {
        const a = findAgent(String(args?.name ?? ""));
        if (!a) throw new Error(`unknown agent: ${args?.name}`);
        const prompt = String(args?.prompt ?? "");
        const timeoutMs = Number(args?.timeout_ms ?? 60000);
        const progress = makeProgressEmitter(extra);
        const reply = await invokeAgentStreamed(a, prompt, timeoutMs, progress);
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
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

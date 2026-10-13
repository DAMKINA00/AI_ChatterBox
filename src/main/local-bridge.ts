// Local HTTP endpoint behind the stdio MCP servers the CLIs load (bridge-mcp.js).
// The MCP servers run as children of claude.exe / codex.exe, so they can't reach Electron IPC;
// they list tools and forward tool calls here. Each registration (a "key") exposes its own tools:
// the permission-prompt tool for a Claude process, or consult_* / ask_user for an orchestrator.
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface Registration {
  tools: ToolDef[];
  call(name: string, args: any): Promise<ToolResult>;
}

export const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], isError });

export class LocalBridge {
  private server?: Server;
  private port = 0;
  private readonly token = randomBytes(16).toString("hex");
  private regs = new Map<string, Registration>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const m = /^\/([0-9a-f]+)\/([\w-]+)\/(tools|call)$/.exec(req.url ?? "");
      if (!m || m[1] !== this.token) {
        res.writeHead(404).end();
        return;
      }
      const reg = this.regs.get(m[2]);
      const reply = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (m[3] === "tools") return reply({ tools: reg?.tools ?? [] });
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (!reg) return reply(textResult("AI_ChatterBox: 이 대화는 더 이상 열려 있지 않습니다.", true));
        try {
          const { name, arguments: args } = JSON.parse(body);
          reply(await reg.call(name, args ?? {}));
        } catch (e) {
          reply(textResult(`AI_ChatterBox error: ${e instanceof Error ? e.message : String(e)}`, true));
        }
      });
    });
    // No timeouts: approvals and consults can take a long time.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Returns the base URL the MCP server should use for this registration. */
  register(reg: Registration, key: string = randomUUID()): { key: string; url: string } {
    this.regs.set(key, reg);
    return { key, url: `http://127.0.0.1:${this.port}/${this.token}/${key}` };
  }

  unregister(key: string): void {
    this.regs.delete(key);
  }

  stop(): void {
    this.server?.close();
  }
}

/** MCP server config entry (Claude --mcp-config format) running bridge-mcp.js with Electron as Node. */
export function bridgeServerConfig(script: string, url: string) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: "1", CHATTERBOX_URL: url },
  };
}

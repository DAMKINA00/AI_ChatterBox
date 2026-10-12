// Local HTTP endpoint that Claude's --permission-prompt-tool MCP server calls.
// The MCP server runs as a child of claude.exe, so it can't reach Electron IPC directly;
// it POSTs each permission request here and blocks until the user answers in the UI.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface PermissionRequest {
  tool_name: string;
  input: unknown;
  tool_use_id?: string;
}

export type PermissionResult =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

type Handler = (req: PermissionRequest) => Promise<PermissionResult>;

export class ApprovalBroker {
  private server?: Server;
  private port = 0;
  private readonly token = randomBytes(16).toString("hex");
  private handlers = new Map<string, Handler>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const m = /^\/approve\/([0-9a-f]+)\/([\w-]+)$/.exec(req.url ?? "");
      if (req.method !== "POST" || !m || m[1] !== this.token) {
        res.writeHead(404).end();
        return;
      }
      const handler = this.handlers.get(m[2]);
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let result: PermissionResult;
        try {
          result = handler
            ? await handler(JSON.parse(body))
            : { behavior: "deny", message: "AI_ChatterBox: 이 세션은 더 이상 열려 있지 않습니다." };
        } catch (e) {
          result = { behavior: "deny", message: `AI_ChatterBox approval error: ${String(e)}` };
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      });
    });
    // No timeout: the user may take a while to answer.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** URL the MCP server should POST to for this session. */
  register(key: string, handler: Handler): string {
    this.handlers.set(key, handler);
    return `http://127.0.0.1:${this.port}/approve/${this.token}/${key}`;
  }

  unregister(key: string): void {
    this.handlers.delete(key);
  }

  stop(): void {
    this.server?.close();
  }
}

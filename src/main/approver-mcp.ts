// Stdio MCP server used as claude's --permission-prompt-tool. Built as a separate bundle
// (out/main/approver-mcp.js) and run by Electron's binary with ELECTRON_RUN_AS_NODE=1.
// It has no dependencies: minimal MCP (JSON-RPC 2.0, one message per line) plus one tool
// that forwards the request to the app's ApprovalBroker and returns the user's answer.
import { createInterface } from "node:readline";

const url = process.env.CHATTERBOX_APPROVAL_URL;

function send(msg: object) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

async function decide(args: unknown): Promise<object> {
  if (!url) return { behavior: "deny", message: "AI_ChatterBox approval URL missing" };
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json" } });
    return (await res.json()) as object;
  } catch (e) {
    return { behavior: "deny", message: `AI_ChatterBox unreachable: ${String(e)}` };
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "chatterbox_approver", version: "0.1.0" },
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({
        id,
        result: {
          tools: [
            {
              name: "approve",
              description: "AI_ChatterBox permission prompt: asks the user to allow or deny a tool call",
              inputSchema: {
                type: "object",
                properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
                required: ["tool_name", "input"],
              },
            },
          ],
        },
      });
    case "tools/call": {
      if (params?.name !== "approve") return send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      const decision = await decide(params.arguments ?? {});
      return send({ id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
    }
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.setEncoding("utf8");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    // ignore malformed input
  }
});

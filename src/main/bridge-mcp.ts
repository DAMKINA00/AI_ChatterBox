// Stdio MCP server loaded by claude.exe / codex.exe. Built as a separate bundle (out/main/bridge-mcp.js)
// and run by Electron's binary with ELECTRON_RUN_AS_NODE=1. No dependencies: minimal MCP
// (JSON-RPC 2.0, one message per line); tools are listed and executed by the app's LocalBridge.
import { createInterface } from "node:readline";

const base = process.env.CHATTERBOX_URL;

function send(msg: object) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

async function http(path: string, body?: unknown): Promise<any> {
  if (!base) throw new Error("CHATTERBOX_URL missing");
  const res = await fetch(`${base}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return res.json();
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "chatterbox", version: "0.2.0" },
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({ id, result: { tools: (await http("tools")).tools } });
      case "tools/call":
        return send({ id, result: await http("call", { name: params?.name, arguments: params?.arguments ?? {} }) });
      default:
        return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    return send({ id, result: { content: [{ type: "text", text: `AI_ChatterBox unreachable: ${String(e)}` }], isError: true } });
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

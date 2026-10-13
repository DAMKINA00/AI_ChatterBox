// Stdio MCP server loaded by claude.exe / codex.exe. Built as a separate bundle (out/main/bridge-mcp.js)
// and run by Electron's binary with ELECTRON_RUN_AS_NODE=1. No dependencies: minimal MCP
// (JSON-RPC 2.0, one message per line); tools are listed and executed by the app's LocalBridge.
import { createInterface } from "node:readline";
import { request } from "node:http";

const base = process.env.CHATTERBOX_URL;

function send(msg: object) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

/**
 * node:http rather than fetch: fetch (undici) gives up on a response after 5 minutes, and a consult
 * (a worker's whole turn) or an approval waiting for the user often takes longer.
 */
function http(path: string, body?: unknown): Promise<any> {
  if (!base) return Promise.reject(new Error("CHATTERBOX_URL missing"));
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      `${base}/${path}`,
      {
        method: data ? "POST" : "GET",
        headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
        timeout: 0,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(0);
    if (data) req.write(data);
    req.end();
  });
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

// Tiny stdio MCP server used as claude's --permission-prompt-tool.
// Logs every permission request and always denies it.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logFile = process.env.APPROVER_LOG;

const server = new McpServer({ name: "approver", version: "0.0.1" });

server.registerTool(
  "approve",
  {
    description: "Permission prompt handler for Claude Code",
    inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
  },
  async (args) => {
    const record = { at: new Date().toISOString(), request: args };
    process.stderr.write(`approver: ${JSON.stringify(record)}\n`);
    if (logFile) appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
    const decision = { behavior: "deny", message: "Denied by AI_ChatterBox M0 spike approver" };
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  },
);

await server.connect(new StdioServerTransport());

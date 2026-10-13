// M0 spike: drive Claude Code as a long-lived stream-json process.
//  phase 1: one process, 2 user turns (turn 2 triggers a Write -> --permission-prompt-tool -> deny)
//  phase 2: new process with --resume <session_id>, check context carried over
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findClaude, version, readLines, waitExit, scratch, SPIKE_DIR, log } from "./common.ts";

const CLAUDE = findClaude();
const WORK = scratch("claude-work");
const EVENTS = join(scratch("logs"), "claude-events.jsonl");
const APPROVALS = join(scratch("logs"), "claude-approvals.log");
for (const f of [EVENTS, APPROVALS]) rmSync(f, { force: true });

// --mcp-config with the approver; tsx's CLI is run through the current node so no shell/.cmd is needed.
const mcpConfig = join(scratch("logs"), "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      approver: {
        type: "stdio",
        command: process.execPath,
        args: [join(SPIKE_DIR, "node_modules", "tsx", "dist", "cli.mjs"), join(SPIKE_DIR, "approver-mcp.ts")],
        env: { APPROVER_LOG: APPROVALS },
      },
    },
  }),
);

const observed = new Set<string>();

type Turn = { text: string; result?: any };

class ClaudeSession {
  child: ChildProcess;
  sessionId?: string;
  private waiter?: (ev: any) => void;
  private buf = "";

  constructor(extraArgs: string[]) {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--permission-prompt-tool", "mcp__approver__approve",
      ...extraArgs,
    ];
    log("claude", "spawn", CLAUDE, args.join(" "));
    this.child = spawn(CLAUDE, args, { cwd: WORK, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d) => process.stderr.write(`[claude:stderr] ${d}`));
    readLines(this.child, (line) => this.onLine(line));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    appendFileSync(EVENTS, line + "\n", "utf8");
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return log("claude", "non-JSON stdout:", line);
    }
    const key = ev.type === "stream_event" ? `stream_event/${ev.event?.type}` : `${ev.type}${ev.subtype ? "/" + ev.subtype : ""}`;
    observed.add(key);

    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          this.sessionId = ev.session_id;
          log("init", `session_id=${ev.session_id} model=${ev.model} permissionMode=${ev.permissionMode}`,
            `mcp=${JSON.stringify(ev.mcp_servers)}`);
        } else log("system", ev.subtype);
        break;
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          this.buf += e.delta.text;
          process.stdout.write(e.delta.text);
        } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
          log("tool_use:start", e.content_block.name);
        }
        break;
      }
      case "assistant":
        if (ev.error) log("api_error", ev.error, JSON.stringify(ev.message?.content?.[0]?.text));
        for (const c of ev.message?.content ?? [])
          if (c.type === "tool_use") log("tool_call", c.name, JSON.stringify(c.input), c.id);
        break;
      case "user":
        for (const c of ev.message?.content ?? [])
          if (c.type === "tool_result")
            log("tool_result", c.is_error ? "ERROR" : "ok", JSON.stringify(c.content).slice(0, 200));
        break;
      case "result":
        process.stdout.write("\n");
        log("result", `subtype=${ev.subtype} is_error=${ev.is_error} turns=${ev.num_turns} cost=$${ev.total_cost_usd}`,
          `denials=${JSON.stringify(ev.permission_denials ?? [])}`);
        this.waiter?.(ev);
        break;
      default:
        log("event", key);
    }
  }

  send(text: string): Promise<Turn> {
    log("user", text);
    this.buf = "";
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child.stdin!.write(JSON.stringify(msg) + "\n", "utf8");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("turn timeout")), 180_000);
      this.waiter = (result) => {
        clearTimeout(t);
        this.waiter = undefined;
        resolve({ text: this.buf, result });
      };
    });
  }

  async close() {
    this.child.stdin!.end();
    const code = await waitExit(this.child, 15_000);
    log("claude", `exit code=${code} (after stdin EOF)`);
  }
}

async function main() {
  log("version", `claude=${version(CLAUDE)}`);
  const checks: Record<string, boolean> = {};

  // ---- phase 1: long-lived process, 2 turns
  const s1 = new ClaudeSession([]);
  const t1 = await s1.send("Remember this codeword: 파인애플-42. Reply with exactly: 확인");
  if (t1.result?.terminal_reason === "api_error") {
    // e.g. "Not logged in · Please run /login" — the CLI bundled with the desktop app has no login of its own
    log("abort", `API error on first turn: ${t1.result.result}`);
    await s1.close();
    process.exit(2);
  }
  checks["turn1 got text"] = t1.text.length > 0;
  checks["korean round-trip"] = t1.text.includes("확인");
  const sessionId = s1.sessionId!;

  const t2 = await s1.send(
    "Use the Write tool to create a file named note.txt in the current directory containing the word hi. " +
      "If the tool is denied, reply with exactly: DENIED",
  );
  checks["same session across turns"] = s1.sessionId === sessionId;
  checks["approver was called"] = existsSync(APPROVALS) && readFileSync(APPROVALS, "utf8").includes("note.txt");
  checks["file was not written"] = !existsSync(join(WORK, "note.txt"));
  checks["denial reported in result"] = (t2.result?.permission_denials ?? []).length > 0;
  await s1.close();

  // ---- phase 2: new process resuming the session
  const s2 = new ClaudeSession(["--resume", sessionId]);
  const t3 = await s2.send("What was the codeword I asked you to remember? Reply with just the codeword.");
  checks["resume carried context"] = t3.text.includes("파인애플-42");
  log("resume", `old=${sessionId} new=${s2.sessionId} (same id: ${s2.sessionId === sessionId})`);
  await s2.close();

  console.log("\n=== observed event types ===\n" + [...observed].sort().join("\n"));
  console.log("\n=== checks ===");
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

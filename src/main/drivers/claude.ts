// Claude Code driver: one long-lived `claude -p` stream-json process per session.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "../../shared/types";
import type { ApprovalBroker, PermissionRequest, PermissionResult } from "../approval-broker";
import { readLines, shutdown } from "../proc";
import type { AgentDriver, DriverCallbacks, DriverOptions } from "./types";

const AUTH_HINT =
  "Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude 를 실행하고 /login 으로 로그인한 뒤 다시 시도하세요.";

export interface ClaudeEnv {
  broker: ApprovalBroker;
  /** Path of the bundled approver-mcp.js. */
  approverScript: string;
  /** Folder for per-session MCP config files. */
  tmpDir: string;
}

export class ClaudeDriver implements AgentDriver {
  readonly agent = "claude" as const;
  private child?: ChildProcess;
  private nativeId: string | null;
  private running = false;
  private stopping = false;
  private readonly key = randomUUID();
  private pendingApprovals = new Map<string, (r: PermissionResult) => void>();
  private approvalInputs = new Map<string, unknown>();

  constructor(
    private opts: DriverOptions,
    private env: ClaudeEnv,
    private cb: DriverCallbacks,
  ) {
    this.nativeId = opts.nativeId;
  }

  private start(): ChildProcess {
    const approvalUrl = this.env.broker.register(this.key, (req) => this.onPermission(req));
    const mcpFile = join(this.env.tmpDir, `mcp-${this.key}.json`);
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          chatterbox_approver: {
            type: "stdio",
            command: process.execPath,
            args: [this.env.approverScript],
            env: { ELECTRON_RUN_AS_NODE: "1", CHATTERBOX_APPROVAL_URL: approvalUrl },
          },
        },
      }),
      "utf8",
    );
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", mcpFile,
      "--permission-prompt-tool", "mcp__chatterbox_approver__approve",
    ];
    if (this.nativeId) args.push("--resume", this.nativeId);

    const child = spawn(this.opts.exePath, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // The user may take a while to answer an approval card; don't let the MCP call time out.
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000) },
    });
    child.stderr!.setEncoding("utf8");
    let stderr = "";
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    readLines(child, (line) => this.onLine(line));
    child.on("error", (e) => {
      this.cb.onEvent({ type: "error", kind: "process", message: `claude 실행 실패: ${e.message}` });
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.env.broker.unregister(this.key);
      this.denyAllPending();
      if (this.running) {
        this.running = false;
        if (this.stopping) this.cb.onEvent({ type: "turn_end", ok: false, interrupted: true });
        else {
          this.cb.onEvent({ type: "error", kind: "process", message: `claude 프로세스가 종료됨 (code ${code}) ${stderr.trim()}` });
          this.cb.onEvent({ type: "turn_end", ok: false, error: `exit ${code}` });
        }
      }
      this.stopping = false;
    });
    return child;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && ev.session_id && ev.session_id !== this.nativeId) {
          this.nativeId = ev.session_id;
          this.cb.onNativeId(ev.session_id);
        }
        break;
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && !ev.parent_tool_use_id)
          this.cb.onEvent({ type: "text_delta", text: e.delta.text });
        break;
      }
      case "assistant": {
        if (ev.error === "authentication_failed") {
          this.cb.onEvent({ type: "error", kind: "auth", message: AUTH_HINT });
          break;
        }
        if (ev.parent_tool_use_id) break; // sub-agent traffic; M1 shows the top level only
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text) this.cb.onEvent({ type: "text", text: c.text });
          else if (c.type === "tool_use")
            this.cb.onEvent({ type: "tool_call", id: c.id, name: c.name, input: JSON.stringify(c.input, null, 2) });
        }
        break;
      }
      case "user":
        if (ev.parent_tool_use_id) break;
        for (const c of ev.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const out = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("\n");
          this.cb.onEvent({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error, output: out });
        }
        break;
      case "result": {
        this.running = false;
        const interrupted = this.stopping;
        this.stopping = false;
        if (ev.is_error && !interrupted) {
          const msg = String(ev.result ?? ev.terminal_reason ?? "error");
          if (/log ?in/i.test(msg)) this.cb.onEvent({ type: "error", kind: "auth", message: AUTH_HINT });
          this.cb.onEvent({ type: "turn_end", ok: false, error: msg });
        } else this.cb.onEvent({ type: "turn_end", ok: !interrupted, interrupted });
        break;
      }
      case "control_response":
        break;
    }
  }

  private onPermission(req: PermissionRequest): Promise<PermissionResult> {
    const id = `claude:${req.tool_use_id ?? randomUUID()}`;
    this.approvalInputs.set(id, req.input);
    const detail = formatToolInput(req.tool_name, req.input);
    this.cb.onEvent({ type: "approval_request", request: { id, title: req.tool_name, detail } });
    return new Promise((resolve) => this.pendingApprovals.set(id, resolve));
  }

  answerApproval(approvalId: string, decision: ApprovalDecision): void {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) return;
    this.pendingApprovals.delete(approvalId);
    const input = this.approvalInputs.get(approvalId);
    this.approvalInputs.delete(approvalId);
    resolve(
      decision === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "사용자가 AI_ChatterBox에서 거부했습니다." },
    );
    this.cb.onEvent({ type: "approval_resolved", id: approvalId, decision });
  }

  private denyAllPending() {
    for (const id of [...this.pendingApprovals.keys()]) this.answerApproval(id, "deny");
  }

  async send(text: string): Promise<void> {
    if (this.running) throw new Error("이전 응답이 아직 진행 중입니다.");
    if (!this.child) this.child = this.start();
    this.running = true;
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child.stdin!.write(JSON.stringify(msg) + "\n", "utf8");
  }

  async stop(): Promise<void> {
    if (!this.running || !this.child) return;
    this.stopping = true;
    this.denyAllPending();
    const req = { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } };
    this.child.stdin!.write(JSON.stringify(req) + "\n", "utf8");
    // If the CLI ignores the interrupt, end the process; the next send resumes the session.
    const child = this.child;
    setTimeout(() => {
      if (this.running && this.stopping && this.child === child) void shutdown(child, 1000);
    }, 5000);
  }

  async dispose(): Promise<void> {
    this.denyAllPending();
    const child = this.child;
    this.child = undefined;
    this.running = false;
    if (child) await shutdown(child);
    this.env.broker.unregister(this.key);
  }
}

function formatToolInput(tool: string, input: any): string {
  if (input && typeof input === "object") {
    if (tool === "Bash" && typeof input.command === "string") return input.command;
    if (typeof input.file_path === "string" && Object.keys(input).length <= 2 && !("content" in input))
      return input.file_path;
  }
  return JSON.stringify(input, null, 2);
}

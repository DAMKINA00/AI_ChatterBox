// Claude Code driver: one long-lived `claude -p` stream-json process per chat.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bridgeServerConfig, textResult, type LocalBridge } from "../local-bridge";
import { claudeToolDiffs, claudeToolPaths } from "../diffs";
import { READ_ONLY_TOOLS } from "../approvals";
import { readLines, shutdown } from "../proc";
import { fileNote, IMAGE_MIMES, MAX_IMAGE_BYTES, type AgentDriver, type AgentInput, type DriverHost, type DriverOptions } from "./types";

const AUTH_HINT =
  "Claude Code에 로그인되어 있지 않습니다. 터미널에서 claude 를 실행하고 /login 으로 로그인한 뒤 다시 시도하세요.";

/** Read-only tools Claude's default permission mode already allows; never routed to us. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface PermissionRequest {
  tool_name: string;
  input: unknown;
  tool_use_id?: string;
}
type PermissionResult = { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

export interface ClaudeEnv {
  bridge: LocalBridge;
  bridgeScript: string;
  tmpDir: string;
  /** Extra MCP servers to load (e.g. the orchestrator's consult tools). */
  mcpServers?: () => Record<string, unknown>;
  /** Tools the CLI must not use (the orchestrator is read-only). */
  disallowedTools?: string[];
  /** Tools allowed without a permission prompt (the orchestrator's consult tools). */
  allowedTools?: string[];
  /** Built-in tool set (--tools); [] = no tools at all (the approval judge). */
  tools?: string[];
  /** Load only our MCP servers, not the user's. */
  strictMcp?: boolean;
  extraArgs?: string[];
}

export class ClaudeDriver implements AgentDriver {
  readonly agent = "claude" as const;
  private child?: ChildProcess;
  private nativeId: string | null;
  private _running = false;
  private stopping = false;
  private bridgeKey?: string;
  private toolInputs = new Map<string, { name: string; input: any }>();

  constructor(
    private opts: DriverOptions,
    private env: ClaudeEnv,
    private host: DriverHost,
  ) {
    this.nativeId = opts.nativeId;
  }

  get running() {
    return this._running;
  }

  private start(): ChildProcess {
    const { key, url } = this.env.bridge.register({
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
      call: async (_name, args) => textResult(JSON.stringify(await this.onPermission(args as PermissionRequest))),
    });
    this.bridgeKey = key;
    const mcpFile = join(this.env.tmpDir, `mcp-${key}.json`);
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          chatterbox_approver: bridgeServerConfig(this.env.bridgeScript, url),
          ...(this.env.mcpServers?.() ?? {}),
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
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.instructions) args.push("--append-system-prompt", this.opts.instructions);
    if (this.env.disallowedTools?.length) args.push("--disallowedTools", this.env.disallowedTools.join(","));
    if (this.env.allowedTools?.length) args.push("--allowedTools", this.env.allowedTools.join(","));
    if (this.env.tools) args.push("--tools", this.env.tools.join(","));
    if (this.env.strictMcp) args.push("--strict-mcp-config");
    if (this.env.extraArgs) args.push(...this.env.extraArgs);
    if (this.nativeId) args.push("--resume", this.nativeId);

    const child = spawn(this.opts.exePath, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Approvals and consults can take a long time; don't let MCP calls time out.
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 3600 * 1000) },
    });
    child.stderr!.setEncoding("utf8");
    let stderr = "";
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    readLines(child, (line) => this.onLine(line));
    child.on("error", (e) => this.host.emit({ type: "error", kind: "process", message: `claude 실행 실패: ${e.message}` }));
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.env.bridge.unregister(key);
      if (this._running) {
        this._running = false;
        if (this.stopping) this.host.emit({ type: "turn_end", ok: false, interrupted: true });
        else {
          this.host.emit({ type: "error", kind: "process", message: `claude 프로세스가 종료됨 (code ${code}) ${stderr.trim().slice(-800)}` });
          this.host.emit({ type: "turn_end", ok: false, error: `exit ${code}` });
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
          this.host.nativeId(ev.session_id);
        }
        break;
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && !ev.parent_tool_use_id)
          this.host.emit({ type: "text_delta", text: e.delta.text });
        break;
      }
      case "assistant": {
        if (ev.error === "authentication_failed") {
          this.host.emit({ type: "error", kind: "auth", message: AUTH_HINT });
          break;
        }
        if (ev.parent_tool_use_id) break; // sub-agent traffic is summarized by its Task tool result
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text) this.host.emit({ type: "text", text: c.text });
          else if (c.type === "tool_use") {
            this.toolInputs.set(c.id, { name: c.name, input: c.input });
            this.host.emit({
              type: "tool_call",
              id: c.id,
              name: c.name,
              input: formatInput(c.name, c.input),
              diffs: claudeToolDiffs(c.name, c.input, this.opts.cwd),
            });
          }
        }
        break;
      }
      case "user":
        if (ev.parent_tool_use_id) break;
        for (const c of ev.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const out = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("\n");
          this.host.emit({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error, output: out });
        }
        break;
      case "rate_limit_event": {
        const w = ev.rate_limit_info?.unifiedWindows ?? {};
        // utilization is 0–1
        const win = (x: any) => (x && typeof x.utilization === "number" ? { usedPercent: x.utilization * 100, resetsAt: x.resetsAt } : undefined);
        const fiveHour = win(w.five_hour);
        const weekly = win(w.seven_day);
        if (fiveHour || weekly) this.host.usage?.({ claude: { fiveHour, weekly } });
        break;
      }
      case "result": {
        this._running = false;
        const interrupted = this.stopping;
        this.stopping = false;
        if (ev.is_error && !interrupted) {
          const msg = String(ev.result ?? ev.terminal_reason ?? "error");
          if (/log ?in/i.test(msg)) this.host.emit({ type: "error", kind: "auth", message: AUTH_HINT });
          this.host.emit({ type: "turn_end", ok: false, error: msg });
        } else this.host.emit({ type: "turn_end", ok: !interrupted, interrupted });
        break;
      }
    }
  }

  private async onPermission(req: PermissionRequest): Promise<PermissionResult> {
    const input: any = req.input ?? {};
    const command = SHELL_TOOLS.has(req.tool_name) && typeof input.command === "string" ? input.command : undefined;
    const { verdict, reason } = await this.host.approve({
      title: req.tool_name,
      detail: command ?? formatInput(req.tool_name, input),
      reason: typeof input.description === "string" ? input.description : undefined,
      key: command ? `${req.tool_name}:${firstWord(command)}` : req.tool_name,
      command,
      paths: claudeToolPaths(input),
      diffs: claudeToolDiffs(req.tool_name, input, this.opts.cwd),
      readOnly: READ_ONLY_TOOLS.has(req.tool_name),
      writes: WRITE_TOOLS.has(req.tool_name),
    });
    return verdict === "deny"
      ? { behavior: "deny", message: reason ?? "AI_ChatterBox에서 거부되었습니다." }
      : { behavior: "allow", updatedInput: req.input };
  }

  async send(input: AgentInput): Promise<void> {
    if (this._running) throw new Error("이전 응답이 아직 진행 중입니다.");
    if (!this.child) this.child = this.start();
    this._running = true;
    const images = input.attachments.filter((a) => IMAGE_MIMES.has(a.mime) && a.size <= MAX_IMAGE_BYTES);
    const others = input.attachments.filter((a) => !images.includes(a));
    const content: unknown[] = images.map((a) => ({
      type: "image",
      source: { type: "base64", media_type: a.mime, data: readFileSync(a.path).toString("base64") },
    }));
    content.push({ type: "text", text: (input.text || "(첨부 파일을 확인해 주세요)") + fileNote(others) });
    const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    this.child.stdin!.write(JSON.stringify(msg) + "\n", "utf8");
  }

  async stop(): Promise<void> {
    if (!this._running || !this.child) return;
    this.stopping = true;
    const req = { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } };
    this.child.stdin!.write(JSON.stringify(req) + "\n", "utf8");
    // If the CLI ignores the interrupt, end the process; the next send resumes the session.
    const child = this.child;
    setTimeout(() => {
      if (this._running && this.stopping && this.child === child) void shutdown(child, 1000);
    }, 5000);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this._running = false;
    if (child) await shutdown(child);
    if (this.bridgeKey) this.env.bridge.unregister(this.bridgeKey);
  }

  /** Model the process was started with; a different one needs a restart (resume keeps the session). */
  get model() {
    return this.opts.model;
  }
}

/**
 * Claude's rate-limit usage without a model turn: the local "/usage" command answers from the CLI
 * (0 tokens). Returns its text, or null.
 */
export async function claudeUsageText(exePath: string, cwd: string): Promise<string | null> {
  const child = spawn(
    exePath,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
    { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  try {
    return await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 30000);
      readLines(child, (l) => {
        try {
          const ev = JSON.parse(l);
          if (ev.type === "result") {
            clearTimeout(t);
            resolve(typeof ev.result === "string" ? ev.result : null);
          }
        } catch {
          // ignore
        }
      });
      child.on("error", () => resolve(null));
      child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "/usage" }] } }) + "\n");
    });
  } finally {
    await shutdown(child, 2000);
  }
}

/** Model list from the CLI itself (stream-json control_request "initialize" → response.models). */
export async function listClaudeModels(exePath: string, cwd: string): Promise<{ value: string; displayName: string; description?: string }[]> {
  const child = spawn(exePath, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  try {
    const models = await new Promise<any[]>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("claude model list timeout")), 20000);
      readLines(child, (l) => {
        try {
          const ev = JSON.parse(l);
          if (ev.type === "control_response") {
            clearTimeout(t);
            resolve(ev.response?.response?.models ?? []);
          }
        } catch {
          // ignore
        }
      });
      child.on("error", reject);
      child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n");
    });
    return models.filter((m) => m.value && m.value !== "default");
  } finally {
    await shutdown(child, 2000);
  }
}

function firstWord(cmd: string) {
  return cmd.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
}

function formatInput(tool: string, input: any): string {
  if (input && typeof input === "object") {
    if (SHELL_TOOLS.has(tool) && typeof input.command === "string") return input.command;
    if (tool === "Write" && typeof input.file_path === "string") return input.file_path;
    if ((tool === "Edit" || tool === "MultiEdit") && typeof input.file_path === "string") return input.file_path;
    if (typeof input.file_path === "string" && Object.keys(input).length <= 3 && !("content" in input)) return input.file_path;
  }
  return JSON.stringify(input, null, 2);
}

// Google AI subscription-backed Antigravity CLI; no API key or permission-bypass flag.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { textResult, type LocalBridge } from "../local-bridge";
import { readLines, shutdown } from "../proc";
import { isReadCommand } from "../execution-policy";
import { fileNote, type AgentDriver, type AgentInput, type DriverHost, type DriverOptions } from "./types";
import type { FileDiff, TokenCounts } from "../../shared/types";
import { GEMINI_WRITING_INSTRUCTIONS } from "../../shared/types";
import { GEMINI_READ_TOOLS, GEMINI_WRITE_TOOLS, geminiBridgeTool, geminiDiffs, geminiPaths, geminiTokens, listGeminiModels, tokenDelta, geminiEffortModel } from "./gemini-protocol";

export interface GeminiEnv {
  bridge: LocalBridge;
  hookScript: string;
  tmpDir: string;
  /** Stable per-chat worker control folder across native resume and app restart. */
  sessionKey?: string;
  mcpServers?: () => Record<string, unknown>;
}

export class GeminiDriver implements AgentDriver {
  readonly agent = "gemini" as const;
  private child?: ChildProcess;
  private nativeId: string | null;
  private _running = false;
  private stopping = false;
  private noWrites = true;
  private hookKey?: string;
  private startedAt = 0;
  private turnId = "";
  private model = "";
  private total = geminiTokens(null);
  private baseline = geminiTokens(null);
  private texts = new Map<number, string>();
  private completedText = new Set<number>();
  private diffs = new Map<string, FileDiff[]>();
  private hooksReady = false;
  private epoch = 0;
  private readonly sessionDir: string;

  constructor(private opts: DriverOptions, private env: GeminiEnv, private host: DriverHost) {
    this.nativeId = opts.nativeId;
    this.total = opts.tokenBaseline ?? geminiTokens(null);
    this.sessionDir = join(env.tmpDir, "AI AGENT", `gemini-${env.sessionKey?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? randomUUID()}`);
  }
  get running() { return this._running; }

  /** Public for protocol tests; called only through a per-process private loopback registration. */
  async hook(phase: string, payload: any): Promise<Record<string, unknown>> {
    if (phase === "start" || phase === "instructions") {
      this.hooksReady = true;
      return { injectSteps: [{ ephemeralMessage: `${this.opts.instructions ?? ""}\n${GEMINI_WRITING_INSTRUCTIONS}\n실제 작업 폴더: ${this.opts.cwd}\n제어용 폴더(${this.sessionDir})는 수정하지 않는다. 네이티브 하위 작업자·브라우저·이미지 도구는 사용하지 않는다. 추가 인력은 마스터에게 결과로 요청한다.` }] };
    }
    const tool = payload?.toolCall;
    const name = tool?.name;
    const args = tool?.args;
    const id = `gemini:${payload?.conversationId ?? this.nativeId}:${payload?.stepIdx}`;
    if (phase === "post") {
      this.host.emit({ type: "tool_result", id, ok: !payload.error, output: payload.error || "완료" });
      const files = this.diffs.get(id);
      if (files?.length) this.host.emit({ type: "file_change", id, files, ok: !payload.error });
      this.diffs.delete(id);
      return {};
    }
    const deny = (reason: string) => {
      this.host.emit({ type: "tool_result", id, ok: false, output: reason });
      return { decision: "deny", reason };
    };
    if (phase !== "pre" || !this._running || this.stopping) return { decision: "deny", reason: "진행 중인 ChatterBox 작업이 없습니다." };
    if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return deny("잘못된 도구 요청입니다.");
    if (!this.hooksReady) return deny("Antigravity 승인 연결을 초기화하지 못했습니다.");
    const bridge = geminiBridgeTool(name, args);
    const writes = GEMINI_WRITE_TOOLS.has(name);
    const readOnly = GEMINI_READ_TOOLS.has(name) || (name === "manage_task" && ["list", "status"].includes(args.Action));
    const command = name === "run_command" ? String(args.CommandLine ?? "") : undefined;
    const files = writes ? geminiDiffs(name, args, this.opts.cwd) : undefined;
    const display = bridge && name === "call_mcp_tool" ? `mcp__chatterbox_bridge__${args.ToolName}` : command ? "PowerShell" : name;
    this.host.emit({ type: "tool_call", id, name: display, input: command ?? JSON.stringify(bridge && name === "call_mcp_tool" ? args.Arguments ?? {} : args), diffs: files });
    if (!bridge && !writes && !readOnly && !command) return deny(`이 작업자는 ${name} 도구를 지원하지 않습니다. 앱 마스터에게 필요한 작업을 보고하세요.`);
    if (this.noWrites && (writes || (command && !isReadCommand(command)))) return deny("계획·리뷰·의견 작업에서는 수정이나 변경 명령을 실행할 수 없습니다.");
    const paths = geminiPaths(args).map((p) => resolve(this.opts.cwd, p));
    if (paths.some((p) => p === this.sessionDir || p.startsWith(this.sessionDir + "/") || p.startsWith(this.sessionDir + "\\"))) return deny("ChatterBox 제어 설정에는 접근할 수 없습니다.");
    if (bridge) return { decision: "auto_approve" };
    if (writes && !files?.length) return deny("수정할 파일 경로를 확인하지 못했습니다.");
    const approval = await this.host.approve({ title: display, detail: command ?? JSON.stringify(args), key: name, paths, command, diffs: files, writes, readOnly });
    if (approval.verdict === "deny" || !this._running || this.stopping) return deny(approval.reason || "실행이 거부되거나 중지되었습니다.");
    if (files?.length) this.diffs.set(id, files);
    return { decision: "auto_approve" };
  }

  private async start(epoch: number) {
    const models = await listGeminiModels(this.opts.exePath, this.env.tmpDir);
    if (epoch !== this.epoch || this.stopping) throw new Error("Antigravity 실행이 중지되었습니다.");
    const model = this.opts.model ? models.find((m) => m.id === this.opts.model) : models.find((m) => m.isDefault) ?? models[0];
    if (!model) throw new Error("선택한 Gemini 모델은 현재 Pro 모델 목록에 없습니다. 모델 메뉴에서 다시 선택하세요.");
    this.model = geminiEffortModel(model, this.opts.effort, models).id;
    if (!existsSync(this.env.hookScript)) throw new Error("Antigravity 승인 연결 파일을 찾지 못했습니다. 앱을 다시 설치해 주세요.");
    const reg = this.env.bridge.register({ tools: [], call: async (name, args) => textResult(JSON.stringify(await this.hook(name, args))) });
    this.hookKey = reg.key;
    const config = join(this.sessionDir, ".agents");
    mkdirSync(config, { recursive: true });
    // Go's cmd.exe wrapper escapes quoted paths incorrectly. An encoded PowerShell
    // command preserves paths (including spaces) and forwards UTF-8 JSON on stdin.
    const command = (phase: string) => {
      const quote = (s: string) => "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
      const invoke = `${quote(process.execPath)} ${quote(this.env.hookScript)} ${phase} ${quote(reg.url)}`;
      if (process.platform !== "win32") return invoke;
      const script = `$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd() | & ${invoke}; exit $LASTEXITCODE`;
      return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    };
    const handler = (phase: string) => ({ type: "command", command: command(phase), timeout: 86400 });
    writeFileSync(join(config, "hooks.json"), JSON.stringify({ chatterbox: {
      SessionStart: [handler("start")], PreInvocation: [handler("instructions")],
      PreToolUse: [{ matcher: "*", hooks: [handler("pre")] }],
      PostToolUse: [{ matcher: "*", hooks: [handler("post")] }],
    } }));
    writeFileSync(join(config, "mcp_config.json"), JSON.stringify({ mcpServers: this.env.mcpServers?.() ?? {} }));
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", this.model, "--add-dir", this.opts.cwd];
    if (this.nativeId) args.push("--conversation", this.nativeId);
    // Plan adds a native second layer to the app's own per-tool write restriction.
    args.push("--mode", this.noWrites ? "plan" : "accept-edits");
    const child = spawn(this.opts.exePath, args, { cwd: this.sessionDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CHATTERBOX_GEMINI_HOOK_URL: reg.url } });
    this.child = child;
    this.hooksReady = false;
    // Result usage is cumulative for the native conversation, including resumed processes.
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => { stderr = (stderr + s).slice(-3000); });
    child.stdin!.on("error", (e) => { if (this.child === child) this.finish(false, `Antigravity 입력 실패: ${e.message}`); });
    readLines(child, (line) => { if (this.child !== child) return; try { this.onEvent(JSON.parse(line)); } catch { /* CLI diagnostics are not events. */ } });
    child.on("error", (e) => { if (this.child === child) this.finish(false, `Antigravity 실행 실패: ${e.message}`); });
    child.on("exit", (code) => {
      const active = this.child === child;
      if (active) this.child = undefined;
      this.env.bridge.unregister(reg.key);
      if (active && this._running) this.finish(false, this.stopping ? undefined : `Antigravity 종료 (${code}): ${stderr.trim().slice(-800)}`, this.stopping);
    });
  }

  onEvent(event: any) {
    if (event.event === "init") {
      if (typeof event.conversation_id === "string") { this.nativeId = event.conversation_id; this.host.nativeId(event.conversation_id); }
      return;
    }
    if (!this._running) return;
    if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.step_type !== "agent_response" || typeof step.step_index !== "number") return;
      if (typeof step.text_delta === "string") {
        this.texts.set(step.step_index, (this.texts.get(step.step_index) ?? "") + step.text_delta);
        this.host.emit({ type: "text_delta", text: step.text_delta });
      }
      if (step.state === "DONE" && !this.completedText.has(step.step_index)) {
        this.completedText.add(step.step_index);
        const text = this.texts.get(step.step_index);
        if (text) this.host.emit({ type: "text", text });
      }
    } else if (event.event === "result") {
      const result = event.result ?? {};
      this.total = geminiTokens(result.usage);
      this.host.emit({ type: "agent_usage", metrics: { ...tokenDelta(this.total, this.baseline), turnId: this.turnId, elapsedMs: Date.now() - this.startedAt, model: this.model, ...(this.opts.effort ? { reasoningEffort: this.opts.effort } : {}), nativeId: this.nativeId ?? undefined, total: this.total } });
      if (typeof result.response === "string" && result.response && ![...this.texts.values()].includes(result.response)) this.host.emit({ type: "text", text: result.response });
      const ok = result.status === "SUCCESS" && this.hooksReady;
      this.finish(ok, ok ? undefined : result.error || (!this.hooksReady ? "Antigravity 승인 연결이 활성화되지 않았습니다." : "Antigravity 작업이 완료되지 않았습니다."), ["CANCELED", "INTERRUPTED"].includes(result.status));
    }
  }

  private finish(ok: boolean, error?: string, interrupted = false) {
    if (!this._running) return;
    this._running = false;
    if (error) this.host.emit({ type: "error", kind: "process", message: error });
    this.host.emit({ type: "turn_end", ok, error, interrupted });
  }

  async send(input: AgentInput) {
    if (this._running) throw new Error("제미나이 작업자가 이미 작업 중입니다.");
    if (!input.noWrites) throw new Error("Gemini CLI는 글쓰기 전용입니다. 파일 수정은 Claude/GPT에 맡기세요.");
    this._running = true;
    this.stopping = false;
    const epoch = ++this.epoch;
    const noWrites = !!input.noWrites || !!this.opts.readOnly;
    if (this.child && this.noWrites !== noWrites) await this.closeProcess();
    if (epoch !== this.epoch || this.stopping) return;
    this.noWrites = noWrites;
    this.texts.clear(); this.completedText.clear(); this.diffs.clear();
    try { if (!this.child) await this.start(epoch); }
    catch (error) { if (epoch === this.epoch) this._running = false; throw error; }
    if (epoch !== this.epoch || this.stopping) return;
    this.baseline = { ...this.total };
    this.startedAt = Date.now(); this.turnId = randomUUID(); this._running = true;
    this.child!.stdin!.write(JSON.stringify({ event: "user", message: { content: `[AI_ChatterBox 작업 지시]\n${this.opts.instructions ?? ""}\n${GEMINI_WRITING_INSTRUCTIONS}\n작업 폴더: ${this.opts.cwd}\n\n${input.text}${fileNote(input.attachments)}` } }) + "\n");
  }
  async stop() {
    this.stopping = true;
    ++this.epoch;
    const child = this.child;
    if (child) await shutdown(child, 1000);
    this.finish(false, undefined, true);
  }
  async dispose() {
    this.stopping = true;
    ++this.epoch;
    this._running = false;
    await this.closeProcess();
  }
  private async closeProcess() {
    const child = this.child; this.child = undefined;
    const hookKey = this.hookKey; this.hookKey = undefined;
    if (child) await shutdown(child, 1000);
    if (hookKey) this.env.bridge.unregister(hookKey);
  }
}

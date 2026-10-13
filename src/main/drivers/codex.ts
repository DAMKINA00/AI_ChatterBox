// Codex driver: one shared `codex app-server` process (JSON-RPC over stdio, one JSON object per line),
// one CodexDriver per thread.
import { spawn, type ChildProcess } from "node:child_process";
import type { FileDiff, ModelOption, UsageInfo, TokenCounts, AgentMetrics } from "../../shared/types";
import { readLines, shutdown } from "../proc";
import { classifyWindow, type UsageWindow } from "../../shared/usage";
import { fileNote, IMAGE_MIMES, type AgentDriver, type AgentInput, type DriverHost, type DriverOptions } from "./types";
import type { RequestId, ServerNotification, ServerRequest, InitializeResponse, ClientRequest } from "../codex-schema";
import type {
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadForkParams,
  ThreadForkResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  UserInput,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  FileUpdateChange,
  RateLimitSnapshot,
} from "../codex-schema/v2";

type Method = ClientRequest["method"];

// App workers own all delegation; native children have no app approval/history route.
export const APP_CODEX_CONFIG = { "features.multi_agent": false, "features.multi_agent_v2": false, "features.multi_agent_v2_dynamic_tools": false };

/** Routes app-server traffic to the CodexDriver that owns each thread. */
export class CodexServer {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private threads = new Map<string, CodexDriver>();
  /** Threads already started or resumed in the current process. */
  readonly loaded = new Set<string>();
  stderrTail = "";
  onUsage?: (u: UsageInfo) => void;

  constructor(private exePath: string) {}

  ensure(): Promise<void> {
    if (this.ready && this.child) return this.ready;
    this.loaded.clear();
    const child = spawn(this.exePath, ["app-server", ...Object.entries(APP_CODEX_CONFIG).flatMap(([k, v]) => ["-c", `${k}=${v}`])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (this.stderrTail = (this.stderrTail + d).slice(-4000)));
    readLines(child, (line) => this.onLine(line));
    const fail = (why: string) => {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
      }
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      for (const d of this.threads.values()) d.onServerExit(why);
    };
    child.on("error", (e) => fail(`codex 실행 실패: ${e.message}`));
    child.on("exit", (code) => fail(`codex app-server 종료됨 (code ${code})`));
    this.ready = (async () => {
      await this.request<InitializeResponse>("initialize", {
        clientInfo: { name: "ai_chatterbox", title: "AI_ChatterBox", version: "0.3.2" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.write({ method: "initialized" });
    })();
    return this.ready;
  }

  attach(threadId: string, driver: CodexDriver) {
    this.threads.set(threadId, driver);
  }
  detach(threadId: string) {
    this.threads.delete(threadId);
  }

  private write(msg: object) {
    this.child?.stdin!.write(JSON.stringify(msg) + "\n", "utf8");
  }

  request<R>(method: Method, params: unknown): Promise<R> {
    if (!this.child) return Promise.reject(new Error("codex app-server가 실행 중이 아닙니다."));
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respond(id: RequestId, result: unknown) {
    this.write({ id, result });
  }

  async models(): Promise<ModelOption[]> {
    await this.ensure();
    const r = await this.request<any>("model/list", {});
    return (r.data ?? []).map((m: any) => ({
      id: m.id,
      label: m.displayName ?? m.id,
      isDefault: !!m.isDefault,
      hidden: !!m.hidden,
      deprecated: !!m.upgrade,
    }));
  }

  async readUsage(): Promise<void> {
    await this.ensure();
    const r = await this.request<any>("account/rateLimits/read", {}).catch(() => null);
    if (r?.rateLimits) this.onUsage?.(toUsage(r.rateLimits));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      const req = msg as ServerRequest;
      const threadId = (req.params as any)?.threadId ?? (req.params as any)?.conversationId;
      const driver = threadId ? this.threads.get(threadId) : undefined;
      if (!driver || !driver.onServerRequest(req)) {
        // Unanswered requests block the turn; always reply.
        this.write({ id: req.id, error: { code: -32601, message: `AI_ChatterBox does not handle ${req.method}` } });
      }
      return;
    }
    const n = msg as ServerNotification;
    if (n.method === "account/rateLimits/updated") {
      this.onUsage?.(toUsage(n.params.rateLimits));
      return;
    }
    const threadId = (n.params as any)?.threadId;
    if (threadId) this.threads.get(threadId)?.onNotification(n);
  }

  async dispose() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (child) await shutdown(child);
  }
}

function toUsage(r: RateLimitSnapshot): UsageInfo {
  const out: { fiveHour?: UsageWindow; weekly?: UsageWindow } = {};
  for (const w of [r.primary, r.secondary]) {
    if (!w) continue;
    const kind = classifyWindow(w.windowDurationMins) ?? (w === r.primary ? "fiveHour" : "weekly");
    out[kind] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt };
  }
  return { codex: out };
}

/** Strip Codex's Windows wrapper: "powershell.exe" -Command '…' → … */
export function innerCommand(cmd: string): string {
  const m = /-Command\s+'([\s\S]*)'\s*$/.exec(cmd);
  return m ? m[1].replace(/''/g, "'") : cmd;
}

function toDiffs(changes: FileUpdateChange[]): FileDiff[] {
  return changes.map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff, ...(c.kind.type === "update" && c.kind.move_path ? { movePath: c.kind.move_path } : {}) }));
}

export interface CodexTurnResult {
  text: string;
  files: string[];
  status: "completed" | "interrupted" | "failed";
  error?: string;
}

export class CodexDriver implements AgentDriver {
  private startedAt = 0;
  private tokenTotal?: TokenCounts;
  private tokenBase?: TokenCounts;
  private metrics?: AgentMetrics;
  private noWrites = false;
  private imageFailure?: string;
  readonly agent = "codex" as const;
  private threadId: string | null;
  private turnId?: string;
  private _running = false;
  private approvals = new Map<string, { requestId: RequestId; kind: "command" | "file" }>();
  private fileItems = new Map<string, FileDiff[]>();
  private turnText = "";
  private turnFiles = new Set<string>();
  private turnWaiters: ((r: CodexTurnResult) => void)[] = [];

  constructor(
    private opts: DriverOptions,
    private server: CodexServer,
    private host: DriverHost,
  ) {
    this.threadId = opts.nativeId;
    this.tokenTotal = opts.tokenBaseline ?? (opts.nativeId ? undefined : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    if (this.threadId) server.attach(this.threadId, this);
  }

  get running() {
    return this._running;
  }

  private async ensureThread(): Promise<string> {
    await this.server.ensure();
    let config: Record<string, unknown> = { ...this.opts.codexConfig, ...APP_CODEX_CONFIG,
      ...(this.opts.allowImages === false || this.noWrites ? { "features.image_generation": false } : {}) };
    if (this.opts.readOnly && !this.judgeConfigured) {
      const inherited = await this.server.request<any>("config/read", { includeLayers: false, cwd: this.opts.cwd });
      config = { ...config, "web_search": "disabled", "project_doc_max_bytes": 0 };
      for (const feature of ["shell_tool", "multi_agent", "multi_agent_v2", "apps", "plugins", "browser_use", "computer_use", "image_generation", "view_image", "hooks", "tool_suggest", "sleep_tool"])
        config[`features.${feature}`] = false;
      for (const name of Object.keys(inherited?.config?.mcp_servers ?? {})) config[`mcp_servers.${name}.enabled`] = false;
      this.opts.codexConfig = config;
      this.judgeConfigured = true;
    }
    if (!this.threadId) {
      const params: ThreadStartParams = {
        cwd: this.opts.cwd,
        ...this.policy(),
        model: this.opts.model || null,
        developerInstructions: this.opts.instructions ?? null,
        config: config as ThreadStartParams["config"],
        ephemeral: this.opts.ephemeral ?? null,
      };
      const r = await this.server.request<ThreadStartResponse>("thread/start", params);
      this.threadId = r.thread.id;
      this.server.attach(this.threadId, this);
      this.server.loaded.add(this.threadId);
      if (!this.opts.ephemeral) this.host.nativeId(this.threadId);
    } else if (!this.server.loaded.has(this.threadId)) {
      const params: ThreadResumeParams = {
        threadId: this.threadId,
        excludeTurns: true,
        ...this.policy(),
        model: this.opts.model || null,
        developerInstructions: this.opts.instructions ?? null,
        config: config as ThreadResumeParams["config"],
      };
      this.server.attach(this.threadId, this);
      try {
        await this.server.request("thread/resume", params);
        this.server.loaded.add(this.threadId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Another program (usually the Codex desktop app, which lists our threads) holds the writer
        // lock. Continue on a fork: same history, new thread id.
        if (!/active writer|thread-store conflict/i.test(msg)) throw e;
        const old = this.threadId;
        const fork: ThreadForkParams = {
          threadId: old,
          cwd: this.opts.cwd,
          ...this.policy(),
          model: this.opts.model || null,
          developerInstructions: this.opts.instructions ?? null,
          config: config as ThreadForkParams["config"],
          excludeTurns: true,
        };
        const r = await this.server.request<ThreadForkResponse>("thread/fork", fork);
        this.server.detach(old);
        this.threadId = r.thread.id;
        this.server.attach(this.threadId, this);
        this.server.loaded.add(this.threadId);
        this.host.nativeId(this.threadId);
        this.host.emit({
          type: "notice",
          text: "다른 프로그램(Codex 앱 등)이 이 대화를 열고 있어서, 같은 기록을 복사한 새 대화로 이어서 진행합니다.",
        });
      }
    }
    return this.threadId;
  }

  private judgeConfigured = false;

  /** The judge cannot escalate. Other roles route writes through the client's approval gate. */
  private policy(): Pick<ThreadStartParams, "approvalPolicy" | "approvalsReviewer" | "sandbox"> {
    return this.opts.readOnly
      ? { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only" }
      : { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" };
  }

  /** Model for the next turn (turn/start applies it to this and later turns). */
  setModel(model: string | undefined) {
    this.opts.model = model;
  }

  async send(input: AgentInput): Promise<void> {
    if (this._running) throw new Error("이전 응답이 아직 진행 중입니다.");
    this._running = true;
    this.stopRequested = false;
    this.turnText = "";
    this.turnFiles.clear();
    this.startedAt = Date.now();
    this.tokenBase = this.tokenTotal;
    this.metrics = undefined;
    this.imageFailure = undefined;
    if (this.noWrites !== !!input.noWrites) {
      this.noWrites = !!input.noWrites;
      if (this.threadId) this.server.loaded.delete(this.threadId);
    }
    try {
      const threadId = await this.ensureThread();
      const images = input.attachments.filter((a) => IMAGE_MIMES.has(a.mime));
      const others = input.attachments.filter((a) => !images.includes(a));
      const items: UserInput[] = images.map((a) => ({ type: "localImage", path: a.path }));
      items.push({ type: "text", text: (input.text || "(첨부 파일을 확인해 주세요)") + fileNote(others), text_elements: [] });
      const params: TurnStartParams = {
        threadId,
        input: items,
        model: this.opts.model || null,
        // The OS token may be elevated; sandbox writes still require our approval on every role.
        approvalPolicy: this.opts.readOnly || input.noWrites ? "never" : "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
      const r = await this.server.request<TurnStartResponse>("turn/start", params);
      this.turnKnown(r.turn.id);
    } catch (e) {
      this._running = false;
      const raw = e instanceof Error ? e.message : String(e);
      const message = /active writer|thread-store conflict/i.test(raw)
        ? "다른 프로그램(Codex 앱 등)이 이 대화를 열고 있습니다. Codex 앱에서 이 대화를 닫은 뒤 다시 보내 주세요."
        : raw;
      this.host.emit({ type: "error", kind: "process", message: message === raw ? `${raw} ${this.server.stderrTail.slice(-300)}`.trim() : message });
      this.host.emit({ type: "turn_end", ok: false, error: message });
      this.finishTurn({ text: "", files: [], status: "failed", error: message });
    }
  }

  /** Resolves when the current (or next) turn completes, with its final text and changed files. */
  waitTurn(): Promise<CodexTurnResult> {
    return new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  private finishTurn(r: CodexTurnResult) {
    const waiters = this.turnWaiters;
    this.turnWaiters = [];
    for (const w of waiters) w(r);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    // Stop pressed before turn/start answered: interrupt as soon as the turn id is known.
    if (!this.threadId || !this.turnId) {
      this.stopRequested = true;
      return;
    }
    const params: TurnInterruptParams = { threadId: this.threadId, turnId: this.turnId };
    await this.server.request("turn/interrupt", params).catch(() => undefined);
  }

  private stopRequested = false;

  private turnKnown(id: string) {
    this.turnId = id;
    if (this.stopRequested) {
      this.stopRequested = false;
      void this.stop();
    }
  }

  onServerRequest(req: ServerRequest): boolean {
    switch (req.method) {
      case "item/commandExecution/requestApproval": {
        const p = req.params;
        const cmd = innerCommand(p.command ?? "");
        void this.host
          .approve({
            title: "명령 실행",
            detail: cmd || JSON.stringify(p.commandActions),
            reason: p.reason ?? undefined,
            key: `cmd:${cmd.trim().split(/\s+/)[0] ?? ""}`,
            command: cmd,
            paths: p.cwd ? [p.cwd] : [],
          })
          .then(({ verdict: v }) => {
            const decision: CommandExecutionApprovalDecision = v === "deny" ? "decline" : "accept";
            this.server.respond(req.id, { decision });
          }).catch(() => this.server.respond(req.id, { decision: "decline" }));
        return true;
      }
      case "item/fileChange/requestApproval": {
        const p = req.params;
        const diffs = this.fileItems.get(p.itemId) ?? [];
        void this.host
          .approve({
            title: "파일 변경",
            detail: diffs.map((d) => `${d.kind} ${d.path}${d.movePath ? ` → ${d.movePath}` : ""}`).join("\n") || p.grantRoot || "",
            reason: p.reason ?? undefined,
            key: "fileChange",
            // grantRoot describes the approval root, not an additional file being modified.
            paths: diffs.length ? diffs.flatMap((d) => d.movePath ? [d.path, d.movePath] : [d.path]) : p.grantRoot ? [p.grantRoot] : [],
            diffs,
            writes: true,
          })
          .then(({ verdict: v }) => {
            const decision: FileChangeApprovalDecision = v === "deny" ? "decline" : "accept";
            this.server.respond(req.id, { decision });
          }).catch(() => this.server.respond(req.id, { decision: "decline" }));
        return true;
      }
      case "item/permissions/requestApproval":
        // A broad grant would bypass later scope/policy checks. Approve the concrete command or patch instead.
        this.server.respond(req.id, { permissions: {}, scope: "turn" });
        this.host.emit({ type: "notice", text: "권한 일괄 부여 대신 실제 파일 변경·명령별로 승인합니다." });
        return true;
      default:
        return false;
    }
  }

  onNotification(n: ServerNotification) {
    switch (n.method) {
      case "thread/tokenUsage/updated": {
        if (!this._running || (this.turnId && this.turnId !== n.params.turnId)) break;
        const { total, last } = n.params.tokenUsage;
        const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens"] as const;
        const reset = this.tokenBase && fields.some((k) => total[k] < this.tokenBase![k]);
        const approximate = !this.tokenBase || !!reset || this.metrics?.approximate;
        if (!this.tokenBase || reset) this.tokenBase = Object.fromEntries(fields.map((k) => [k, Math.max(0, total[k] - last[k])])) as unknown as TokenCounts;
        this.tokenTotal = { ...total };
        const counts = Object.fromEntries(fields.map((k) => [k, Math.max(0, total[k] - this.tokenBase![k])])) as unknown as TokenCounts;
        this.metrics = { ...counts, turnId: n.params.turnId, elapsedMs: Date.now() - this.startedAt, model: this.opts.model, approximate, total, nativeId: this.threadId ?? undefined };
        this.host.emit({ type: "agent_usage", metrics: this.metrics });
        break;
      }
      case "item/agentMessage/delta":
        this.host.emit({ type: "text_delta", text: n.params.delta });
        break;
      case "item/started":
        this.onItem(n.params.item, false);
        break;
      case "item/completed":
        this.onItem(n.params.item, true);
        break;
      case "turn/started":
        this.turnKnown(n.params.turn.id);
        break;
      case "turn/plan/updated":
        // Codex's native update_plan checklist → plan card.
        this.host.emit({
          type: "plan_update",
          steps: n.params.plan.map((p) => ({ title: p.step, status: p.status })),
          explanation: n.params.explanation ?? undefined,
        });
        break;
      case "turn/completed": {
        const t = n.params.turn;
        if (this.turnId && t.id !== this.turnId) break;
        this._running = false;
        if (this.metrics) this.host.emit({ type: "agent_usage", metrics: { ...this.metrics, elapsedMs: Date.now() - this.startedAt } });
        this.turnId = undefined;
        this.host.emit({ type: "turn_end", ok: t.status === "completed" && !this.imageFailure, interrupted: t.status === "interrupted", error: this.imageFailure ?? t.error?.message });
        this.finishTurn({
          text: this.turnText.trim(),
          files: [...this.turnFiles],
          status: t.status === "inProgress" || this.imageFailure ? "failed" : t.status,
          error: this.imageFailure ?? t.error?.message,
        });
        break;
      }
      case "error":
        if (!n.params.willRetry) this.host.emit({ type: "error", message: n.params.error.message });
        break;
    }
  }

  private onItem(item: ThreadItem, done: boolean) {
    switch (item.type) {
      case "imageGeneration": {
        if (!done) {
          this.host.emit({ type: "image_generation", id: item.id, status: "running", prompt: item.revisedPrompt ?? undefined });
          break;
        }
        try {
          if (item.failure || item.status === "failed" || item.status === "cancelled")
            throw new Error(item.failure?.type ?? `이미지 생성 ${item.status}`);
          const attachment = this.host.image?.({ id: item.id, path: item.savedPath, base64: item.result });
          if (!attachment) throw new Error("이미지 결과 파일을 저장하지 못했습니다.");
          this.turnFiles.add(attachment.path);
          this.host.emit({ type: "image_generation", id: item.id, status: "done", prompt: item.revisedPrompt ?? undefined, attachment });
        } catch (e) {
          this.imageFailure = e instanceof Error ? e.message : String(e);
          this.host.emit({ type: "image_generation", id: item.id, status: "error", error: this.imageFailure });
        }
        break;
      }
      case "collabAgentToolCall":
      case "subAgentActivity":
        if (!done) {
          this.host.emit({ type: "error", message: "앱 외부의 내부 작업자 호출이 감지되었습니다. 이 호출의 전체 대화는 앱에 저장되지 않습니다. 앱의 spawn/ask를 사용하세요." });
          void this.stop();
        }
        break;
      case "agentMessage":
        if (done && item.text) {
          this.turnText = item.text; // the last message of a turn is its answer
          this.host.emit({ type: "text", text: item.text });
        }
        break;
      case "commandExecution":
        if (!done) this.host.emit({ type: "tool_call", id: item.id, name: "명령", input: innerCommand(item.command) });
        else
          this.host.emit({
            type: "tool_result",
            id: item.id,
            ok: item.status === "completed" && (item.exitCode ?? 0) === 0,
            output: item.status === "declined" ? "(거부됨)" : (item.aggregatedOutput ?? ""),
          });
        break;
      case "fileChange": {
        const diffs = toDiffs(item.changes);
        this.fileItems.set(item.id, diffs);
        if (!done) this.host.emit({ type: "tool_call", id: item.id, name: "파일 변경", input: diffs.map((d) => d.path).join("\n"), diffs });
        if (done) {
          if (item.status === "completed") for (const d of diffs) {
            this.turnFiles.add(d.path);
            if (d.movePath) this.turnFiles.add(d.movePath);
          }
          this.host.emit({ type: "tool_result", id: item.id, ok: item.status === "completed", output: item.status === "completed" ? "파일 변경 적용" : "파일 변경 미적용" });
          this.host.emit({ type: "file_change", id: item.id, files: diffs, ok: item.status === "completed" });
        }
        break;
      }
      case "mcpToolCall":
        if (!done)
          this.host.emit({ type: "tool_call", id: item.id, name: `${item.server}.${item.tool}`, input: JSON.stringify(item.arguments, null, 2) });
        else
          this.host.emit({
            type: "tool_result",
            id: item.id,
            ok: !item.error,
            output: item.error ? JSON.stringify(item.error) : JSON.stringify(item.result?.content ?? []),
          });
        break;
    }
  }

  onServerExit(why: string) {
    this.approvals.clear();
    if (this._running) {
      this._running = false;
      this.host.emit({ type: "error", kind: "process", message: why });
      this.host.emit({ type: "turn_end", ok: false, error: why });
      this.finishTurn({ text: this.turnText, files: [...this.turnFiles], status: "failed", error: why });
    }
  }

  async dispose(): Promise<void> {
    if (this.threadId) { this.server.detach(this.threadId); this.server.loaded.delete(this.threadId); }
  }
}

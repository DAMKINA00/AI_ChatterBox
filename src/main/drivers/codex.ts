// Codex driver: one shared `codex app-server` process (JSON-RPC over stdio, one JSON object per line),
// one CodexDriver per thread.
import { spawn, type ChildProcess } from "node:child_process";
import type { ApprovalDecision } from "../../shared/types";
import { readLines, shutdown } from "../proc";
import type { AgentDriver, DriverCallbacks, DriverOptions } from "./types";
import type { RequestId, ServerNotification, ServerRequest, InitializeResponse, ClientRequest } from "../codex-schema";
import type {
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
} from "../codex-schema/v2";

type Method = ClientRequest["method"];

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

  constructor(private exePath: string) {}

  ensure(): Promise<void> {
    if (this.ready && this.child) return this.ready;
    this.loaded.clear();
    const child = spawn(this.exePath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
      const r = await this.request<InitializeResponse>("initialize", {
        clientInfo: { name: "ai_chatterbox", title: "AI_ChatterBox", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      console.log(`[codex] app-server ready: ${r.userAgent}`);
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

export class CodexDriver implements AgentDriver {
  readonly agent = "codex" as const;
  private threadId: string | null;
  private turnId?: string;
  private running = false;
  private approvals = new Map<string, { requestId: RequestId; kind: "command" | "file" }>();
  private fileItems = new Map<string, string>();

  constructor(
    private opts: DriverOptions,
    private server: CodexServer,
    private cb: DriverCallbacks,
  ) {
    this.threadId = opts.nativeId;
    if (this.threadId) server.attach(this.threadId, this);
  }

  private async ensureThread(): Promise<string> {
    await this.server.ensure();
    if (!this.threadId) {
      const params: ThreadStartParams = { cwd: this.opts.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" };
      const r = await this.server.request<ThreadStartResponse>("thread/start", params);
      this.threadId = r.thread.id;
      this.server.attach(this.threadId, this);
      this.server.loaded.add(this.threadId);
      this.cb.onNativeId(this.threadId);
    } else if (!this.server.loaded.has(this.threadId)) {
      const params: ThreadResumeParams = { threadId: this.threadId, excludeTurns: true };
      this.server.attach(this.threadId, this);
      await this.server.request("thread/resume", params);
      this.server.loaded.add(this.threadId);
    }
    return this.threadId;
  }

  async send(text: string): Promise<void> {
    if (this.running) throw new Error("이전 응답이 아직 진행 중입니다.");
    this.running = true;
    try {
      const threadId = await this.ensureThread();
      const params: TurnStartParams = { threadId, input: [{ type: "text", text, text_elements: [] }] };
      const r = await this.server.request<TurnStartResponse>("turn/start", params);
      this.turnId = r.turn.id;
    } catch (e) {
      this.running = false;
      const message = e instanceof Error ? e.message : String(e);
      this.cb.onEvent({ type: "error", kind: "process", message: `${message} ${this.server.stderrTail.slice(-500)}`.trim() });
      this.cb.onEvent({ type: "turn_end", ok: false, error: message });
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.threadId || !this.turnId) return;
    this.denyAllPending();
    const params: TurnInterruptParams = { threadId: this.threadId, turnId: this.turnId };
    await this.server.request("turn/interrupt", params).catch(() => undefined);
  }

  onServerRequest(req: ServerRequest): boolean {
    switch (req.method) {
      case "item/commandExecution/requestApproval": {
        const id = `codex:${req.id}`;
        this.approvals.set(id, { requestId: req.id, kind: "command" });
        const p = req.params;
        this.cb.onEvent({
          type: "approval_request",
          request: { id, title: "명령 실행", detail: p.command ?? JSON.stringify(p.commandActions), reason: p.reason ?? undefined },
        });
        return true;
      }
      case "item/fileChange/requestApproval": {
        const id = `codex:${req.id}`;
        this.approvals.set(id, { requestId: req.id, kind: "file" });
        const p = req.params;
        this.cb.onEvent({
          type: "approval_request",
          request: { id, title: "파일 변경", detail: this.fileItems.get(p.itemId) ?? p.grantRoot ?? "", reason: p.reason ?? undefined },
        });
        return true;
      }
      default:
        return false;
    }
  }

  answerApproval(approvalId: string, decision: ApprovalDecision): void {
    const a = this.approvals.get(approvalId);
    if (!a) return;
    this.approvals.delete(approvalId);
    const result =
      a.kind === "command"
        ? { decision: (decision === "allow" ? "accept" : "decline") satisfies CommandExecutionApprovalDecision }
        : { decision: (decision === "allow" ? "accept" : "decline") satisfies FileChangeApprovalDecision };
    this.server.respond(a.requestId, result);
    this.cb.onEvent({ type: "approval_resolved", id: approvalId, decision });
  }

  private denyAllPending() {
    for (const id of [...this.approvals.keys()]) this.answerApproval(id, "deny");
  }

  onNotification(n: ServerNotification) {
    switch (n.method) {
      case "item/agentMessage/delta":
        this.cb.onEvent({ type: "text_delta", text: n.params.delta });
        break;
      case "item/started":
        this.onItem(n.params.item, false);
        break;
      case "item/completed":
        this.onItem(n.params.item, true);
        break;
      case "turn/started":
        this.turnId = n.params.turn.id;
        break;
      case "turn/completed": {
        const t = n.params.turn;
        if (this.turnId && t.id !== this.turnId) break;
        this.running = false;
        this.turnId = undefined;
        this.cb.onEvent({
          type: "turn_end",
          ok: t.status === "completed",
          interrupted: t.status === "interrupted",
          error: t.error?.message,
        });
        break;
      }
      case "error":
        if (!n.params.willRetry) this.cb.onEvent({ type: "error", message: n.params.error.message });
        break;
    }
  }

  private onItem(item: ThreadItem, done: boolean) {
    switch (item.type) {
      case "agentMessage":
        if (done && item.text) this.cb.onEvent({ type: "text", text: item.text });
        break;
      case "commandExecution":
        if (!done) this.cb.onEvent({ type: "tool_call", id: item.id, name: "명령", input: item.command });
        else
          this.cb.onEvent({
            type: "tool_result",
            id: item.id,
            ok: item.status === "completed" && (item.exitCode ?? 0) === 0,
            output: item.status === "declined" ? "(거부됨)" : (item.aggregatedOutput ?? ""),
          });
        break;
      case "fileChange": {
        const summary = item.changes.map((c) => `${c.kind.type} ${c.path}`).join("\n");
        this.fileItems.set(item.id, summary);
        if (done) this.cb.onEvent({ type: "file_change", id: item.id, summary, ok: item.status === "completed" });
        break;
      }
      case "mcpToolCall":
        if (!done)
          this.cb.onEvent({ type: "tool_call", id: item.id, name: `${item.server}.${item.tool}`, input: JSON.stringify(item.arguments, null, 2) });
        else
          this.cb.onEvent({
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
    if (this.running) {
      this.running = false;
      this.cb.onEvent({ type: "error", kind: "process", message: why });
      this.cb.onEvent({ type: "turn_end", ok: false, error: why });
    }
  }

  async dispose(): Promise<void> {
    this.denyAllPending();
    if (this.threadId) this.server.detach(this.threadId);
  }
}

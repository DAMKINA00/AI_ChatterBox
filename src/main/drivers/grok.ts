// Official Grok ACP transport. Per-session hooks keep every tool behind ChatterBox approvals.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { readLines, shutdown } from "../proc";
import { isReadCommand } from "../execution-policy";
import { claudeToolDiffs } from "../diffs";
import { publishGeneratedImages } from "./generated-images";
import type { FileDiff, ModelOption } from "../../shared/types";
import { fileNote, type AgentDriver, type AgentInput, type DriverHost, type DriverOptions } from "./types";

export function grokModels(state: any): ModelOption[] {
  return (Array.isArray(state?.availableModels) ? state.availableModels : []).filter((m: any) => typeof m.modelId === "string").map((m: any) => ({
    id: m.modelId, label: m.name || m.modelId, isDefault: m.modelId === state.currentModelId,
    reasoningEfforts: (m._meta?.reasoningEfforts ?? []).map((e: any) => typeof e === "string" ? e : e.value ?? e.id).filter((e: unknown) => typeof e === "string"),
    defaultReasoningEffort: m._meta?.reasoningEffort,
  }));
}

class GrokConnection {
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private closed = false;
  constructor(exe: string, cwd: string, instructions = "", private incoming: (message: any) => Promise<any> = async () => { throw new Error("Unsupported Grok callback"); }, private exited: (error: Error) => void = () => {}) {
    this.child = spawn(exe, ["--permission-mode", "default", "--no-subagents", ...(instructions ? ["--rules", instructions] : []), "agent", "stdio"], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stderr = "";
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (s: string) => { stderr = (stderr + s).slice(-1500); });
    const fail = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear(); this.exited(error);
    };
    this.child.on("error", fail);
    this.child.stdin!.on("error", fail);
    this.child.on("exit", code => fail(new Error(`Grok 종료 (${code}): ${stderr}`)));
    readLines(this.child, line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        void this.incoming(message).then(result => {
          if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
        }).catch(error => {
          if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } });
        });
      } else {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) p?.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else p?.resolve(message.result);
      }
    });
  }
  private write(message: unknown) { if (!this.closed && this.child.stdin?.writable) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method: string, params: unknown, timeout = 45000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Grok 연결이 종료되었습니다."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Grok ${method} 시간 초과`)); }, timeout) : undefined;
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
  async close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("Grok 연결이 종료되었습니다."));
    this.pending.clear();
    await shutdown(this.child, 1000);
  }
}

const initialize = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "AI_ChatterBox", version: "0.4.10" } };

export function grokAuthMethod(init: any): string | undefined {
  const method = init?._meta?.defaultAuthMethodId ?? init?.authMethods?.find((m: any) => m.id === "cached_token")?.id;
  return ["cached_token", "xai.api_key"].includes(method) ? method : undefined;
}

/** Checks existing credentials headlessly; never opens a login or sends a prompt. */
export async function readGrokAuth(exe: string, cwd: string): Promise<"authenticated" | "required" | "unknown"> {
  const connection = new GrokConnection(exe, cwd);
  try {
    const init = await connection.request("initialize", initialize, 10000);
    const methodId = grokAuthMethod(init);
    if (!methodId) return "required";
    await connection.request("authenticate", { methodId, _meta: { headless: true } }, 10000);
    return "authenticated";
  } catch { return "unknown"; }
  finally { await connection.close(); }
}

export async function listGrokModels(exe: string, cwd: string): Promise<ModelOption[]> {
  const connection = new GrokConnection(exe, cwd);
  try {
    const init = await connection.request("initialize", initialize);
    const result = await connection.request("x.ai/models/list", {}).catch(() => null);
    const models = grokModels(result?.result ?? init._meta?.modelState);
    if (!models.length) throw new Error("Grok 모델 목록을 확인하지 못했습니다. grok login 후 다시 확인하세요.");
    return models;
  } finally { await connection.close(); }
}

export class GrokDriver implements AgentDriver {
  readonly agent = "grok" as const;
  private connection?: GrokConnection;
  private nativeId: string | null;
  private _running = false;
  private epoch = 0;
  private noWrites = false;
  private text = "";
  private approved = new Set<string>();
  private diffs = new Map<string, FileDiff[]>();
  private images = new Set<string>();
  private imageCalls = new Set<string>();
  constructor(private opts: DriverOptions, private mcpServers: () => Record<string, any>, private host: DriverHost) { this.nativeId = opts.nativeId; }
  get running() { return this._running; }

  /** Public for protocol tests. Errors and permission timeouts return a denial, never fail-open. */
  async hook(p: any): Promise<any> {
    const deny = (reason: string) => ({ decision: "deny", reason });
    const epoch = this.epoch;
    if (!this.running || p?.sessionId !== this.nativeId) return deny("실행 중인 ChatterBox 작업이 아닙니다.");
    if (p.hookEventName !== "pre_tool_use" || typeof p.toolUseId !== "string") return deny("지원하지 않는 승인 요청입니다.");
    if (p.hookCallbackId !== "chatterbox-approval" || p.toolInputTruncated) return deny("도구 입력을 확인하지 못했습니다.");
    const name = p.toolName, args = p.toolInput;
    if (typeof name !== "string" || !args || typeof args !== "object") return deny("잘못된 도구 요청입니다.");
    if (this.opts.readOnly) return deny("승인 판단 세션은 도구를 사용하지 않습니다.");
    if (/^(?:spawn_agent|spawn_subagent|subagent|agent|task|delegate_task)$/i.test(name)) return deny("작업자 협업은 ChatterBox 도구를 사용하세요.");
    if (/^(?:mcp__)?chatterbox_bridge(?:__|\/)/.test(name)) { this.approved.add(p.toolUseId); return { decision: "continue" }; }
    const command = typeof args.command === "string" && /terminal|shell|bash|command/i.test(name) ? args.command : undefined;
    const paths = [args.file_path, args.path, args.target_file, args.output_path, args.cwd].filter((v): v is string => typeof v === "string").map(p => resolve(this.opts.cwd, p));
    const writing = /^(?:write_file|create_file|edit_file|search_replace|replace_in_file|apply_patch|delete_file|Write|Edit|MultiEdit)$/i.test(name);
    const image = /^(?:image_gen|image_edit|imagegen|generate_image|edit_image)$/i.test(name);
    const readOnly = /^(?:read_file|read_files|list_files|list_dir|list_directory|search|grep|glob|web_search|web_fetch|Read|Grep|Glob)$/i.test(name);
    if (this.noWrites && !readOnly && !(command && isReadCommand(command))) return deny("계획·리뷰·의견 중에는 변경 도구를 실행할 수 없습니다.");
    if (image && this.opts.allowImages === false) return deny("이미지 생성은 지정한 앱 작업자에게 배정하세요.");
    const diffs = writing && args.file_path ? claudeToolDiffs(/edit|replace/i.test(name) ? "Edit" : "Write", args, this.opts.cwd) : undefined;
    const id = String(p.toolUseId);
    this.host.emit({ type: "tool_call", id, name: command ? "PowerShell" : name, input: command ?? JSON.stringify(args), diffs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        // Native image_gen/image_edit save session artifacts; an explicit output destination is still a scoped write.
        this.host.approve({ title: name, detail: command ?? JSON.stringify(args), key: name, command, paths, diffs, writes: writing || (image ? !!args.output_path : !readOnly && !command), readOnly }),
        new Promise<{ verdict: "deny"; reason: string }>(resolve => { timer = setTimeout(() => resolve({ verdict: "deny", reason: "승인 대기 시간이 초과되었습니다. 다시 요청하세요." }), 540_000); }),
      ]);
      if (!this.running || epoch !== this.epoch || answer.verdict === "deny") return deny(answer.reason || "도구 실행이 거부되었습니다.");
      this.approved.add(id);
      if (image) this.imageCalls.add(id);
      if (diffs?.length) this.diffs.set(id, diffs);
      return { decision: "continue" };
    } catch (error) { return deny(String(error)); }
    finally { clearTimeout(timer); }
  }

  private async incoming(message: any) {
    const p = message.params;
    if (message.method === "x.ai/hooks/run") {
      try { return await this.hook(p); }
      catch (error) { return { decision: "deny", reason: String(error) }; }
    }
    if (message.method === "session/request_permission") {
      const allowed = this.running && p?.sessionId === this.nativeId && this.approved.has(p.toolCall?.toolCallId);
      const option = p.options?.find((o: any) => o.kind === (allowed ? "allow_once" : "reject_once"));
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    }
    if (message.method === "session/update") { this.onUpdate(p); return {}; }
    if (message.id !== undefined) throw new Error(`지원하지 않는 Grok 요청: ${message.method}`);
    return {};
  }

  onUpdate(p: any) {
    if (!this.running || p.sessionId !== this.nativeId) return;
    const u = p.update;
    if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
      this.text += u.content.text; this.host.emit({ type: "text_delta", text: u.content.text });
    }
    if (["tool_call", "tool_call_update"].includes(u?.sessionUpdate)) {
      const id = u.toolCallId;
      if (u.status === "completed" || u.status === "failed") {
        this.host.emit({ type: "tool_result", id, ok: u.status === "completed", output: JSON.stringify(u.content ?? u.rawOutput ?? "완료") });
        const files = this.diffs.get(id);
        if (files) this.host.emit({ type: "file_change", id, files, ok: u.status === "completed" });
        this.diffs.delete(id); this.approved.delete(id);
      }
      if (u.status === "completed" && this.imageCalls.has(id)) {
        publishGeneratedImages([u.content, u.rawOutput], id, this.host);
        this.imageCalls.delete(id);
      }
      if (u.status === "failed") this.imageCalls.delete(id);
    }
    if (u?.sessionUpdate === "agent_message_chunk") this.image(u.content, `grok:${this.images.size}`);
  }
  private image(content: any, id: string) {
    if (content?.type !== "image" || typeof content.data !== "string" || this.images.has(content.data) || !this.host.image) return;
    this.images.add(content.data);
    try { this.host.emit({ type: "image_generation", id, status: "done", attachment: this.host.image({ id, base64: content.data }) }); }
    catch (error) { this.host.emit({ type: "image_generation", id, status: "error", error: String(error) }); }
  }
  private async start(epoch: number) {
    const connection = new GrokConnection(this.opts.exePath, this.opts.cwd, this.opts.instructions,
      m => this.connection === connection ? this.incoming(m) : Promise.resolve({ decision: "deny", reason: "종료된 연결입니다." }), error => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.finish(false, error.message);
    });
    this.connection = connection;
    const init = await connection.request("initialize", initialize);
    if (epoch !== this.epoch) throw new Error("Grok 실행이 취소되었습니다.");
    const hooks = init.agentCapabilities?._meta?.["x.ai/hooks"];
    if (!hooks?.blockingEvents?.includes("pre_tool_use") || !hooks.decisions?.includes("deny")) throw new Error("Grok CLI를 업데이트하세요. 도구 승인 hook을 지원해야 합니다.");
    const methodId = grokAuthMethod(init);
    if (!methodId) throw new Error("Grok 로그인이 필요합니다. 터미널에서 grok login을 완료한 뒤 다시 실행하세요.");
    await connection.request("authenticate", { methodId, _meta: { headless: true } });
    const mcpServers = Object.entries(this.mcpServers()).map(([name, s]) => ({ name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value: String(value) })) }));
    const params = { cwd: this.opts.cwd, mcpServers, _meta: { "x.ai/hooks": { PreToolUse: [{ hookCallbackIds: ["chatterbox-approval"], timeout: 600 }] } } };
    const session = await connection.request(this.nativeId ? "session/load" : "session/new", { ...params, ...(this.nativeId ? { sessionId: this.nativeId } : {}) });
    if (epoch !== this.epoch) throw new Error("Grok 실행이 취소되었습니다.");
    this.nativeId = session.sessionId ?? this.nativeId;
    if (!this.nativeId) throw new Error("Grok 세션 ID를 확인하지 못했습니다.");
    this.host.nativeId(this.nativeId);
    const modelId = this.opts.model || session.models?.currentModelId || init._meta?.modelState?.currentModelId;
    if (modelId) await connection.request("session/set_model", { sessionId: this.nativeId, modelId, _meta: { reasoningEffort: this.opts.effort || undefined } });
  }
  async send(input: AgentInput) {
    if (this.running) throw new Error("Grok 작업자가 이미 실행 중입니다.");
    this._running = true; this.noWrites = !!input.noWrites || !!this.opts.readOnly; this.text = ""; this.approved.clear(); this.images.clear(); this.imageCalls.clear(); this.diffs.clear();
    const epoch = ++this.epoch;
    try { if (!this.connection) await this.start(epoch); }
    catch (error) {
      if (epoch !== this.epoch) return;
      const connection = this.connection;
      this.connection = undefined; this._running = false;
      await connection?.close();
      throw error;
    }
    if (epoch !== this.epoch) return;
    const text = `[AI_ChatterBox 작업 지시]\n${this.opts.instructions ?? ""}\n${input.text}${fileNote(input.attachments)}`;
    void this.connection!.request("session/prompt", { sessionId: this.nativeId, prompt: [{ type: "text", text }] }, 0).then(result => {
      if (epoch !== this.epoch) return;
      if (this.text) this.host.emit({ type: "text", text: this.text });
      this.finish(result.stopReason === "end_turn", result.stopReason === "end_turn" ? undefined : `Grok 종료 사유: ${result.stopReason}`);
    }).catch(error => { if (epoch === this.epoch) this.finish(false, String(error)); });
  }
  private finish(ok: boolean, error?: string, interrupted = false) {
    if (!this.running) return;
    this._running = false;
    if (error) this.host.emit({ type: "error", kind: "process", message: error });
    this.host.emit({ type: "turn_end", ok, error, interrupted });
  }
  async stop() {
    ++this.epoch;
    const connection = this.connection;
    this.connection = undefined;
    connection?.notify("session/cancel", { sessionId: this.nativeId });
    this.finish(false, undefined, true);
    await connection?.close();
  }
  async dispose() { await this.stop(); }
}

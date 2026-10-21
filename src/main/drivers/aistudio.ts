import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AIStudioService } from "../aistudio";
import type { ToolDef } from "../local-bridge";
import { claudeToolDiffs } from "../diffs";
import { isReadCommand } from "../execution-policy";
import { killTree } from "../proc";
import { fileNote, type AgentDriver, type AgentInput, type DriverHost, type DriverOptions } from "./types";

export interface StudioMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: { google: { thought_signature: string } } }[];
  tool_call_id?: string;
}
export interface StudioContext { load(): StudioMessage[]; save(messages: StudioMessage[]): void }
interface StudioEnv {
  service: Pick<AIStudioService, "response" | "json"> & Partial<Pick<AIStudioService, "ensureReady">> & { settings(): { model: string; videoEnabled: boolean } };
  provider?: "gemini" | "deepseek";
  context?: StudioContext;
  bridgeUrl?: () => string | undefined;
}
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
export const STUDIO_TOOLS: ToolDef[] = [
  { name: "read_file", description: "Read a UTF-8 file in the project. Use offset/limit for large files (line numbers start at 1).", inputSchema: schema({ path: str, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["path"]) },
  { name: "list_directory", description: "List direct children of a project directory.", inputSchema: schema({ path: str }, ["path"]) },
  { name: "write_file", description: "Create or replace a UTF-8 project file after ChatterBox approval.", inputSchema: schema({ path: str, content: str }, ["path", "content"]) },
  { name: "edit_file", description: "Replace one exact, unique string in a UTF-8 project file after approval.", inputSchema: schema({ path: str, old_string: str, new_string: str }, ["path", "old_string", "new_string"]) },
  { name: "run_command", description: "Run a PowerShell command in the project after ChatterBox approval. Check exit code; do not claim tests passed if nonzero.", inputSchema: schema({ command: str, timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 } }, ["command"]) },
];
const VIDEO_TOOLS: ToolDef[] = [
  { name: "generate_video", description: "Generate a video only when explicitly requested by the user. Consumes video quota. Returns a job ID; this is not proof of completion. Choose an available video model ID.", inputSchema: schema({ model: str, prompt: str, seconds: { type: "integer", enum: [4, 6, 8] }, size: { type: "string", enum: ["1280x720", "720x1280"] } }, ["model", "prompt"]) },
  { name: "video_status", description: "Read an existing video job. Does not generate any new video.", inputSchema: schema({ id: str }, ["id"]) },
  { name: "save_video", description: "Save an already completed video as a project MP4 file after approval. Never generates a new video.", inputSchema: schema({ id: str, path: str }, ["id", "path"]) },
];

/** Parse OpenAI SSE without treating a dropped stream or partial tool call as success. */
export async function studioCompletion(response: Response, signal: AbortSignal, delta: (text: string) => void, label = "AI Studio") {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error(`${label}가 스트리밍 응답을 반환하지 않았습니다.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} 응답이 비어 있습니다.`);
  const decoder = new TextDecoder(); let pending = "", content = "", reasoning = "", finish = "", done = false;
  let usage: any;
  const calls = new Map<number, NonNullable<StudioMessage["tool_calls"]>[number]>();
  const accept = (event: string) => {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    const value = JSON.parse(data);
    if (value.error) throw new Error(`${label} 스트림 오류가 발생했습니다.`);
    if (value.usage) usage = value.usage;
    const choice = value.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    if (typeof choice.delta?.content === "string") { content += choice.delta.content; delta(choice.delta.content); }
    if (typeof choice.delta?.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
    for (const piece of choice.delta?.tool_calls ?? []) {
      if (!Number.isInteger(piece.index) || piece.index < 0 || piece.index > 100) throw new Error("AI Studio 도구 호출 순서가 잘못되었습니다.");
      const call: NonNullable<StudioMessage["tool_calls"]>[number] = calls.get(piece.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
      if (typeof piece.extra_content?.google?.thought_signature === "string") call.extra_content = { google: { thought_signature: piece.extra_content.google.thought_signature } };
      if (call.function.arguments.length > 2_000_000) throw new Error("AI Studio 도구 입력이 너무 큽니다.");
      calls.set(piece.index, call);
    }
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 4_000_000 || content.length + reasoning.length > 8_000_000) throw new Error(`${label} 응답이 너무 큽니다.`);
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) { accept(pending.slice(0, boundary.index).replace(/\r\n/g, "\n")); pending = pending.slice(boundary.index + boundary[0].length); }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
  } finally { await reader.cancel().catch(() => undefined); }
  signal.throwIfAborted();
  if (!done || !["stop", "tool_calls"].includes(finish)) throw new Error(`${label} 응답이 완료되지 않았습니다 (${finish || "연결 종료"}).`);
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  if (tool_calls.some(c => !c.id || !c.function.name) || (finish === "tool_calls") !== (tool_calls.length > 0)) throw new Error("AI Studio 도구 호출을 완전히 받지 못했습니다.");
  return { message: { role: "assistant", content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tool_calls.length ? { tool_calls } : {}) } as StudioMessage, usage };
}

export class ChatCompletionDriver implements AgentDriver {
  get agent() { return this.env.provider ?? "gemini"; }
  private get label() { return this.agent === "deepseek" ? "DeepSeek" : "AI Studio"; }
  private controller?: AbortController;
  private task?: Promise<void>;
  private disposed = false;
  private history: StudioMessage[];
  constructor(private opts: DriverOptions, private env: StudioEnv, private host: DriverHost) {
    this.history = env.context?.load() ?? [];
  }
  get running() { return !!this.controller; }
  async send(input: AgentInput) {
    if (this.disposed || this.running) throw new Error(`${this.label} 작업이 진행 중이거나 종료되었습니다.`);
    const controller = new AbortController(); this.controller = controller;
    this.task = this.run(input, controller).finally(() => { if (this.controller === controller) this.controller = undefined; });
  }
  private async run(input: AgentInput, controller: AbortController) {
    const signal = controller.signal, started = Date.now(), turnId = randomUUID();
    let ok = false, error: string | undefined;
    let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0;
    const model = this.opts.model?.replace(/^aistudio:/, "") || this.env.service.settings().model;
    const historyStart = this.history.length;
    try {
      if (this.agent === "gemini") await this.env.service.ensureReady?.(signal, text => {
        if (!signal.aborted) this.host.emit({ type: "notice", text });
      });
      signal.throwIfAborted();
      const catalog = await this.env.service.json("/v1/models", undefined, signal);
      if (!catalog.data?.some((m: any) => m.id === model)) throw new Error(`${this.label} 계정에서 ${model} 모델을 사용할 수 없습니다. 연결과 모델 목록을 확인하세요.`);
      this.history.push({ role: "user", content: input.text + fileNote(input.attachments) });
      const bridgeUrl = this.opts.readOnly ? undefined : this.env.bridgeUrl?.();
      const bridgeTools: ToolDef[] = bridgeUrl ? (await (await fetch(bridgeUrl + "/tools", { signal, redirect: "error" })).json()).tools : [];
      const video = this.agent === "gemini" && this.env.service.settings().videoEnabled && this.opts.allowImages !== false && !this.opts.readOnly && !input.noWrites;
      const tools = this.opts.readOnly ? [] : [...STUDIO_TOOLS, ...(video ? VIDEO_TOOLS : []), ...bridgeTools.map(t => ({ ...t, name: `chatterbox_${t.name}` }))];
      const instructions = `${this.opts.instructions ?? ""}\n실제 작업 폴더: ${this.opts.cwd}\n연결: ${this.label} (${model}). 제공된 도구의 실제 결과만 보고한다. 파일 경로는 작업 폴더 기준이다. ${this.agent === "deepseek" ? "이미지·영상 생성 도구는 제공하지 않는다." : "영상은 사용자가 명시적으로 요청하고 영상 도구가 활성화된 경우에만 생성한다. 요청하지 않은 영상 생성이나 영상 검증 생성은 금지한다."} ${input.noWrites ? "읽기 전용 작업: 파일 수정과 변경 명령 금지." : ""}`;
      for (let round = 0; round < 80; round++) {
        signal.throwIfAborted();
        const response = await this.env.service.response("/v1/chat/completions", {
          model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: instructions }, ...this.history],
          ...(this.agent === "deepseek" ? this.opts.effort === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: this.opts.effort || "high" } : {}),
          ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), parallel_tool_calls: false } : {}),
        }, signal);
        const { message, usage } = await studioCompletion(response, signal, text => this.host.emit({ type: "text_delta", text }), this.label);
        if (this.agent === "deepseek") message.reasoning_content ??= "";
        this.history.push(message);
        if (message.content) this.host.emit({ type: "text", text: message.content });
        if (usage) {
          inputTokens += usage.prompt_tokens ?? 0; outputTokens += usage.completion_tokens ?? 0; cachedInputTokens += usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
          this.host.emit({ type: "agent_usage", metrics: { turnId, model, reasoningEffort: this.opts.effort, elapsedMs: Date.now() - started, inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens: 0 } });
        }
        if (!message.tool_calls?.length) { ok = true; this.persist(); break; }
        const seen = new Set<string>();
        for (const call of message.tool_calls) {
          signal.throwIfAborted();
          if (seen.has(call.id)) throw new Error("중복된 AI Studio 도구 호출입니다.");
          seen.add(call.id);
          let output: string, succeeded = false;
          this.host.emit({ type: "tool_call", id: call.id, name: call.function.name, input: call.function.arguments });
          try {
            const args = JSON.parse(call.function.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args) || !tools.some(t => t.name === call.function.name)) throw new Error("허용되지 않은 도구 또는 잘못된 입력입니다.");
            if (call.function.name.startsWith("chatterbox_") && bridgeUrl) {
              const result = await (await fetch(bridgeUrl + "/call", { method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: call.function.name.slice(11), arguments: args }) })).json();
              output = result.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
              succeeded = !result.isError;
            } else { output = await this.tool(call.function.name, args, call.id, !!input.noWrites, signal); succeeded = true; }
          } catch (e) { signal.throwIfAborted(); output = e instanceof Error ? e.message : String(e); }
          this.host.emit({ type: "tool_result", id: call.id, ok: succeeded, output });
          this.history.push({ role: "tool", tool_call_id: call.id, content: output });
        }
        this.persist();
      }
      if (!ok) throw new Error(`${this.label} 도구 반복 한도에 도달했습니다. 확인된 결과를 유지했으니 이어서 지시하세요.`);
    } catch (e) {
      error = signal.aborted ? `${this.label} 작업이 중지되었습니다.` : e instanceof Error ? e.message : String(e);
      // Close unfinished tool calls without replaying their side effects on resume.
      const answered = new Set(this.history.filter(m => m.role === "tool").map(m => m.tool_call_id));
      const last = this.history.findLast(m => m.tool_calls?.length);
      for (const call of last?.tool_calls ?? []) if (!answered.has(call.id)) this.history.push({ role: "tool", tool_call_id: call.id, content: "중단됨: 완료 여부를 확인하지 못했습니다. 현재 파일과 작업 상태부터 확인하세요." });
      if (this.history.length > historyStart) this.persist();
      if (!signal.aborted) this.host.emit({ type: "error", kind: "process", message: error });
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.host.emit({ type: "turn_end", ok, error, interrupted: signal.aborted });
    }
  }
  private persist() { this.env.context?.save(this.history); }
  private async path(value: unknown) {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("파일 경로가 잘못되었습니다.");
    const root = await realpath(this.opts.cwd), path = resolve(root, value), rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || /(^|[\\/])\.git([\\/]|$)/i.test(rel)) throw new Error("프로젝트 내부의 일반 파일만 사용할 수 있습니다.");
    // Resolve the nearest existing parent too: a symlink/junction must not escape scope.
    let parent = path;
    for (;;) {
      try {
        const actual = await realpath(parent), r = relative(root, actual);
        if (isAbsolute(r) || r === ".." || r.startsWith("..\\") || r.startsWith("../")) throw new Error("프로젝트 밖으로 연결되는 경로는 사용할 수 없습니다.");
        break;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; const up = dirname(parent); if (up === parent) throw e; parent = up; }
    }
    return path;
  }
  private async tool(name: string, args: any, id: string, noWrites: boolean, signal: AbortSignal): Promise<string> {
    const command = name === "run_command" ? args.command : undefined;
    if (name === "run_command" && (typeof command !== "string" || !command.trim() || command.length > 32000)) throw new Error("실행 명령이 잘못되었습니다.");
    const writes = ["write_file", "edit_file", "save_video"].includes(name);
    if (this.opts.readOnly || (noWrites && (writes || name === "generate_video" || (command && !isReadCommand(command))))) throw new Error("읽기 전용 작업에서는 이 도구를 실행할 수 없습니다.");
    const path = ["read_file", "list_directory", "write_file", "edit_file", "save_video"].includes(name) ? await this.path(args.path) : undefined;
    if (name === "write_file" && (typeof args.content !== "string" || args.content.length > 2_000_000)) throw new Error("파일 내용은 2MB 이하의 문자열이어야 합니다.");
    let before: string | undefined;
    if (name === "write_file") {
      try { before = await readFile(path!, "utf8"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (name === "edit_file") {
      if (typeof args.old_string !== "string" || !args.old_string || typeof args.new_string !== "string") throw new Error("교체할 문자열을 정확히 지정하세요.");
      before = await readFile(path!, "utf8");
      if (before.split(args.old_string).length !== 2) throw new Error("교체할 문자열이 없거나 여러 번 나타납니다. 고유한 문자열을 지정하세요.");
    }
    const diffs = name === "write_file" || name === "edit_file" ? claudeToolDiffs(name === "write_file" ? "Write" : "Edit", { file_path: path, ...args }, this.opts.cwd) : undefined;
    const approval = await this.host.approve({ title: name, detail: command ?? JSON.stringify(args), key: name, paths: path ? [path] : [], command, writes: writes || name === "generate_video", readOnly: ["read_file", "list_directory", "video_status"].includes(name), diffs });
    signal.throwIfAborted();
    if (approval.verdict === "deny") throw new Error(approval.reason || "ChatterBox가 도구 실행을 거부했습니다.");
    if (path) await this.path(path);
    switch (name) {
      case "read_file": {
        if ((await stat(path!)).size > 4_000_000) throw new Error("4MB를 넘는 파일입니다. 명령으로 필요한 범위만 조회하세요.");
        const lines = (await readFile(path!, "utf8")).split("\n");
        const offset = Number.isInteger(args.offset) && args.offset >= 1 ? args.offset - 1 : 0;
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 2000) : 300;
        return lines.slice(offset, offset + limit).map((line, i) => `${offset + i + 1}: ${line}`).join("\n").slice(0, 200000);
      }
      case "list_directory": return (await readdir(path!, { withFileTypes: true })).slice(0, 1000).map(e => `${e.isDirectory() ? "directory" : "file"} ${e.name}`).join("\n");
      case "write_file": case "edit_file": {
        if (before !== undefined && await readFile(path!, "utf8") !== before) throw new Error("승인 대기 중 파일이 변경되었습니다. 다시 읽고 수정하세요.");
        await mkdir(dirname(path!), { recursive: true });
        signal.throwIfAborted();
        await writeFile(path!, name === "write_file" ? args.content : before!.replace(args.old_string, () => args.new_string), { encoding: "utf8", flag: name === "write_file" && before === undefined ? "wx" : "w" });
        this.host.emit({ type: "file_change", id, files: diffs ?? [], ok: true });
        return `저장 완료: ${path}`;
      }
      case "run_command": return this.command(command, args.timeout_ms, signal);
      case "generate_video": {
        if (!this.env.service.settings().videoEnabled) throw new Error("영상 생성 도구가 꺼져 있습니다.");
        if (typeof args.model !== "string" || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("영상 모델과 프롬프트가 필요합니다.");
        return JSON.stringify(await this.env.service.json("/v1/videos", { model: args.model, prompt: args.prompt, ...(args.seconds ? { seconds: String(args.seconds) } : {}), ...(args.size ? { size: args.size } : {}) }, signal));
      }
      case "video_status": return JSON.stringify(await this.env.service.json(`/v1/videos/${this.videoId(args.id)}`, undefined, signal));
      case "save_video": {
        if (!path!.toLowerCase().endsWith(".mp4")) throw new Error("영상 저장 경로는 .mp4여야 합니다.");
        const videoId = this.videoId(args.id), status = await this.env.service.json(`/v1/videos/${videoId}`, undefined, signal);
        if (status.status !== "completed") throw new Error("아직 완료되지 않은 영상입니다.");
        const response = await this.env.service.response(`/v1/videos/${videoId}/content`, undefined, signal);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("영상 응답이 비어 있습니다.");
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
            size += part.value.length;
            if (size > 256 * 1024 * 1024) throw new Error("영상 크기가 256MB를 넘습니다.");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        const data = Buffer.concat(chunks, size);
        if (data.length < 8 || data.toString("ascii", 4, 8) !== "ftyp") throw new Error("유효한 MP4 영상을 확인하지 못했습니다.");
        signal.throwIfAborted();
        await mkdir(dirname(path!), { recursive: true }); await writeFile(path!, data, { flag: "wx" });
        this.host.emit({ type: "artifacts", paths: [path!] }); return `영상 저장 완료: ${path}`;
      }
      default: throw new Error("지원하지 않는 AI Studio 도구입니다.");
    }
  }
  private videoId(value: unknown) { if (typeof value !== "string" || !/^[\w-]{1,200}$/.test(value)) throw new Error("영상 ID가 잘못되었습니다."); return encodeURIComponent(value); }
  private command(command: string, requestedTimeout: unknown, signal: AbortSignal) {
    const timeout = typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) ? Math.min(300000, Math.max(1000, requestedTimeout)) : 120000;
    return new Promise<string>((resolveCommand, reject) => {
      const child = spawn(process.platform === "win32" ? "powershell.exe" : "/bin/sh", process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command], { cwd: this.opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", timedOut = false;
      const append = (s: Buffer) => { output = (output + s.toString("utf8")).slice(-200000); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      const abort = () => killTree(child);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      child.once("error", e => { cleanup(); reject(e); });
      child.once("close", code => { cleanup(); if (signal.aborted) reject(signal.reason); else resolveCommand(`exit_code: ${code}${timedOut ? " (timeout)" : ""}\n${output}`); });
      if (signal.aborted) abort();
    });
  }
  async stop() { this.controller?.abort(); await this.task; }
  async dispose() { this.disposed = true; await this.stop(); }
}
export { ChatCompletionDriver as AIStudioDriver };

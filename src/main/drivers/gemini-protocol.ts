import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption, TokenCounts } from "../../shared/types";
import { claudeToolDiffs } from "../diffs";

/** Only account-listed Gemini models; Argon currently requires Ultra in Antigravity. */
export function parseGeminiModels(text: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const m = /^\s*(gemini-[\w.-]+)\s+(.+?)\s*$/.exec(line);
    if (!m || /argon|ultra|locked|unavailable|not available|upgrade|잠김|사용 불가/i.test(line)) continue;
    if (!models.some((x) => x.id === m[1])) models.push({ id: m[1], label: m[2] });
  }
  // Prefer the newest Flash Medium model for predictable Pro usage; retain Pro choices in the picker.
  const flash = models.filter((m) => /-flash-medium$/.test(m.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  if (flash ?? models[0]) (flash ?? models[0]).isDefault = true;
  for (const model of models) {
    const suffix = /-(low|medium|high|xhigh|max)$/.exec(model.id);
    if (!suffix) continue;
    const family = model.id.slice(0, -suffix[0].length);
    model.reasoningEfforts = ["low", "medium", "high", "xhigh", "max"].filter((level) => models.some((m) => m.id === `${family}-${level}`));
    model.defaultReasoningEffort = suffix[1];
  }
  return models;
}

export function geminiEffortModel(model: ModelOption, effort: string | undefined, models: ModelOption[]): ModelOption {
  if (!effort) return model;
  const family = model.id.replace(/-(low|medium|high|xhigh|max)$/, "");
  const selected = models.find((m) => m.id === `${family}-${effort}`);
  if (!selected) throw new Error(`현재 Gemini 계정에서 ${effort} 모델을 사용할 수 없습니다.`);
  return selected;
}

const modelLists = new Map<string, { expires: number; promise: Promise<ModelOption[]> }>();
export async function listGeminiModels(exe: string, cwd: string): Promise<ModelOption[]> {
  const settingsFile = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  let settings: { modelProvider?: string } = {};
  try { if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8")); }
  catch { throw new Error("Antigravity 인증 방식 설정을 읽지 못했습니다. CLI 설정을 확인하세요."); }
  if (settings?.modelProvider === "gemini") throw new Error("Antigravity가 별도 API 키 모드입니다. CLI를 Google AI Pro 계정 로그인 모드로 변경한 뒤 사용하세요.");
  // Header, settings and parallel workers can all ask at once. Share one account
  // request briefly; failures are never cached and account changes refresh in a minute.
  const cached = modelLists.get(exe);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = new Promise<ModelOption[]>((resolve, reject) => {
    execFile(exe, ["models"], { cwd, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const login = /sign in|not logged|authenticate/i.test(stdout + stderr);
        return reject(new Error(login ? "Antigravity에 로그인해 주세요. 터미널에서 agy를 실행하면 Google 계정 로그인을 진행할 수 있습니다." : "Antigravity 모델 목록 조회가 지연되거나 실패했습니다. 네트워크 상태를 확인하고 다시 시도하세요."));
      }
      const list = parseGeminiModels(stdout);
      if (!list.length) return reject(new Error("Pro에서 사용할 수 있는 Gemini 모델을 찾지 못했습니다. Antigravity 로그인과 모델 목록을 확인해 주세요."));
      resolve(list);
    });
  });
  modelLists.set(exe, { expires: Date.now() + 60_000, promise });
  try { return await promise; }
  catch (error) { if (modelLists.get(exe)?.promise === promise) modelLists.delete(exe); throw error; }
}

export const GEMINI_READ_TOOLS = new Set(["view_file", "list_dir", "find_by_name", "grep_search", "view_file_outline", "view_code_item", "search_web", "read_url_content", "view_content_chunk", "list_permissions"]);
export const GEMINI_WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
export const GEMINI_BRIDGE_TOOLS = new Set(["route_request", "gemini_web_accounts", "spawn", "ask", "ask_parallel", "send_message", "read_messages", "release", "agents", "checklist", "update_goal", "ask_user", "set_expression"]);

/** CLI versions use different names for the same native file/command tools. */
export function normalizeGeminiTool(name: string, input: Record<string, unknown>) {
  const field = (...keys: string[]) => {
    const values = keys.flatMap(key => input[key] === undefined ? [] : [input[key]]);
    if (values.some(v => typeof v !== "string") || new Set(values).size > 1) throw new Error("도구 인수의 형식이 잘못되었거나 서로 다른 경로·내용이 중복 지정되었습니다.");
    return values[0] as string | undefined;
  };
  const args = { ...input };
  if (name === "read_file" || name === "write_file") {
    const path = field("path", "file_path", "absolute_path", "AbsolutePath", "TargetFile");
    if (!path?.trim()) throw new Error("파일 경로가 필요합니다.");
    if (name === "read_file") return { name: "view_file", args: { ...args, AbsolutePath: path } };
    const content = field("content", "contents", "CodeContent");
    if (content === undefined) throw new Error("쓸 파일 내용이 필요합니다.");
    return { name: "write_to_file", args: { ...args, TargetFile: path, CodeContent: content } };
  }
  if (name === "run_command") {
    const command = field("CommandLine", "command", "command_line");
    if (!command?.trim()) throw new Error("실행할 명령이 필요합니다.");
    const cwd = field("Cwd", "cwd", "working_directory");
    return { name, args: { ...args, CommandLine: command, ...(cwd === undefined ? {} : { Cwd: cwd }) } };
  }
  return { name, args };
}

export function geminiBridgeTool(name: string, args?: Record<string, unknown>): boolean {
  if (name === "call_mcp_tool") return args?.ServerName === "chatterbox_bridge" && typeof args.ToolName === "string" && GEMINI_BRIDGE_TOOLS.has(args.ToolName);
  const m = /^(?:mcp__|mcp_)?chatterbox_bridge(?:__|\/|_)(\w+)$/.exec(name);
  return !!m && GEMINI_BRIDGE_TOOLS.has(m[1]);
}

export function geminiPaths(args: Record<string, unknown>): string[] {
  return ["TargetFile", "AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath", "Cwd"].flatMap((key) => typeof args[key] === "string" ? [args[key] as string] : []);
}

export function geminiDiffs(name: string, args: any, cwd: string) {
  if (name === "write_to_file") return claudeToolDiffs("Write", { file_path: args.TargetFile, content: args.CodeContent }, cwd);
  if (name === "replace_file_content") return claudeToolDiffs("Edit", { file_path: args.TargetFile, old_string: args.TargetContent, new_string: args.ReplacementContent, replace_all: !!args.AllowMultiple }, cwd);
  if (name === "multi_replace_file_content") return claudeToolDiffs("MultiEdit", { file_path: args.TargetFile, edits: (args.ReplacementChunks ?? []).map((c: any) => ({ old_string: c.TargetContent, new_string: c.ReplacementContent, replace_all: !!c.AllowMultiple })) }, cwd);
  return undefined;
}

const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
export function geminiTokens(usage: any): TokenCounts {
  return { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens) + count(usage?.thinking_tokens), cachedInputTokens: count(usage?.cache_read_tokens), cacheWriteInputTokens: 0 };
}

export function tokenDelta(total: TokenCounts, previous: TokenCounts): TokenCounts {
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - previous[key as keyof TokenCounts])])) as unknown as TokenCounts;
}

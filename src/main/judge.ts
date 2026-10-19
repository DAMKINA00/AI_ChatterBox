// Approval judge: a long-lived, tool-less conversation per chat on the orchestrator's CLI and model.
// The orchestrator's own session is blocked inside a consult tool call while workers ask for
// approvals, so judging happens in this side conversation. It keeps context across requests
// (decisions so far), answers strict JSON, and anything malformed/slow falls back to the user.
import { chatOrchestrator, roleName, CONSULT_KIND_LABEL, type AgentEvent, type ApprovalRequest, type ConsultKind, type Role, type UsageInfo } from "../shared/types";
import type { ChatManager } from "./chats";
import type { ApprovalInput, JudgeAnswer } from "./approvals";
import { join, dirname } from "node:path";
import { GeminiDriver } from "./drivers/gemini";
import { AIStudioDriver } from "./drivers/aistudio";
import { isAIStudioModel } from "../shared/aistudio";
import { GrokDriver } from "./drivers/grok";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver } from "./drivers/codex";
import type { AgentDriver } from "./drivers/types";
import { diffStatsText } from "./diffs";

const JUDGE_INSTRUCTIONS = [
  "# 역할: AI_ChatterBox 승인 판단",
  "너는 별도의 승인 판단 세션으로 마스터와 작업자(클로드 N호, 지피티 N호)의 요청을 판단한다. 도구는 쓰지 않는다.",
  '답은 JSON 한 줄만 쓴다: {"decision":"allow"|"deny"|"ask_user","reason":"한국어 한 문장"}',
  "기준:",
  "- allow: 지금 맡긴 일에 필요하고, 작업 폴더 안에서 되돌릴 수 있는 작업. 예: 파일 생성·수정, 빌드·테스트·린트·타입 검사 실행, 프로젝트 스크립트 실행, 파일 읽기와 검색.",
  "- deny: 맡긴 일과 무관하거나 해로운 작업. 예: 작업 폴더 전체나 홈 폴더 삭제, 비밀·자격 증명 읽기나 외부 전송, 리뷰·의견 요청인데 파일을 고치려는 작업.",
  "- 고위험 위임이 켜졌으면: 사용자가 명시한 작업을 수행하는 데 필요하고 범위가 분명한 작업 폴더 밖 쓰기, git push, 환경·시스템 변경 등도 allow 가능하다. 위임은 무조건 허용이 아니다. 사용자 지시와 무관한 작업은 deny, 대상·결과가 불명확하면 ask_user.",
  "- 고위험 위임이 꺼졌으면: 작업 폴더 밖 쓰기, git push나 기록 변경, 전역 설치·시스템 변경은 ask_user. 판단이 애매하거나 사용자 선택이 필요하면 항상 ask_user.",
  "이유는 짧고 구체적으로 쓴다 (예: '테스트 실행, 작업 폴더 안').",
].join("\n");

interface Session {
  driver: AgentDriver;
  key: string;
  text: string;
  done?: (ok: boolean) => void;
  queue: Promise<unknown>;
}

export interface JudgeContext {
  instruction?: string;
  consult?: { who: string; kind: ConsultKind; message: string; scope: string[] };
}

export class ApprovalJudge {
  private sessions = new Map<number, Session>();
  private generation = 0;
  private chatGenerations = new Map<number, number>();

  constructor(
    private chats: ChatManager,
    private context: (chatId: number, role?: Role) => JudgeContext,
  ) {}

  private async session(chatId: number): Promise<Session> {
    const generation = this.generation;
    const chatGeneration = this.chatGenerations.get(chatId) ?? 0;
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const { agent, model } = chatOrchestrator(chat, project);
    const { effort } = await this.chats.assignmentEffort(chatId, "orch");
    if (generation !== this.generation || chatGeneration !== (this.chatGenerations.get(chatId) ?? 0)) throw new Error("승인 판단 초기화가 취소되었습니다.");
    const key = `${agent}:${model}:${effort}:${project.folder}:${project.settings.delegateHighRisk}`;
    const cur = this.sessions.get(chatId);
    if (cur && cur.key === key) return cur;
    if (cur) void cur.driver.dispose();

    const s: Session = { driver: undefined as unknown as AgentDriver, key, text: "", queue: Promise.resolve() };
    const host = {
      emit: (e: AgentEvent) => {
        if (e.type === "text") s.text = e.text;
        else if (e.type === "tool_call") {
          // A judge must answer from the supplied action, never investigate with tools.
          s.done?.(false);
          void s.driver.stop();
        }
        else if (e.type === "turn_end") s.done?.(!!e.ok);
      },
      nativeId: () => undefined,
      approve: async () => ({ verdict: "deny" as const, reason: "판단 세션은 도구를 쓰지 않습니다." }),
      usage: (u: UsageInfo) => this.chats.mergeUsage(u),
    };
    const opts = { cwd: project.folder, nativeId: null, exePath: "", model: model || undefined, effort, instructions: JUDGE_INSTRUCTIONS, readOnly: true, ephemeral: true };
    s.driver =
      agent === "claude"
        ? new ClaudeDriver(
            { ...opts, exePath: this.chats.claudeExe() },
            {
              bridge: this.chats.bridge,
              bridgeScript: this.chats.bridgeScript,
              tmpDir: this.chats.tmpDir,
              tools: [],
              strictMcp: true,
              extraArgs: ["--no-session-persistence"],
            },
            host,
          )
        : agent === "gemini" && isAIStudioModel(model) ? new AIStudioDriver(opts, { service: this.chats.aiStudio() }, host)
        : agent === "gemini" ? new GeminiDriver({ ...opts, exePath: this.chats.geminiExe() }, { bridge: this.chats.bridge, hookScript: join(dirname(this.chats.bridgeScript), "antigravity-hook.js"), tmpDir: this.chats.tmpDir }, host)
        : agent === "grok" ? new GrokDriver({ ...opts, exePath: this.chats.grokExe() }, () => ({}), host)
        : new CodexDriver(opts, this.chats.codex(), host);
    this.sessions.set(chatId, s);
    return s;
  }

  async decide(chatId: number, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const s = await this.session(chatId);
    // One question at a time per chat.
    const run = s.queue.then(() => this.sessions.get(chatId) === s ? this.ask(chatId, s, request, input) : null);
    s.queue = run.catch(() => undefined);
    return run;
  }

  private async ask(chatId: number, s: Session, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const chat = this.chats.store.chat(chatId);
    const project = chat && this.chats.store.project(chat.projectId);
    if (!project) return null;
    const ctx = this.context(chatId, request.role);
    const prompt = [
      "[승인 요청]",
      `작업 폴더: ${project.folder}`,
      `고위험 위임: ${project.settings.delegateHighRisk ? "켜짐 (사용자 지시 범위 안에서 판단)" : "꺼짐 (직접 사용자 확인)"}`,
      `요청한 역할: ${roleName(request.role, this.chats.store.listAgents(chatId))}`,
      ctx.instruction ? `사용자 지시: ${clip(ctx.instruction, 1500)}` : "사용자 지시: (알 수 없음)",
      ctx.consult
        ? `맡은 일 (${CONSULT_KIND_LABEL[ctx.consult.kind]}, ${ctx.consult.who}${ctx.consult.scope.length ? `, 고칠 수 있는 범위: ${ctx.consult.scope.join(", ")}` : ""}): ${clip(ctx.consult.message, 2500)}`
        : "맡은 일: (없음)",
      `작업 종류: ${request.title}`,
      `내용: ${clip(request.detail, 3000)}`,
      request.reason ? `작업자가 밝힌 이유: ${clip(request.reason, 500)}` : "",
      request.diffs?.length ? `변경 요약: ${request.diffs.map((d) => `${d.kind} ${d.path} (${diffStatsText(d.diff)})`).join(", ")}` : "",
      input.paths?.length ? `관련 경로: ${input.paths.join(", ")}` : "",
      `자동 분류: ${request.risk === "high" ? `고위험 (${request.riskReason})` : "일반"}`,
      'JSON 한 줄로만 답하세요: {"decision":"allow"|"deny"|"ask_user","reason":"..."}',
    ]
      .filter(Boolean)
      .join("\n");

    s.text = "";
    const ended = new Promise<boolean>((resolve) => (s.done = resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        void s.driver.stop();
        resolve(false);
      }, 120_000);
    });
    let completed = false;
    try {
      const ok = await Promise.race([s.driver.send({ text: prompt, attachments: [] }).then(() => ended), timeout]);
      completed = ok;
      return ok ? parseAnswer(s.text) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      s.done = undefined;
      if (!completed) {
        if (this.sessions.get(chatId) === s) this.sessions.delete(chatId);
        await s.driver.stop().catch(() => undefined);
        await s.driver.dispose().catch(() => undefined);
      }
    }
  }

  forget(chatId: number) {
    void this.interrupt(chatId);
  }

  async interrupt(chatId: number) {
    this.chatGenerations.set(chatId, (this.chatGenerations.get(chatId) ?? 0) + 1);
    const s = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    s?.done?.(false);
    await s?.driver.stop().catch(() => undefined);
    await s?.driver.dispose().catch(() => undefined);
  }

  async dispose() {
    this.generation++;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.driver.dispose().catch(() => undefined)));
  }
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + " …(생략)" : s;
}

/** Strict-ish JSON parse: the first {...} object with a valid decision. */
export function parseAnswer(text: string): JudgeAnswer | null {
  const m = /\{[\s\S]*?\}/.exec(text.replace(/```(json)?/g, ""));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!["allow", "deny", "ask_user"].includes(o.decision)) return null;
    return { decision: o.decision, reason: String(o.reason ?? "").slice(0, 300) || "(이유 없음)" };
  } catch {
    return null;
  }
}

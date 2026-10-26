// Approval judge: a separate conversation per chat on the orchestrator's CLI and model.
// The orchestrator's own session is blocked inside a consult tool call while workers ask for
// approvals, so judging happens in this side conversation. It keeps context across requests
// (decisions so far), answers strict JSON, and anything malformed/slow falls back to the user.
import { chatOrchestrator, roleName, CONSULT_KIND_LABEL, type AgentEvent, type ApprovalRequest, type ConsultKind, type Role, type UsageInfo, type CliAccountId } from "../shared/types";
import type { ChatManager } from "./chats";
import type { ApprovalInput, JudgeAnswer } from "./approvals";
import { AIStudioDriver, ChatCompletionDriver } from "./drivers/aistudio";
import { isAIStudioModel } from "../shared/aistudio";
import { GrokDriver } from "./drivers/grok";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver } from "./drivers/codex";
import type { AgentDriver, DriverHost } from "./drivers/types";
import { diffStatsText } from "./diffs";

const JUDGE_INSTRUCTIONS = [
  "# 역할: AI_ChatterBox 승인 판단",
  "너는 별도의 승인 판단 세션으로 마스터와 작업자의 요청을 판단한다. 필요한 도구를 사용할 수 있으며, 파일 수정과 변경 명령은 앱의 사용자 승인으로 확인한다. 판단 대상 작업을 대신 실행하거나 중복 실행하지 말고, 확인에 필요한 작업만 수행한다.",
  '답은 JSON 한 줄만 쓴다: {"decision":"allow"|"deny"|"ask_user","reason":"한국어 한 문장"}',
  "기준:",
  "- allow: 지금 맡긴 일에 필요하고, 작업 폴더 안에서 되돌릴 수 있는 작업. 예: 파일 생성·수정, 빌드·테스트·린트·타입 검사 실행, 프로젝트 스크립트 실행, 파일 읽기와 검색.",
  "- deny: 맡긴 일과 무관하거나 해로운 작업. 예: 작업 폴더 전체나 홈 폴더 삭제, 비밀·자격 증명 읽기나 외부 전송, 사용자가 명시적으로 금지한 수정. 계획·리뷰·의견이라는 작업 종류만으로 수정·명령을 거부하지 않는다.",
  "- 고위험 위임이 켜졌으면: 사용자가 명시한 작업을 수행하는 데 필요하고 범위가 분명한 작업 폴더 밖 쓰기, git push, 환경·시스템 변경 등도 allow 가능하다. 위임은 무조건 허용이 아니다. 사용자 지시와 무관한 작업은 deny, 대상·결과가 불명확하면 ask_user.",
  "- 고위험 위임이 꺼졌으면: 작업 폴더 밖 쓰기, git push나 기록 변경, 전역 설치·시스템 변경은 ask_user. 판단이 애매하거나 사용자 선택이 필요하면 항상 ask_user.",
  "이유는 짧고 구체적으로 쓴다 (예: '테스트 실행, 작업 폴더 안').",
].join("\n");

interface Session {
  accountId?: CliAccountId;
  driver: AgentDriver;
  key: string;
  text: string;
  done?: (ok: boolean) => void;
  queue: Promise<unknown>;
  active?: { request: ApprovalRequest; controller: AbortController; tools: Set<string>; pause(): void; resume(): void };
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
  ) {
    chats.releaseAccountJudges = async id => {
      for (const [chatId, session] of this.sessions) if (session.accountId === id) await this.interrupt(chatId, true);
    };
  }

  private async session(chatId: number, accountId?: CliAccountId): Promise<Session> {
    const generation = this.generation;
    const chatGeneration = this.chatGenerations.get(chatId) ?? 0;
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const { agent, model } = chatOrchestrator(chat, project);
    if (agent === "gemini" && !isAIStudioModel(model)) throw new Error("Gemini 웹은 승인 판단 마스터로 사용할 수 없습니다.");
    const token = accountId ? this.chats.accountToken(accountId) : "";
    const accountEnv = accountId ? this.chats.cliAccounts().env(accountId) : {};
    const { effort } = await this.chats.assignmentEffort(chatId, "orch");
    if (generation !== this.generation || chatGeneration !== (this.chatGenerations.get(chatId) ?? 0)) throw new Error("승인 판단 초기화가 취소되었습니다.");
    const key = `${agent}:${model}:${effort}:${project.folder}:${accountId ?? ""}:${token}:${chat.approvalModeOverride ?? project.settings.approvalMode}`;
    const cur = this.sessions.get(chatId);
    if (cur && cur.key === key) return cur;
    if (cur) {
      cur.active?.controller.abort();
      cur.done?.(false);
      await cur.driver.dispose();
    }

    const s: Session = { accountId, driver: undefined as unknown as AgentDriver, key, text: "", queue: Promise.resolve() };
    const host: DriverHost = {
      emit: (e: AgentEvent) => {
        if (e.type === "text") s.text = e.text;
        else if (e.type === "turn_end") s.done?.(!!e.ok);
        else if (s.active && !s.active.controller.signal.aborted && ["tool_call", "tool_result", "file_change", "image_generation"].includes(e.type)) {
          if (e.type === "tool_call" || e.type === "tool_result" || e.type === "file_change") {
            e = { ...e, id: `judge:${e.id}` };
            if (e.type === "tool_call" && !s.active.tools.has(e.id)) {
              s.active.tools.add(e.id);
              s.active.pause();
            } else if (e.type !== "tool_call" && s.active.tools.delete(e.id)) s.active.resume();
          }
          const { role } = s.active.request;
          this.chats.emit(chatId, this.chats.route(chatId, role), role, e);
          this.chats.onDriverEvent?.(chatId, role, e);
        }
      },
      nativeId: () => undefined,
      approve: async (input) => {
        const active = s.active;
        if (!active) return { verdict: "deny", reason: "승인 판단이 종료되었습니다." };
        active.pause();
        try {
          const { role } = active.request;
          return await this.chats.approvals.request(chatId, project.folder, {
            ...input, role, node: this.chats.route(chatId, role), title: `승인 판정기 · ${input.title}`, key: `judge:${input.key}`,
          }, active.controller.signal);
        } finally { if (s.active === active) active.resume(); }
      },
      image: (image) => this.chats.generatedImage(chatId, image),
      usage: (u: UsageInfo) => this.chats.mergeUsage(u, accountId, token),
    };
    const opts = { accountEnv, cwd: project.folder, nativeId: null, exePath: "", model: model || undefined, effort, instructions: JUDGE_INSTRUCTIONS, ephemeral: true };
    s.driver =
      agent === "claude"
        ? new ClaudeDriver(
            { ...opts, exePath: this.chats.claudeExe() },
            {
              bridge: this.chats.bridge,
              bridgeScript: this.chats.bridgeScript,
              tmpDir: this.chats.tmpDir,
              strictMcp: true,
              extraArgs: ["--no-session-persistence"],
            },
            host,
          )
        : agent === "gemini" && isAIStudioModel(model) ? new AIStudioDriver(opts, { service: this.chats.aiStudio() }, host)
        : agent === "grok" ? new GrokDriver({ ...opts, exePath: this.chats.grokExe() }, () => ({}), host)
        : agent === "deepseek" ? new ChatCompletionDriver(opts, { provider: "deepseek", service: this.chats.deepSeek() }, host)
        : new CodexDriver(opts, this.chats.codex(accountId), host);
    this.sessions.set(chatId, s);
    return s;
  }

  async decide(chatId: number, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const accountId = this.chats.runningAccount(chatId, "orch") ?? this.chats.roleAccount(chatId, "orch")?.accountId;
    const release = accountId ? this.chats.holdJudgeAccount(accountId) : () => {};
    try {
      const s = await this.session(chatId, accountId);
      // One question at a time per chat; queued decisions also hold their account.
      const run = s.queue.then(() => this.sessions.get(chatId) === s ? this.ask(chatId, s, request, input) : null);
      s.queue = run.catch(() => undefined);
      return await run;
    } finally { release(); }
  }

  private async ask(chatId: number, s: Session, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const chat = this.chats.store.chat(chatId);
    const project = chat && this.chats.store.project(chat.projectId);
    if (!project) return null;
    const ctx = this.context(chatId, request.role);
    const prompt = [
      "[승인 요청]",
      `작업 폴더: ${project.folder}`,
      `고위험 위임: ${(chat?.approvalModeOverride ?? project.settings.approvalMode) === "orchestrator-all" ? "켜짐 (사용자 지시 범위 안에서 판단)" : "꺼짐 (직접 사용자 확인)"}`,
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
    const controller = new AbortController();
    let waiting = 0;
    let arm!: () => void;
    const timeout = new Promise<false>((resolve) => {
      arm = () => {
        timer = setTimeout(() => {
          controller.abort();
          void s.driver.stop();
          resolve(false);
        }, 120_000);
      };
    });
    s.active = { request, controller, tools: new Set(),
      pause: () => { waiting++; clearTimeout(timer); },
      resume: () => { if (--waiting === 0 && !controller.signal.aborted) arm(); },
    };
    arm();
    let completed = false;
    try {
      const ok = await Promise.race([s.driver.send({ text: prompt, attachments: [] }).then(() => ended), timeout]);
      completed = ok;
      return ok ? parseAnswer(s.text) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const id of s.active.tools) {
        const event: AgentEvent = { type: "tool_result", id, ok: false, output: "승인 판단이 종료되었습니다." };
        this.chats.emit(chatId, this.chats.route(chatId, request.role), request.role, event);
        this.chats.onDriverEvent?.(chatId, request.role, event);
      }
      s.active = undefined;
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

  async interrupt(chatId: number, strict = false) {
    this.chatGenerations.set(chatId, (this.chatGenerations.get(chatId) ?? 0) + 1);
    const s = this.sessions.get(chatId);
    if (!strict) this.sessions.delete(chatId);
    s?.active?.controller.abort();
    s?.done?.(false);
    await s?.driver.stop().catch(() => undefined);
    if (strict) { await s?.driver.dispose(); if (this.sessions.get(chatId) === s) this.sessions.delete(chatId); }
    else await s?.driver.dispose().catch(() => undefined);
  }

  async dispose() {
    this.generation++;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => {
      s.active?.controller.abort();
      s.done?.(false);
      return s.driver.dispose().catch(() => undefined);
    }));
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

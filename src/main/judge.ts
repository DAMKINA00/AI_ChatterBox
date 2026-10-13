// Approval judge: a long-lived, tool-less conversation per chat on the orchestrator's CLI and model.
// The orchestrator's own session is blocked inside a consult tool call while workers ask for
// approvals, so judging happens in this side conversation. It keeps context across requests
// (decisions so far), answers strict JSON, and anything malformed/slow falls back to the user.
import { chatOrchestrator, ROLE_LABEL, CONSULT_KIND_LABEL, type AgentEvent, type ApprovalRequest, type ConsultKind, type Role, type UsageInfo } from "../shared/types";
import type { ChatManager } from "./chats";
import type { ApprovalInput, JudgeAnswer } from "./approvals";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver } from "./drivers/codex";
import type { AgentDriver } from "./drivers/types";
import { diffStatsText } from "./diffs";

const JUDGE_INSTRUCTIONS = [
  "# 역할: AI_ChatterBox 승인 판단",
  "너는 오케스트레이터를 대신해 작업자(Claude 작업자, GPT 작업자)의 승인 요청을 판단한다. 도구는 쓰지 않는다.",
  '답은 JSON 한 줄만 쓴다: {"decision":"allow"|"deny"|"ask_user","reason":"한국어 한 문장"}',
  "기준:",
  "- allow: 지금 맡긴 일에 필요하고, 작업 폴더 안에서 되돌릴 수 있는 작업. 예: 파일 생성·수정, 빌드·테스트·린트·타입 검사 실행, 프로젝트 스크립트 실행, 파일 읽기와 검색.",
  "- deny: 맡긴 일과 무관하거나 해로운 작업. 예: 작업 폴더 전체나 홈 폴더 삭제, 비밀·자격 증명 읽기나 외부 전송, 리뷰·의견 요청인데 파일을 고치려는 작업.",
  "- ask_user: 사용자가 결정해야 하는 작업. 예: 작업 폴더 밖에 쓰기, git push나 기록 변경, 전역 패키지 설치처럼 환경을 바꾸는 작업, 판단이 애매한 경우.",
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
  consult?: { role: Role; kind: ConsultKind; message: string };
}

export class ApprovalJudge {
  private sessions = new Map<number, Session>();

  constructor(
    private chats: ChatManager,
    private context: (chatId: number) => JudgeContext,
  ) {}

  private session(chatId: number): Session {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const { agent, model } = chatOrchestrator(chat, project);
    const key = `${agent}:${model}:${project.folder}`;
    const cur = this.sessions.get(chatId);
    if (cur && cur.key === key) return cur;
    if (cur) void cur.driver.dispose();

    const s: Session = { driver: undefined as unknown as AgentDriver, key, text: "", queue: Promise.resolve() };
    const host = {
      emit: (e: AgentEvent) => {
        if (e.type === "text") s.text = e.text;
        else if (e.type === "turn_end") s.done?.(!!e.ok);
      },
      nativeId: () => undefined,
      approve: async () => ({ verdict: "deny" as const, reason: "판단 세션은 도구를 쓰지 않습니다." }),
      usage: (u: UsageInfo) => this.chats.mergeUsage(u),
    };
    const opts = { cwd: project.folder, nativeId: null, exePath: "", model: model || undefined, instructions: JUDGE_INSTRUCTIONS, readOnly: true, ephemeral: true };
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
        : new CodexDriver(opts, this.chats.codex(), host);
    this.sessions.set(chatId, s);
    return s;
  }

  decide(chatId: number, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const s = this.session(chatId);
    // One question at a time per chat.
    const run = s.queue.then(() => this.ask(chatId, s, request, input));
    s.queue = run.catch(() => undefined);
    return run;
  }

  private async ask(chatId: number, s: Session, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null> {
    const chat = this.chats.store.chat(chatId);
    const project = chat && this.chats.store.project(chat.projectId);
    if (!project) return null;
    const ctx = this.context(chatId);
    const prompt = [
      "[승인 요청]",
      `작업 폴더: ${project.folder}`,
      `요청한 작업자: ${ROLE_LABEL[request.role]}`,
      ctx.instruction ? `사용자 지시: ${clip(ctx.instruction, 1500)}` : "사용자 지시: (알 수 없음)",
      ctx.consult
        ? `오케스트레이터가 맡긴 일 (${CONSULT_KIND_LABEL[ctx.consult.kind]}, ${ROLE_LABEL[ctx.consult.role]}): ${clip(ctx.consult.message, 2500)}`
        : "오케스트레이터가 맡긴 일: (없음)",
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
    const timeout = new Promise<false>((resolve) =>
      setTimeout(() => {
        void s.driver.stop();
        resolve(false);
      }, 120_000),
    );
    try {
      await s.driver.send({ text: prompt, attachments: [] });
    } catch {
      return null;
    }
    const ok = await Promise.race([ended, timeout]);
    s.done = undefined;
    return ok ? parseAnswer(s.text) : null;
  }

  forget(chatId: number) {
    const s = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    void s?.driver.dispose();
  }

  async dispose() {
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

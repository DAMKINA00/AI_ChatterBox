// Collaboration engine. The orchestrator conversation (Claude or Codex, read-only) gets three tools
// through the Bridge MCP server: consult_claude, consult_codex and ask_user. A consult runs one turn
// on a worker conversation (Claude worker / GPT worker), streams it into the chat under a consult
// node, and returns the worker's answer + changed files as the tool result. Workers run one at a
// time, so only one agent edits files at any moment.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  AGENT_LABEL,
  chatOrchestrator,
  CONSULT_KIND_LABEL,
  ROLE_LABEL,
  type AgentEvent,
  type AgentKind,
  type AttachmentRef,
  type Chat,
  type ConsultKind,
  type Project,
  type Role,
} from "../shared/types";
import type { ChatManager } from "./chats";
import { bridgeServerConfig, textResult, type ToolDef, type ToolResult } from "./local-bridge";
import { mimeOf } from "./attachments";
import type { AgentInput } from "./drivers/types";
import { ApprovalJudge } from "./judge";

const KINDS: ConsultKind[] = ["implement", "review", "opinion"];

const consultTool = (name: string, who: string): ToolDef => ({
  name,
  description:
    `${who} 작업자에게 일을 맡기고 결과를 기다립니다. 작업자는 이 대화를 보지 못하므로 message에 필요한 맥락(목표, 관련 파일, 조건, 완료 기준)을 모두 적으세요. ` +
    "kind: implement=구현·수정 위임(작업자가 파일을 고침), review=변경 리뷰(작업자는 파일을 고치지 않고 문제점만 보고), opinion=설계·원인 분석 등 의견. " +
    "결과로 작업자의 최종 답변과 변경된 파일 목록을 돌려받습니다.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "작업자에게 보낼 지시 (한국어, 자기완결적으로)" },
      kind: { type: "string", enum: KINDS },
      attach: { type: "array", items: { type: "string" }, description: "함께 보낼 파일 절대경로 (사용자 첨부 이미지 등)" },
    },
    required: ["message", "kind"],
  },
});

const ASK_TOOL: ToolDef = {
  name: "ask_user",
  description: "진행에 꼭 필요한 결정을 사용자에게 묻고 답을 기다립니다. 선택지가 있으면 options로 주세요. 사소한 일은 묻지 말고 스스로 판단하세요.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
    required: ["question"],
  },
};

function orchestratorInstructions(project: Project, agent: AgentKind): string {
  const s = project.settings;
  const tool = (r: "claude" | "codex") => (agent === "claude" ? `mcp__chatterbox_bridge__consult_${r}` : `consult_${r}`);
  return [
    "# 역할: AI_ChatterBox 오케스트레이터",
    `너는 사용자의 지시를 받아 두 작업자(Claude 작업자, GPT 작업자)에게 일을 나눠 맡기는 오케스트레이터다. 작업 폴더: ${project.folder}`,
    "- 너는 읽기 전용이다. 파일을 직접 고치거나 명령으로 무언가를 바꾸지 않는다. 코드를 읽고 검색하는 것은 괜찮다.",
    `- 구현·수정은 ${tool("claude")} 또는 ${tool("codex")} 로 작업자에게 맡긴다 (kind=implement). 한 번에 한 작업자만 파일을 고친다.`,
    s.reviewGate
      ? "- 코드가 바뀌면 끝내기 전에, 구현한 작업자가 아닌 다른 작업자에게 리뷰를 맡긴다 (kind=review). 리뷰에서 문제가 나오면 고치게 하고 필요하면 다시 리뷰받는다."
      : "- 리뷰는 필요하다고 판단할 때만 맡긴다 (kind=review).",
    "- 기본 흐름: 계획 → 한 작업자에게 구현 위임 → 다른 작업자에게 리뷰 → 수정 → 사용자에게 최종 보고. 누가 무엇을 할지는 네가 정한다.",
    "- 질문·설명·간단한 확인처럼 파일을 바꿀 필요가 없는 지시는 작업자를 부르지 말고 직접 답한다.",
    "- 작업자는 이 대화를 보지 못한다. 위임할 때 message에 목표, 관련 파일 경로, 제약, 완료 기준을 빠짐없이 적는다. 사용자가 첨부한 파일이 필요하면 attach로 경로를 넘긴다.",
    "- 꼭 필요한 결정만 ask_user로 묻는다.",
    `- 한도: 지시 하나당 협의 ${s.maxConsults}회, 리뷰 ${s.maxReviews}회, ${s.maxMinutes}분. 한도에 걸리면 그때까지의 결과로 보고한다.`,
    "- 마지막에는 항상 한국어로 결과를 보고한다: 무엇을 했는지, 바뀐 파일, 리뷰 결과, 남은 문제.",
  ].join("\n");
}

function workerInstructions(role: "claude" | "gpt"): string {
  return [
    `# 역할: AI_ChatterBox ${ROLE_LABEL[role]} 작업자`,
    "너는 팀의 작업자다. 지시는 오케스트레이터가 보낸다.",
    "- 구현 지시(implement): 작업 폴더에서 직접 고치고, 가능하면 빌드·테스트로 확인한다.",
    "- 리뷰 지시(review): 파일을 고치지 않는다. 변경 내용을 읽고 버그, 빠진 처리, 개선점을 심각도와 함께 보고한다. 문제가 없으면 문제없다고 분명히 말한다.",
    "- 의견 지시(opinion): 파일을 고치지 않고 분석과 제안만 한다.",
    "- 끝나면 한국어로 짧게 보고한다: 한 일, 바뀐 파일, 확인 방법과 결과, 남은 문제.",
  ].join("\n");
}

interface Instruction {
  /** The user's instruction text (context for the approval judge). */
  text: string;
  startedAt: number;
  consults: number;
  reviews: number;
  requests: Map<string, number>;
  /** Extra instructions the user sent while the orchestrator was working. */
  queued: { text: string; attachments: AttachmentRef[] }[];
  /** Extra instructions already handed over (repeated in later tool results). */
  pinned: string[];
}

interface Running {
  consultId: number;
  role: Role;
  kind: ConsultKind;
  message: string;
  text: string;
  files: Set<string>;
  pendingFiles: Map<string, string[]>;
  resolve: (r: { ok: boolean; interrupted?: boolean; error?: string }) => void;
}

export class Orchestrator {
  private bridgeKeys = new Map<number, { key: string; url: string }>();
  private instructions = new Map<number, Instruction>();
  private running = new Map<number, Running>();
  private locks = new Map<number, Promise<unknown>>();
  private asks = new Map<string, { chatId: number; resolve: (a: string) => void }>();
  private stopped = new Set<number>();
  readonly judge: ApprovalJudge;

  constructor(private chats: ChatManager) {
    this.judge = new ApprovalJudge(chats, (chatId) => {
      const r = this.running.get(chatId);
      return {
        instruction: this.instructions.get(chatId)?.text,
        consult: r ? { role: r.role, kind: r.kind, message: r.message } : undefined,
      };
    });
    chats.judge = (chatId, request, input) => this.judge.decide(chatId, request, input);
    chats.instructionsFor = (_chat, project, role, agent) =>
      role === "orch" ? orchestratorInstructions(project, agent) : workerInstructions(role);
    chats.toolsFor = (chat, role) => (role === "orch" ? { chatterbox_bridge: this.bridgeFor(chat.id) } : undefined);
    chats.onDriverEvent = (chatId, role, event) => this.observe(chatId, role, event);
    chats.sendHandler = (chat, input) => this.instruct(chat, input);
    chats.busySend = (chat, input) => this.queue(chat, input);
  }

  // ---------- bridge tools
  private bridgeFor(chatId: number) {
    let reg = this.bridgeKeys.get(chatId);
    if (!reg) {
      reg = this.chats.bridge.register(
        {
          tools: [consultTool("consult_claude", "Claude"), consultTool("consult_codex", "GPT(Codex)"), ASK_TOOL],
          call: (name, args) => this.call(chatId, name, args),
        },
        `orch-${chatId}`,
      );
      this.bridgeKeys.set(chatId, reg);
    }
    return bridgeServerConfig(this.chats.bridgeScript, reg.url);
  }

  private async call(chatId: number, name: string, args: any): Promise<ToolResult> {
    if (!this.chats.store.chat(chatId)) return textResult("채팅이 삭제되었습니다.", true);
    if (name === "ask_user") return textResult(await this.ask(chatId, String(args.question ?? ""), Array.isArray(args.options) ? args.options.map(String) : []));
    const role: Role | null = name === "consult_claude" ? "claude" : name === "consult_codex" ? "gpt" : null;
    if (!role) return textResult(`알 수 없는 도구: ${name}`, true);
    const kind: ConsultKind = KINDS.includes(args.kind) ? args.kind : "implement";
    const attach = Array.isArray(args.attach) ? args.attach.map(String) : [];
    // One worker at a time per chat: parallel tool calls queue up here.
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(() => this.consult(chatId, role, kind, String(args.message ?? ""), attach));
    this.locks.set(chatId, run.catch(() => undefined));
    return run;
  }

  // ---------- user instructions
  /**
   * The chat's orchestrator moved to the other CLI (Claude ↔ GPT): that CLI has its own (new) session,
   * so hand it a short summary of the chat so far.
   */
  private handover(chat: Chat): string {
    const project = this.chats.store.project(chat.projectId)!;
    const { agent } = chatOrchestrator(chat, project);
    const key = `orchAgent:${chat.id}`;
    const prev = this.chats.store.getSetting(key);
    this.chats.store.setSetting(key, agent);
    if (!prev || prev === agent) return "";
    const lines: string[] = [];
    for (const e of this.chats.store.events(chat.id)) {
      const ev = e.event;
      if (ev.type === "user" && ev.text) lines.push(`사용자: ${clipText(ev.text, 500)}`);
      else if (ev.type === "text" && e.role === "orch") lines.push(`오케스트레이터: ${clipText(ev.text, 500)}`);
      else if (ev.type === "consult_end")
        lines.push(`협의 결과(${ev.status}): ${clipText(ev.summary, 400)}${ev.files.length ? ` · 변경: ${ev.files.join(", ")}` : ""}`);
    }
    const recent = lines.slice(-16).join("\n").slice(-6000);
    const name = (a: string) => (a === "claude" ? "Claude" : "GPT");
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: `오케스트레이터가 ${name(agent)}로 바뀌어 지금까지의 요약을 넘깁니다` });
    return `[AI_ChatterBox] 이 채팅의 오케스트레이터가 ${name(prev)}에서 ${name(agent)}로 바뀌었습니다. 지금까지의 대화 요약:\n${recent}\n\n---\n`;
  }

  private async instruct(chat: Chat, input: AgentInput) {
    this.stopped.delete(chat.id);
    const prefix = this.handover(chat);
    if (prefix) input = { ...input, text: prefix + input.text };
    this.instructions.set(chat.id, { text: input.text, startedAt: Date.now(), consults: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    const driver = await this.chats.driver(chat.id, "orch");
    await driver.send({ ...input, text: input.text + attachmentNote(input.attachments) });
  }

  /**
   * Continue a run the app quit or crashed in the middle of: the orchestrator session resumes
   * (claude --resume / thread/resume) and is told to check the folder and finish; workers resume
   * their own sessions on the next consult.
   */
  async resume(chatId: number) {
    const chat = this.chats.store.chat(chatId);
    if (!chat || chat.status !== "interrupted") return;
    const last = [...this.chats.store.events(chatId)]
      .reverse()
      .find((e) => e.event.type === "user" && !e.event.queued)?.event as { text: string } | undefined;
    const original = last?.text ?? "";
    this.chats.emit(chatId, "orch", null, { type: "notice", text: "중단된 작업을 이어서 진행합니다" });
    this.chats.updateChat(chatId, { status: "working", touch: true });
    this.stopped.delete(chatId);
    this.instructions.set(chatId, { text: original, startedAt: Date.now(), consults: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    const note =
      "[AI_ChatterBox] 이전 실행이 앱 종료로 중단됐습니다. 작업 폴더의 현재 상태(git status, git diff, 파일 내용)를 확인하고, " +
      "아래 원래 지시의 남은 작업을 이어서 끝낸 뒤 결과를 보고하세요. 이미 끝난 부분은 다시 하지 마세요.\n\n원래 지시:\n" +
      (original || "(기록 없음)");
    try {
      await (await this.chats.driver(chatId, "orch")).send({ text: this.handover(chat) + note, attachments: [] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.chats.emit(chatId, "orch", "orch", { type: "error", kind: "process", message });
      this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: message });
    }
  }

  dismissInterrupted(chatId: number) {
    if (this.chats.store.chat(chatId)?.status === "interrupted") this.chats.updateChat(chatId, { status: "idle" });
  }

  /** The user typed while the team was working: hand it to the orchestrator at the next boundary. */
  private async queue(chat: Chat, input: AgentInput) {
    const inst = this.instructions.get(chat.id);
    if (!inst) throw new Error("작업이 진행 중입니다.");
    inst.queued.push(input);
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "추가 지시를 받았습니다. 다음 단계에서 오케스트레이터에게 전달합니다." });
  }

  /**
   * Extra instructions ride along with the next tool result, and stay pinned to every later one
   * in this instruction so the orchestrator keeps them in view until its final report.
   */
  private takeQueued(chatId: number): string {
    const inst = this.instructions.get(chatId);
    if (!inst) return "";
    const fresh = inst.queued.splice(0);
    inst.pinned.push(...fresh.map((x) => x.text + attachmentNote(x.attachments)));
    if (!inst.pinned.length) return "";
    return (
      "\n\n[사용자 추가 지시 — 작업 중에 도착함, 최종 보고까지 반드시 반영]\n" +
      inst.pinned.map((t) => `- ${t}`).join("\n")
    );
  }

  // ---------- consult
  private limitCheck(chatId: number, project: Project, role: Role, kind: ConsultKind, message: string): string | null {
    const inst = this.instructions.get(chatId);
    if (!inst) return null;
    const s = project.settings;
    if (this.stopped.has(chatId)) return "사용자가 작업을 중지했습니다. 더 이상 위임하지 말고 멈추세요.";
    if (inst.consults >= s.maxConsults) return `한도 도달: 이번 지시에서 협의를 ${s.maxConsults}회 했습니다. 더 위임하지 말고 지금까지의 결과를 사용자에게 보고하세요.`;
    if (kind === "review" && inst.reviews >= s.maxReviews) return `한도 도달: 리뷰를 ${s.maxReviews}회 했습니다. 더 리뷰를 맡기지 말고 지금까지의 결과와 남은 지적 사항을 보고하세요.`;
    if (Date.now() - inst.startedAt > s.maxMinutes * 60_000) return `한도 도달: 이번 지시에 ${s.maxMinutes}분이 지났습니다. 지금까지의 결과를 보고하세요.`;
    const h = createHash("sha1").update(`${role}|${kind}|${message.trim()}`).digest("hex");
    const n = (inst.requests.get(h) ?? 0) + 1;
    inst.requests.set(h, n);
    if (n > 2) return "같은 요청을 이미 두 번 보냈습니다. 반복하지 말고 방법을 바꾸거나 지금까지의 결과를 보고하세요.";
    return null;
  }

  private async consult(chatId: number, role: Role, kind: ConsultKind, message: string, attach: string[]): Promise<ToolResult> {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const limited = this.limitCheck(chatId, project, role, kind, message);
    if (limited) {
      this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${ROLE_LABEL[role]} 작업자 위임 거절 · ${limited.split(".")[0]}` });
      return textResult(limited + this.takeQueued(chatId), true);
    }
    const inst = this.instructions.get(chatId);
    if (inst) {
      inst.consults++;
      if (kind === "review") inst.reviews++;
    }

    const attachments = this.attachmentsFor(chatId, attach);
    const consult = this.chats.store.createConsult(chatId, "orch", role, kind, message);
    this.chats.sink.consult(consult);
    const node = `consult:${consult.id}` as const;
    this.chats.emit(chatId, "orch", "orch", { type: "consult_start", consultId: consult.id, kind, from: "orch", to: role, request: message, attachments });
    this.chats.setRoute(chatId, role, node);

    const result = await new Promise<{ ok: boolean; interrupted?: boolean; error?: string; text: string; files: string[] }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const r: Running = {
        consultId: consult.id,
        role,
        kind,
        message,
        text: "",
        files: new Set(),
        pendingFiles: new Map(),
        resolve: (end) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ ...end, text: r.text, files: [...r.files] });
        },
      };
      this.running.set(chatId, r);
      // The instruction's time limit also bounds this worker turn.
      if (inst) {
        const left = project.settings.maxMinutes * 60_000 - (Date.now() - inst.startedAt);
        timer = setTimeout(() => void this.chats.liveDriver(chatId, role)?.stop(), Math.max(1000, left));
      }
      void (async () => {
        try {
          const driver = await this.chats.driver(chatId, role);
          await driver.send({ text: kindPrefix(kind) + message, attachments });
        } catch (e) {
          r.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    });

    this.running.delete(chatId);
    this.chats.setRoute(chatId, role, undefined);
    const timedOut = inst ? Date.now() - inst.startedAt > project.settings.maxMinutes * 60_000 : false;
    const status = this.stopped.has(chatId) ? "stopped" : result.interrupted && timedOut ? "limited" : result.ok ? "done" : result.interrupted ? "stopped" : "error";
    const summary = result.text || result.error || "(답변 없음)";
    const finished = this.chats.store.finishConsult(consult.id, status, summary, result.files);
    this.chats.sink.consult(finished);
    this.chats.emit(chatId, "orch", "orch", { type: "consult_end", consultId: consult.id, status, summary, files: result.files });

    const who = `${ROLE_LABEL[role]} 작업자`;
    const head =
      status === "done"
        ? `[${who} · ${CONSULT_KIND_LABEL[kind]} 결과]`
        : status === "stopped"
          ? `[${who}: 사용자가 중지했습니다. 더 위임하지 말고 멈추세요.]`
          : status === "limited"
            ? `[${who}: 시간 한도에 걸려 중단했습니다. 지금까지의 결과로 보고하세요.]`
            : `[${who}: 오류 — ${result.error ?? "실패"}]`;
    const files = result.files.length ? `\n\n변경된 파일:\n${result.files.map((f) => `- ${f}`).join("\n")}` : "\n\n변경된 파일: 없음";
    return textResult(`${head}\n${result.text || "(답변 없음)"}${files}${this.takeQueued(chatId)}`, status !== "done");
  }

  /** Collect the running consult's answer and changed files from the worker's events. */
  private observe(chatId: number, role: Role, event: AgentEvent) {
    if (role === "orch" && event.type === "turn_end") {
      // Extra instructions that arrived after the orchestrator's last consult become the next turn.
      const inst = this.instructions.get(chatId);
      if (inst?.queued.length && !event.interrupted && !this.stopped.has(chatId)) {
        const q = inst.queued.splice(0);
        setTimeout(() => {
          const chat = this.chats.store.chat(chatId);
          if (!chat) return;
          this.chats.updateChat(chatId, { status: "working", touch: true });
          this.instruct(chat, { text: q.map((x) => x.text).join("\n\n"), attachments: q.flatMap((x) => x.attachments) }).catch((e) => {
            this.chats.emit(chatId, "orch", "orch", { type: "error", kind: "process", message: String(e) });
            this.chats.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: String(e) });
          });
        }, 0);
      }
      return;
    }
    const r = this.running.get(chatId);
    if (!r || r.role !== role) return;
    switch (event.type) {
      case "text":
        r.text = event.text;
        break;
      case "tool_call":
        if (event.diffs?.length) r.pendingFiles.set(event.id, event.diffs.map((d) => d.path));
        break;
      case "tool_result": {
        const files = r.pendingFiles.get(event.id);
        if (files && event.ok) for (const f of files) r.files.add(f);
        r.pendingFiles.delete(event.id);
        break;
      }
      case "file_change":
        if (event.ok) for (const f of event.files) r.files.add(f.path);
        break;
      case "turn_end":
        r.resolve({ ok: event.ok, interrupted: event.interrupted, error: event.error });
        break;
    }
  }

  private attachmentsFor(chatId: number, paths: string[]): AttachmentRef[] {
    const out: AttachmentRef[] = [];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const known = this.chats.store.db.prepare("SELECT id FROM attachments WHERE chat_id = ? AND path = ?").get(chatId, p) as { id: number } | undefined;
      if (known) out.push(this.chats.store.attachment(known.id)!);
      else out.push({ id: 0, name: basename(p), mime: mimeOf(p), size: statSync(p).size, path: p });
    }
    return out;
  }

  // ---------- ask_user
  private ask(chatId: number, question: string, options: string[]): Promise<string> {
    const id = `ask:${randomUUID()}`;
    this.chats.emit(chatId, "orch", "orch", { type: "ask_user", id, question, options });
    this.chats.updateChat(chatId, { status: "approval" });
    return new Promise((resolve) => this.asks.set(id, { chatId, resolve }));
  }

  answerAsk(chatId: number, askId: string, answer: string) {
    const a = this.asks.get(askId);
    if (!a || a.chatId !== chatId) return;
    this.asks.delete(askId);
    this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id: askId, answer });
    this.chats.updateChat(chatId, { status: "working" });
    a.resolve(`사용자 답변: ${answer}`);
  }

  // ---------- stop
  async stop(chatId: number) {
    this.stopped.add(chatId);
    for (const [id, a] of [...this.asks]) {
      if (a.chatId !== chatId) continue;
      this.asks.delete(id);
      this.chats.emit(chatId, "orch", null, { type: "ask_user_answer", id, answer: "(중지됨)" });
      a.resolve("사용자가 작업을 중지했습니다. 멈추세요.");
    }
    const inst = this.instructions.get(chatId);
    if (inst) inst.queued = [];
    await this.chats.stop(chatId);
  }

  forget(chatId: number) {
    this.judge.forget(chatId);
    const reg = this.bridgeKeys.get(chatId);
    if (reg) this.chats.bridge.unregister(reg.key);
    this.bridgeKeys.delete(chatId);
    this.instructions.delete(chatId);
  }
}

function clipText(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function kindPrefix(kind: ConsultKind): string {
  switch (kind) {
    case "implement":
      return "[오케스트레이터의 구현 요청]\n";
    case "review":
      return "[오케스트레이터의 리뷰 요청 — 파일을 고치지 말고 문제점만 보고하세요]\n";
    default:
      return "[오케스트레이터의 의견 요청 — 파일을 고치지 마세요]\n";
  }
}

/** The orchestrator sees images inline but needs paths to hand files to workers. */
function attachmentNote(files: AttachmentRef[]): string {
  if (!files.length) return "";
  return "\n\n[첨부 파일 경로 — 작업자에게 넘길 때 attach에 사용]\n" + files.map((f) => `- ${f.path}`).join("\n");
}

export const agentLabel = (a: AgentKind) => AGENT_LABEL[a];

// Collaboration engine: one master (마스터, read-only, Claude or Codex) and a pool of workers
// (클로드 N호 / 지피티 N호) the master spawns and releases as the work needs. Everyone talks through
// the Bridge MCP server:
//   master:  spawn · ask · release · agents · checklist · update_goal · ask_user
//   workers: ask · agents          (call each other by nickname)
// An "ask" runs one turn on the target worker's own Claude session / Codex thread, streams it into the
// chat under a consult node, and returns the answer + changed files as the tool result.
// Parallelism: a worker runs one turn at a time; review/opinion asks run concurrently; implement asks
// carry a scope (path globs) — non-overlapping scopes run concurrently, overlapping ones queue, and
// writes outside the scope are denied. A call that would wait in a cycle, or nest deeper than 3, is refused.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  chatOrchestrator,
  CONSULT_KIND_LABEL,
  MASTER_LABEL,
  WORKER_KIND_LABEL,
  isWorkerKey,
  roleName,
  type AgentEvent,
  type AgentKind,
  type AttachmentRef,
  type Chat,
  type ChatAgent,
  type ChatGoal,
  type ConsultKind,
  type NodeId,
  type PlanStep,
  type Project,
  type Role,
  type WorkerKind,
} from "../shared/types";
import type { ChatManager } from "./chats";
import { bridgeServerConfig, textResult, type ToolDef, type ToolResult } from "./local-bridge";
import { mimeOf } from "./attachments";
import type { AgentInput } from "./drivers/types";
import { ApprovalJudge } from "./judge";
import { scopesOverlap } from "./scope";
import { addWait, checkAsk, removeWait, type WaitGraph } from "./team";

const KINDS: ConsultKind[] = ["implement", "review", "opinion"];
const MAX_DEPTH = 3;
const MAX_ASKS_CAP = 24;
const MAX_GOAL_TURNS = 6;

// ---------- tool definitions
const ASK_TOOL = (forMaster: boolean): ToolDef => ({
  name: "ask",
  description:
    "작업자에게 닉네임으로 일을 맡기거나 질문하고 결과를 기다립니다 (예: to=\"클로드 2호\"). 받는 쪽은 이 대화를 보지 못하므로 message에 목표, 관련 파일, 조건, 완료 기준을 모두 적으세요. " +
    "kind: implement=구현·수정(받는 작업자가 파일을 고침, scope로 고칠 범위를 지정), review=리뷰(파일을 고치지 않고 문제점만 보고), opinion=의견·분석. " +
    "scope(implement 전용): 고쳐도 되는 경로 glob 목록(작업 폴더 기준, 예: [\"src/ui/**\", \"README.md\"]). 범위가 겹치지 않는 구현은 동시에 진행되고, 범위 밖 쓰기는 거부됩니다. " +
    (forMaster ? "여러 작업자에게 동시에 맡기려면 ask를 여러 번 병렬로 호출하세요." : "마스터에게는 ask를 쓰지 말고 결과 보고에 질문을 포함하세요."),
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "받는 작업자 닉네임 (예: 클로드 1호, 지피티 2호)" },
      message: { type: "string" },
      kind: { type: "string", enum: KINDS },
      scope: { type: "array", items: { type: "string" } },
      ...(forMaster ? { attach: { type: "array", items: { type: "string" }, description: "함께 보낼 파일 절대경로 (사용자 첨부 이미지 등)" } } : {}),
    },
    required: ["to", "message", "kind"],
  },
});
const ASK_PARALLEL_TOOL: ToolDef = {
  name: "ask_parallel",
  description:
    "서로 독립적인 일을 여러 작업자에게 동시에 맡기고, 모두 끝나면 결과를 한꺼번에 돌려받습니다. tasks 항목은 ask와 같습니다(to, message, kind, scope). " +
    "구현을 나눠 맡길 때는 scope를 서로 겹치지 않게 주세요. 순서가 있는 일은 ask를 차례로 쓰세요.",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            to: { type: "string" },
            message: { type: "string" },
            kind: { type: "string", enum: KINDS },
            scope: { type: "array", items: { type: "string" } },
          },
          required: ["to", "message", "kind"],
        },
      },
    },
    required: ["tasks"],
  },
};

const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description:
    "작업자를 새로 만들고 닉네임을 돌려받습니다. kind=claude → 클로드 N호(Claude Code), kind=gpt → 지피티 N호(Codex). job에 맡길 역할을 한 줄로 적으세요. 일이 많으면 범위를 나눠 여러 명을 만들고, 일이 적으면 한 명으로 충분합니다.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["claude", "gpt"] }, job: { type: "string" } },
    required: ["kind", "job"],
  },
};
const RELEASE_TOOL: ToolDef = {
  name: "release",
  description: "더 필요 없는 작업자를 해제합니다 (닉네임). 해제한 번호는 다시 쓰지 않습니다.",
  inputSchema: { type: "object", properties: { nickname: { type: "string" } }, required: ["nickname"] },
};
const AGENTS_TOOL: ToolDef = {
  name: "agents",
  description: "이 채팅의 팀 목록: 닉네임, 종류, 맡은 역할, 상태(대기/작업 중/해제).",
  inputSchema: { type: "object", properties: {} },
};
const CHECKLIST_TOOL: ToolDef = {
  name: "checklist",
  description:
    "작업 체크리스트를 등록·갱신합니다 (화면 상단 카드). 전체 단계 목록을 매번 보내세요. 각 단계 제목 앞에 담당을 붙이세요 (예: \"[클로드 1호] 로그인 화면 수정\"). status: pending | inProgress | completed.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, status: { type: "string", enum: ["pending", "inProgress", "completed"] } },
          required: ["title", "status"],
        },
      },
    },
    required: ["steps"],
  },
};
const GOAL_TOOL: ToolDef = {
  name: "update_goal",
  description:
    "이 채팅에 /goal 로 정해진 목표의 진행 상황을 보고합니다. 한 단계를 마칠 때마다 progress에 지금까지 한 일과 남은 일을 한두 문장으로 적고, 목표를 다 이루면 status=complete, 사용자 결정 없이는 더 못 나가면 status=blocked.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["active", "complete", "blocked"] }, progress: { type: "string" } },
    required: ["status", "progress"],
  },
};
const ASK_USER_TOOL: ToolDef = {
  name: "ask_user",
  description: "진행에 꼭 필요한 결정을 사용자에게 묻고 답을 기다립니다. 선택지가 있으면 options로 주세요. 사소한 일은 묻지 말고 스스로 판단하세요.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
    required: ["question"],
  },
};

function masterInstructions(project: Project, agent: AgentKind): string {
  const s = project.settings;
  const t = (n: string) => (agent === "claude" ? `mcp__chatterbox_bridge__${n}` : n);
  return [
    "# 역할: AI_ChatterBox 마스터",
    `너는 사용자의 지시를 받아 팀을 꾸리고 일을 나눠 맡기는 마스터다. 작업 폴더: ${project.folder}`,
    "- 너는 읽기 전용이다. 파일을 직접 고치거나 명령으로 무언가를 바꾸지 않는다. 코드를 읽고 검색하는 것은 괜찮다.",
    `- 팀: ${t("spawn")}(kind=claude|gpt)로 작업자를 만든다 → 클로드 N호 / 지피티 N호. 작업자 수는 일의 양에 맞춘다: 작은 일은 한 명, 큰 일은 범위를 나눠 여러 명(동시에 클로드 최대 ${s.maxClaudeWorkers}명, 지피티 최대 ${s.maxGptWorkers}명). 다 쓴 작업자는 ${t("release")}로 해제한다. ${t("agents")}로 팀을 확인한다.`,
    `- 일 맡기기: ${t("ask")}(to=닉네임, kind, message, scope). 서로 독립적인 일은 반드시 ${t("ask_parallel")}(tasks=[…])로 한 번에 맡겨 동시에 진행한다(하나씩 기다리지 말 것). 구현(implement)은 고칠 범위(scope)를 겹치지 않게 나눈다. 리뷰·의견은 언제든 동시에 가능하다.`,
    s.reviewGate
      ? "- 코드가 바뀌면 끝내기 전에, 그 코드를 만들지 않은 작업자에게 리뷰를 맡긴다 (kind=review). 지적이 나오면 고치게 하고 필요하면 다시 리뷰받는다."
      : "- 리뷰는 필요하다고 판단할 때만 맡긴다 (kind=review).",
    "- 질문·설명·간단한 확인처럼 파일을 바꿀 필요가 없는 지시는 작업자를 만들지 말고 직접 답한다.",
    "- 작업자는 이 대화를 보지 못한다. message에 목표, 관련 파일 경로, 제약, 완료 기준을 빠짐없이 적는다. 사용자가 첨부한 파일이 필요하면 attach로 경로를 넘긴다.",
    `- 여러 단계 작업은 ${t("checklist")}로 단계와 담당(닉네임)을 등록하고, 단계를 시작·완료할 때마다 갱신한다.`,
    `- 채팅에 목표(/goal)가 있으면 그 목표를 향해 일하고, 한 단계를 마칠 때마다 ${t("update_goal")}로 진행을 보고한다. 다 이루면 status=complete.`,
    `- 꼭 필요한 결정만 ${t("ask_user")}로 묻는다.`,
    `- 한도: 지시 하나당 일 맡기기 횟수는 작업자 수에 따라 늘어난다(최대 ${MAX_ASKS_CAP}회), 리뷰 ${s.maxReviews}회, ${s.maxMinutes}분. 한도에 걸리면 그때까지의 결과로 보고한다.`,
    "- 마지막에는 항상 한국어로 보고한다: 누가 무엇을 했는지, 바뀐 파일, 리뷰 결과, 남은 문제.",
  ].join("\n");
}

function workerInstructions(a: ChatAgent): string {
  return [
    `# 역할: AI_ChatterBox ${a.nickname} (${a.kind === "claude" ? "Claude" : "GPT"} 작업자)`,
    `너는 마스터가 이끄는 팀의 작업자 "${a.nickname}"이다.${a.job ? ` 맡은 역할: ${a.job}` : ""}`,
    "- 구현 지시(implement): 지정된 범위(scope) 안의 파일만 고친다. 범위 밖 쓰기는 거부된다. 가능하면 빌드·테스트로 확인한다.",
    "- 리뷰 지시(review)·의견 지시(opinion): 파일을 고치지 않는다. 리뷰는 버그, 빠진 처리, 개선점을 심각도와 함께 보고하고, 문제가 없으면 분명히 말한다.",
    "- 다른 작업자에게 확인할 것이 있으면 ask(to=닉네임)로 직접 묻는다. 팀 목록은 agents. 마스터에게는 ask를 쓰지 말고 결과 보고에 질문을 적는다.",
    "- 끝나면 한국어로 짧게 보고한다: 한 일, 바뀐 파일, 확인 방법과 결과, 남은 문제.",
  ].join("\n");
}

// ---------- state
interface Instruction {
  /** The user's instruction text (context for the approval judge). */
  text: string;
  startedAt: number;
  asks: number;
  reviews: number;
  requests: Map<string, number>;
  /** Extra instructions the user sent while the team was working. */
  queued: { text: string; attachments: AttachmentRef[] }[];
  /** Extra instructions already handed over (repeated in later tool results). */
  pinned: string[];
}

interface Running {
  consultId: number;
  caller: Role;
  target: Role;
  kind: ConsultKind;
  message: string;
  scope: string[];
  text: string;
  files: Set<string>;
  pendingFiles: Map<string, string[]>;
  resolve: (r: { ok: boolean; interrupted?: boolean; error?: string }) => void;
}

export class Orchestrator {
  private bridgeKeys = new Map<string, { key: string; url: string }>();
  private instructions = new Map<number, Instruction>();
  /** Running consults per chat, by target worker. */
  private running = new Map<number, Map<Role, Running>>();
  /** Who waits on whom (caller → targets), for the cycle / depth guard. */
  private waits = new Map<number, WaitGraph>();
  /** One turn at a time per worker. */
  private workerQueue = new Map<string, Promise<unknown>>();
  /** Implement scopes currently held, per chat. */
  private scopeLocks = new Map<number, { consultId: number; scope: string[] }[]>();
  private scopeWaiters = new Map<number, (() => void)[]>();
  private asks = new Map<string, { chatId: number; resolve: (a: string) => void }>();
  private stopped = new Set<number>();
  /** /plan: the master is only planning (no asks) / running an approved plan. */
  private planning = new Set<number>();
  private planRunning = new Set<number>();
  readonly judge: ApprovalJudge;

  constructor(private chats: ChatManager) {
    this.judge = new ApprovalJudge(chats, (chatId, role) => {
      const r = role ? this.running.get(chatId)?.get(role) : undefined;
      return {
        instruction: this.instructions.get(chatId)?.text,
        consult: r ? { who: roleName(r.target, chats.store.listAgents(chatId)), kind: r.kind, message: r.message, scope: r.scope } : undefined,
      };
    });
    chats.judge = (chatId, request, input) => this.judge.decide(chatId, request, input);
    chats.writeScope = (chatId, role) => this.writeScope(chatId, role);
    chats.instructionsFor = (chat, project, role, agent) => {
      if (role === "orch") return masterInstructions(project, agent);
      const a = chats.store.agentByKey(chat.id, role);
      return a ? workerInstructions(a) : undefined;
    };
    chats.toolsFor = (chat, role) => ({ chatterbox_bridge: this.bridgeFor(chat.id, role) });
    chats.onDriverEvent = (chatId, role, event) => this.observe(chatId, role, event);
    chats.sendHandler = (chat, input) => this.instruct(chat, input);
    chats.busySend = (chat, input) => this.queue(chat, input);
  }

  private agents(chatId: number) {
    return this.chats.store.listAgents(chatId);
  }
  private name(chatId: number, role: Role) {
    return roleName(role, this.agents(chatId));
  }

  // ---------- bridge
  private bridgeFor(chatId: number, role: Role) {
    const id = `br-${chatId}-${role}`;
    let reg = this.bridgeKeys.get(id);
    if (!reg) {
      const master = role === "orch";
      reg = this.chats.bridge.register(
        {
          tools: master
            ? [SPAWN_TOOL, ASK_TOOL(true), ASK_PARALLEL_TOOL, RELEASE_TOOL, AGENTS_TOOL, CHECKLIST_TOOL, GOAL_TOOL, ASK_USER_TOOL]
            : [ASK_TOOL(false), AGENTS_TOOL],
          call: (name, args) => this.call(chatId, role, name, args),
        },
        id,
      );
      this.bridgeKeys.set(id, reg);
    }
    return bridgeServerConfig(this.chats.bridgeScript, reg.url);
  }

  private async call(chatId: number, caller: Role, name: string, args: any): Promise<ToolResult> {
    if (!this.chats.store.chat(chatId)) return textResult("채팅이 삭제되었습니다.", true);
    const master = caller === "orch";
    try {
      switch (name) {
        case "ask":
          return await this.askTool(chatId, caller, args);
        case "ask_parallel": {
          if (!master) break;
          const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : [];
          if (!tasks.length) return textResult("tasks가 비었습니다.", true);
          const results = await Promise.all(tasks.map((t) => this.askTool(chatId, caller, t)));
          return textResult(
            results.map((r, i) => `## ${i + 1}. ${String(tasks[i]?.to ?? "")}\n${r.content.map((c) => c.text).join("\n")}`).join("\n\n"),
            results.every((r) => r.isError),
          );
        }
        case "agents":
          return textResult(this.agentsText(chatId));
        case "spawn":
          if (!master) break;
          return this.spawn(chatId, args.kind === "gpt" ? "gpt" : "claude", String(args.job ?? ""));
        case "release":
          if (!master) break;
          return await this.release(chatId, String(args.nickname ?? ""));
        case "checklist":
          if (!master) break;
          return this.checklist(chatId, args.steps);
        case "update_goal":
          if (!master) break;
          return textResult(this.updateGoal(chatId, args.status, String(args.progress ?? "")));
        case "ask_user":
          if (!master) break;
          return textResult(await this.askUser(chatId, String(args.question ?? ""), Array.isArray(args.options) ? args.options.map(String) : []));
      }
      return textResult(`알 수 없는 도구: ${name}`, true);
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ---------- team
  private agentsText(chatId: number): string {
    const list = this.agents(chatId);
    if (!list.length) return "아직 작업자가 없습니다. spawn으로 만드세요.";
    const busy = this.running.get(chatId);
    return list
      .map((a) => {
        const r = busy?.get(a.key);
        const state = a.status === "released" ? "해제됨" : r ? `작업 중 (${CONSULT_KIND_LABEL[r.kind]}${r.scope.length ? ` · ${r.scope.join(", ")}` : ""})` : "대기";
        return `- ${a.nickname} (${a.kind === "claude" ? "Claude" : "GPT"}) · ${a.job || "역할 미정"} · ${state}`;
      })
      .join("\n");
  }

  private spawn(chatId: number, kind: WorkerKind, job: string): ToolResult {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    if (this.planning.has(chatId)) return textResult("지금은 계획 모드입니다. 작업자를 만들지 말고 계획만 세우세요.", true);
    const max = kind === "claude" ? project.settings.maxClaudeWorkers : project.settings.maxGptWorkers;
    const active = this.agents(chatId).filter((a) => a.kind === kind && a.status === "active").length;
    if (active >= max)
      return textResult(`${WORKER_KIND_LABEL[kind]}는 동시에 ${max}명까지입니다. 기존 작업자에게 맡기거나 다 쓴 작업자를 release 하세요.`, true);
    const a = this.chats.store.createAgent(chatId, kind, job);
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 합류${job ? ` · ${job}` : ""}` });
    return textResult(`${a.nickname}을(를) 만들었습니다. ask(to="${a.nickname}")로 일을 맡기세요.`);
  }

  private async release(chatId: number, nickname: string): Promise<ToolResult> {
    const a = this.agents(chatId).find((x) => x.nickname === nickname.trim());
    if (!a) return textResult(`그런 작업자가 없습니다: ${nickname}`, true);
    if (a.status === "released") return textResult(`${a.nickname}은(는) 이미 해제되었습니다.`);
    if (this.running.get(chatId)?.has(a.key)) return textResult(`${a.nickname}은(는) 아직 작업 중이라 해제할 수 없습니다.`, true);
    this.chats.store.updateAgent(a.id, { status: "released" });
    await this.chats.disposeRole(chatId, a.key);
    this.chats.agentsChanged(chatId);
    this.chats.emit(chatId, "orch", "orch", { type: "notice", text: `${a.nickname} 해제` });
    return textResult(`${a.nickname}을(를) 해제했습니다.`);
  }

  private checklist(chatId: number, raw: unknown): ToolResult {
    const steps: PlanStep[] = (Array.isArray(raw) ? raw : [])
      .map((s: any) => ({
        title: String(s?.title ?? "").trim(),
        status: (s?.status === "completed" || s?.status === "inProgress" ? s.status : "pending") as PlanStep["status"],
      }))
      .filter((s) => s.title);
    if (!steps.length) return textResult("steps가 비었습니다.", true);
    this.chats.emit(chatId, "orch", "orch", { type: "plan_update", steps });
    return textResult(`체크리스트를 갱신했습니다 (${steps.filter((s) => s.status === "completed").length}/${steps.length} 완료).`);
  }

  // ---------- ask (consult)
  private graph(chatId: number): WaitGraph {
    let g = this.waits.get(chatId);
    if (!g) this.waits.set(chatId, (g = new Map()));
    return g;
  }

  private async askTool(chatId: number, caller: Role, args: any): Promise<ToolResult> {
    const to = String(args.to ?? "").trim();
    const kind: ConsultKind = KINDS.includes(args.kind) ? args.kind : "implement";
    const message = String(args.message ?? "");
    const scope: string[] = kind === "implement" && Array.isArray(args.scope) ? args.scope.map(String).filter(Boolean) : [];
    const attach: string[] = Array.isArray(args.attach) ? args.attach.map(String) : [];
    const callerName = this.name(chatId, caller);

    if (to === MASTER_LABEL || to === "마스터" || to.toLowerCase() === "master")
      return textResult("마스터는 지금 팀의 결과를 기다리고 있어 바로 답할 수 없습니다(교착 방지). 질문은 결과 보고에 적어 주세요.", true);
    const target = this.agents(chatId).find((a) => a.nickname === to);
    if (!target) {
      const names = this.agents(chatId).filter((a) => a.status === "active").map((a) => a.nickname);
      return textResult(`그런 작업자가 없습니다: "${to}". 지금 팀: ${names.join(", ") || "(없음 — 마스터가 spawn으로 만듭니다)"}`, true);
    }
    if (target.status === "released") return textResult(`${target.nickname}은(는) 해제되었습니다.`, true);
    const refusal = checkAsk(this.graph(chatId), caller, target.key, MAX_DEPTH);
    if (refusal === "self") return textResult("자기 자신에게는 맡길 수 없습니다.", true);
    if (refusal === "cycle") {
      const msg = `교착 방지: ${target.nickname}은(는) 지금 ${callerName}의 결과를 기다리고 있어서, ${callerName}이(가) ${target.nickname}에게 다시 물을 수 없습니다.`;
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "notice", text: msg });
      return textResult(msg + " 직접 해결하거나 결과 보고에 적으세요.", true);
    }
    if (refusal === "depth")
      return textResult(`호출이 너무 깊습니다(최대 ${MAX_DEPTH}단계). 직접 처리하거나 결과 보고에 적으세요.`, true);
    return this.consult(chatId, caller, target, kind, message, scope, attach);
  }

  private limitCheck(chatId: number, project: Project, target: Role, kind: ConsultKind, message: string): string | null {
    const inst = this.instructions.get(chatId);
    if (!inst) return null;
    const s = project.settings;
    if (this.stopped.has(chatId)) return "사용자가 작업을 중지했습니다. 더 이상 맡기지 말고 멈추세요.";
    if (this.planning.has(chatId)) return "지금은 계획 모드입니다. 작업자에게 맡기지 말고 계획(체크리스트)만 세워 보고하세요.";
    const workers = this.agents(chatId).filter((a) => a.status === "active").length;
    const maxAsks = Math.min(MAX_ASKS_CAP, s.maxConsults + 4 * Math.max(0, workers - 2));
    if (inst.asks >= maxAsks) return `한도 도달: 이번 지시에서 ${maxAsks}번 맡겼습니다. 더 맡기지 말고 지금까지의 결과를 보고하세요.`;
    if (kind === "review" && inst.reviews >= s.maxReviews) return `한도 도달: 리뷰를 ${s.maxReviews}회 했습니다. 지금까지의 결과와 남은 지적 사항을 보고하세요.`;
    if (Date.now() - inst.startedAt > s.maxMinutes * 60_000) return `한도 도달: 이번 지시에 ${s.maxMinutes}분이 지났습니다. 지금까지의 결과를 보고하세요.`;
    const h = createHash("sha1").update(`${target}|${kind}|${message.trim()}`).digest("hex");
    const n = (inst.requests.get(h) ?? 0) + 1;
    inst.requests.set(h, n);
    if (n > 2) return "같은 요청을 이미 두 번 보냈습니다. 반복하지 말고 방법을 바꾸거나 지금까지의 결과를 보고하세요.";
    return null;
  }

  private async acquireScope(chatId: number, consultId: number, scope: string[]) {
    for (;;) {
      if (this.stopped.has(chatId)) return;
      const held = this.scopeLocks.get(chatId) ?? [];
      if (!held.some((h) => scopesOverlap(h.scope, scope))) {
        held.push({ consultId, scope });
        this.scopeLocks.set(chatId, held);
        return;
      }
      await new Promise<void>((res) => this.scopeWaiters.set(chatId, [...(this.scopeWaiters.get(chatId) ?? []), res]));
    }
  }
  private releaseScope(chatId: number, consultId: number) {
    this.scopeLocks.set(chatId, (this.scopeLocks.get(chatId) ?? []).filter((h) => h.consultId !== consultId));
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
  }

  private async consult(chatId: number, caller: Role, target: ChatAgent, kind: ConsultKind, message: string, scope: string[], attach: string[]): Promise<ToolResult> {
    const chat = this.chats.store.chat(chatId)!;
    const project = this.chats.store.project(chat.projectId)!;
    const callerName = this.name(chatId, caller);
    const limited = this.limitCheck(chatId, project, target.key, kind, message);
    if (limited) {
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "notice", text: `${target.nickname}에게 맡기기 거절 · ${limited.split(".")[0]}` });
      return textResult(limited + this.takeQueued(chatId), true);
    }
    const inst = this.instructions.get(chatId);
    if (inst) {
      inst.asks++;
      if (kind === "review") inst.reviews++;
    }

    // The caller is now waiting on the target (cycle / depth guard).
    addWait(this.graph(chatId), caller, target.key);
    const queueKey = `${chatId}:${target.key}`;
    const prev = this.workerQueue.get(queueKey) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    this.workerQueue.set(queueKey, prev.then(() => mine));
    try {
      await prev; // the target finishes its current turn first
      const attachments = this.attachmentsFor(chatId, attach);
      const consult = this.chats.store.createConsult(chatId, caller, target.key, kind, message, scope);
      this.chats.sink.consult(consult);
      const node = `consult:${consult.id}` as NodeId;
      // The card goes where the caller is (master's timeline, or inside the calling worker's consult).
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, {
        type: "consult_start",
        consultId: consult.id,
        kind,
        from: caller,
        to: target.key,
        request: message,
        attachments,
        scope,
      });
      if (kind === "implement") await this.acquireScope(chatId, consult.id, scope);
      this.chats.setRoute(chatId, target.key, node);

      const result = await new Promise<{ ok: boolean; interrupted?: boolean; error?: string; text: string; files: string[] }>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const r: Running = {
          consultId: consult.id,
          caller,
          target: target.key,
          kind,
          message,
          scope,
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
        const m = this.running.get(chatId) ?? new Map<Role, Running>();
        m.set(target.key, r);
        this.running.set(chatId, m);
        this.chats.agentsChanged(chatId);
        if (this.stopped.has(chatId)) return r.resolve({ ok: false, interrupted: true });
        if (inst) {
          const left = project.settings.maxMinutes * 60_000 - (Date.now() - inst.startedAt);
          timer = setTimeout(() => void this.chats.liveDriver(chatId, target.key)?.stop(), Math.max(1000, left));
        }
        void (async () => {
          try {
            const driver = await this.chats.driver(chatId, target.key);
            await driver.send({
              text: kindPrefix(kind, callerName, scope) + message,
              attachments,
              readOnlyTurn: kind !== "implement" || scope.length > 0,
            });
          } catch (e) {
            r.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });

      this.running.get(chatId)?.delete(target.key);
      this.chats.setRoute(chatId, target.key, undefined);
      if (kind === "implement") this.releaseScope(chatId, consult.id);
      this.chats.agentsChanged(chatId);
      const timedOut = inst ? Date.now() - inst.startedAt > project.settings.maxMinutes * 60_000 : false;
      const status = this.stopped.has(chatId) ? "stopped" : result.interrupted && timedOut ? "limited" : result.ok ? "done" : result.interrupted ? "stopped" : "error";
      const summary = result.text || result.error || "(답변 없음)";
      const finished = this.chats.store.finishConsult(consult.id, status, summary, result.files);
      this.chats.sink.consult(finished);
      this.chats.emit(chatId, this.chats.route(chatId, caller), caller, { type: "consult_end", consultId: consult.id, status, summary, files: result.files });

      const head =
        status === "done"
          ? `[${target.nickname} · ${CONSULT_KIND_LABEL[kind]} 결과]`
          : status === "stopped"
            ? `[${target.nickname}: 사용자가 중지했습니다. 더 맡기지 말고 멈추세요.]`
            : status === "limited"
              ? `[${target.nickname}: 시간 한도에 걸려 중단했습니다. 지금까지의 결과로 보고하세요.]`
              : `[${target.nickname}: 오류 — ${result.error ?? "실패"}]`;
      const files = result.files.length ? `\n\n변경된 파일:\n${result.files.map((f) => `- ${f}`).join("\n")}` : "\n\n변경된 파일: 없음";
      return textResult(`${head}\n${result.text || "(답변 없음)"}${files}${caller === "orch" ? this.takeQueued(chatId) : ""}`, status !== "done");
    } finally {
      removeWait(this.graph(chatId), caller, target.key);
      done();
    }
  }

  /** Writes a worker may make right now: its implement scope, nothing during review/opinion. */
  private writeScope(chatId: number, role: Role): { globs: string[] | null; why: string } | null {
    if (!isWorkerKey(role)) return null;
    const r = this.running.get(chatId)?.get(role);
    if (!r) return null;
    if (r.kind !== "implement") return { globs: [], why: `${CONSULT_KIND_LABEL[r.kind]} 요청 중에는 파일을 고치지 않습니다` };
    return r.scope.length ? { globs: r.scope, why: `맡은 범위(${r.scope.join(", ")}) 밖` } : null;
  }

  /** Collect each running consult's answer and changed files from the worker's events. */
  private observe(chatId: number, role: Role, event: AgentEvent) {
    if (role === "orch" && event.type === "turn_end") {
      this.afterMasterTurn(chatId, event);
      // Extra instructions that arrived after the master's last ask become the next turn.
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
    const r = this.running.get(chatId)?.get(role);
    if (!r) return;
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

  // ---------- user instructions
  /** The master moved to the other CLI (Claude ↔ GPT): hand its new session a summary of the chat so far. */
  private handover(chat: Chat): string {
    const project = this.chats.store.project(chat.projectId)!;
    const { agent } = chatOrchestrator(chat, project);
    const key = `orchAgent:${chat.id}`;
    const prev = this.chats.store.getSetting(key);
    this.chats.store.setSetting(key, agent);
    if (!prev || prev === agent) return "";
    const agents = this.agents(chat.id);
    const lines: string[] = [];
    for (const e of this.chats.store.events(chat.id)) {
      const ev = e.event;
      if (ev.type === "user" && ev.text) lines.push(`사용자: ${clipText(ev.text, 500)}`);
      else if (ev.type === "text" && e.role === "orch") lines.push(`마스터: ${clipText(ev.text, 500)}`);
      else if (ev.type === "consult_end")
        lines.push(`작업 결과(${ev.status}): ${clipText(ev.summary, 400)}${ev.files.length ? ` · 변경: ${ev.files.join(", ")}` : ""}`);
    }
    const team = agents.filter((a) => a.status === "active").map((a) => `${a.nickname}(${a.job || "역할 미정"})`).join(", ");
    const recent = lines.slice(-16).join("\n").slice(-6000);
    const name = (a: string) => (a === "claude" ? "Claude" : "GPT");
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: `마스터가 ${name(agent)}로 바뀌어 지금까지의 요약을 넘깁니다` });
    return `[AI_ChatterBox] 이 채팅의 마스터가 ${name(prev)}에서 ${name(agent)}로 바뀌었습니다.${team ? ` 지금 팀: ${team}.` : ""} 지금까지의 대화 요약:\n${recent}\n\n---\n`;
  }

  private async instruct(chat: Chat, input: AgentInput) {
    this.stopped.delete(chat.id);
    const prefix = this.handover(chat);
    if (prefix) input = { ...input, text: prefix + input.text };
    this.instructions.set(chat.id, { text: input.text, startedAt: Date.now(), asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    const driver = await this.chats.driver(chat.id, "orch");
    await driver.send({ ...input, text: input.text + attachmentNote(input.attachments) });
  }

  /** Start a master turn with prepared text (same bookkeeping as a normal instruction). */
  private async instructWith(chat: Chat, text: string, contextText: string) {
    await this.instruct(chat, { text, attachments: [] });
    const inst = this.instructions.get(chat.id);
    if (inst) inst.text = contextText;
  }

  /**
   * Continue a run the app quit or crashed in the middle of: the master resumes its session and is
   * told to check the folder and finish; workers keep their own sessions (agents table) for later asks.
   */
  async resume(chatId: number) {
    const chat = this.chats.store.chat(chatId);
    if (!chat || chat.status !== "interrupted") return;
    const last = [...this.chats.store.events(chatId)].reverse().find((e) => e.event.type === "user" && !e.event.queued)?.event as { text: string } | undefined;
    const original = last?.text ?? "";
    this.chats.emit(chatId, "orch", null, { type: "notice", text: "중단된 작업을 이어서 진행합니다" });
    this.chats.updateChat(chatId, { status: "working", touch: true });
    this.stopped.delete(chatId);
    this.instructions.set(chatId, { text: original, startedAt: Date.now(), asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    const team = this.agents(chatId).filter((a) => a.status === "active").map((a) => a.nickname).join(", ");
    const note =
      "[AI_ChatterBox] 이전 실행이 앱 종료로 중단됐습니다. 작업 폴더의 현재 상태(git status, git diff, 파일 내용)를 확인하고, " +
      `아래 원래 지시의 남은 작업을 이어서 끝낸 뒤 결과를 보고하세요. 이미 끝난 부분은 다시 하지 마세요.${team ? ` 팀(${team})은 그대로 남아 있습니다.` : ""}\n\n원래 지시:\n` +
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

  /** The user typed while the team was working: hand it to the master at the next boundary. */
  private async queue(chat: Chat, input: AgentInput) {
    const inst = this.instructions.get(chat.id);
    if (!inst) throw new Error("작업이 진행 중입니다.");
    inst.queued.push(input);
    this.chats.emit(chat.id, "orch", null, { type: "notice", text: "추가 지시를 받았습니다. 다음 단계에서 마스터에게 전달합니다." });
  }

  /** Extra instructions ride along with the master's next tool result, and stay pinned to later ones. */
  private takeQueued(chatId: number): string {
    const inst = this.instructions.get(chatId);
    if (!inst) return "";
    const fresh = inst.queued.splice(0);
    inst.pinned.push(...fresh.map((x) => x.text + attachmentNote(x.attachments)));
    if (!inst.pinned.length) return "";
    return "\n\n[사용자 추가 지시 — 작업 중에 도착함, 최종 보고까지 반드시 반영]\n" + inst.pinned.map((t) => `- ${t}`).join("\n");
  }

  // ---------- slash commands
  async command(chatId: number, name: string, arg: string) {
    const chat = this.chats.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    const busy = chat.status === "working" || chat.status === "approval" || this.chats.isBusy(chatId);
    const needIdle = () => {
      if (busy) throw new Error("작업이 진행 중입니다. 끝나거나 중지한 뒤 다시 시도하세요.");
    };
    switch (name) {
      case "plan": {
        needIdle();
        if (!arg.trim()) throw new Error("/plan 뒤에 계획할 지시를 적어 주세요.");
        this.planRunning.delete(chatId);
        this.planning.add(chatId);
        const text =
          "[계획 모드] 아래 지시에 대한 계획만 세워라. 작업자를 만들거나 맡기지 말고 파일도 바꾸지 마라. 필요한 만큼 코드를 읽고 조사한 뒤, " +
          "checklist 도구로 단계를 등록하라(각 단계 제목 앞에 담당 예정 [클로드 1호] / [지피티 1호] / [마스터], 몇 명이 필요한지도 계획에 넣어라). 마지막에 계획을 짧게 요약해 답하라. " +
          "사용자가 '실행'을 누르면 그때 이 계획대로 진행한다.\n\n지시: " +
          arg;
        await this.chats.startTurn(chatId, `/plan ${arg}`, [], () => this.instructWith(chat, text, arg));
        return;
      }
      case "plan-run": {
        needIdle();
        this.planning.delete(chatId);
        this.planRunning.add(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "running" });
        const text =
          "사용자가 계획을 승인했다. 계획대로 실행하라: 필요한 작업자를 spawn 하고, 단계마다 담당 작업자에게 ask로 맡기고(implement는 scope 지정), 단계를 시작·완료할 때마다 checklist를 갱신하고, " +
          "모든 단계를 완료로 표시한 뒤 결과를 보고하라.";
        await this.chats.startTurn(chatId, "계획 실행", [], () => this.instructWith(chat, text, "계획 실행"));
        return;
      }
      case "plan-cancel":
        this.planning.delete(chatId);
        this.planRunning.delete(chatId);
        this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "cancelled" });
        return;
      case "goal": {
        const a = arg.trim();
        if (!a) {
          this.chats.emit(chatId, "orch", null, {
            type: "notice",
            text: chat.goal ? `현재 목표: ${chat.goal.objective} (${goalStatusLabel(chat.goal.status)})` : "설정된 목표가 없습니다. /goal <목표> 로 정하세요.",
          });
          return;
        }
        if (a === "clear" || a === "지우기") {
          this.setGoal(chatId, null);
          this.chats.emit(chatId, "orch", null, { type: "notice", text: "목표를 지웠습니다." });
          return;
        }
        needIdle();
        this.setGoal(chatId, { objective: a, status: "active", progress: "", turns: 1, updatedAt: Date.now() });
        const text =
          `[목표] 이 채팅의 목표: ${a}\n이 목표를 이룰 때까지 일하라. checklist로 단계를 관리하고, 필요한 작업자를 만들어 맡기고, 단계마다 update_goal로 진행을 보고하라. ` +
          "목표를 다 이루면 update_goal(status=complete)로 알리고 결과를 보고하라.";
        await this.chats.startTurn(chatId, `/goal ${a}`, [], () => this.instructWith(chat, text, a));
        return;
      }
      case "review": {
        needIdle();
        const text =
          "현재 작업 폴더의 커밋되지 않은 변경(git status, git diff)을 리뷰해 줘. 변경을 직접 만들지 않은 작업자에게 kind=review로 맡기고(없으면 만들어서), 지적 사항을 심각도와 함께 정리해 보고해." +
          (arg ? ` 추가 요청: ${arg}` : "");
        await this.chats.startTurn(chatId, `/review${arg ? " " + arg : ""}`, [], () => this.instructWith(chat, text, text));
        return;
      }
      case "compact": {
        needIdle();
        const project = this.chats.store.project(chat.projectId)!;
        const { agent } = chatOrchestrator(chat, project);
        if (agent === "codex") {
          const threadId = chat.orchCodexThreadId;
          if (!threadId) throw new Error("아직 압축할 대화가 없습니다.");
          await this.chats.driver(chatId, "orch");
          await this.chats.codex().request("thread/compact/start", { threadId });
          this.chats.emit(chatId, "orch", null, { type: "notice", text: "마스터 대화를 압축했습니다 (Codex)." });
        } else {
          await this.chats.startTurn(chatId, "/compact", [], async () => {
            await (await this.chats.driver(chatId, "orch")).send({ text: "/compact", attachments: [] });
          });
        }
        return;
      }
      case "stop":
        await this.stop(chatId);
        return;
      default:
        throw new Error(`알 수 없는 명령: /${name}`);
    }
  }

  private setGoal(chatId: number, goal: ChatGoal | null) {
    this.chats.updateChat(chatId, { goal });
    this.chats.emit(chatId, "orch", null, { type: "goal_update", goal });
  }

  private updateGoal(chatId: number, status: string, progress: string): string {
    const chat = this.chats.store.chat(chatId);
    if (!chat?.goal) return "이 채팅에는 목표가 없습니다.";
    const st = status === "complete" || status === "blocked" ? status : "active";
    this.setGoal(chatId, { ...chat.goal, status: st, progress: progress || chat.goal.progress, updatedAt: Date.now() });
    return st === "complete" ? "목표 완료로 기록했습니다. 결과를 사용자에게 보고하세요." : "진행 상황을 기록했습니다.";
  }

  /** Plan proposals and goal auto-continuation after the master's turn. */
  private afterMasterTurn(chatId: number, end: Extract<AgentEvent, { type: "turn_end" }>) {
    if (this.planning.has(chatId)) {
      this.planning.delete(chatId);
      if (end.ok) this.chats.emit(chatId, "orch", null, { type: "plan_state", state: "proposed" });
    } else if (this.planRunning.has(chatId)) {
      this.planRunning.delete(chatId);
      this.chats.emit(chatId, "orch", null, { type: "plan_state", state: end.ok ? "done" : "cancelled" });
    }
    const chat = this.chats.store.chat(chatId);
    const goal = chat?.goal;
    if (!chat || !goal || goal.status !== "active" || !end.ok || end.interrupted || this.stopped.has(chatId)) return;
    if (goal.turns >= MAX_GOAL_TURNS) {
      this.setGoal(chatId, { ...goal, status: "paused", updatedAt: Date.now() });
      this.chats.emit(chatId, "orch", null, {
        type: "notice",
        text: `목표를 향해 ${MAX_GOAL_TURNS}번 이어서 진행했지만 끝나지 않아 멈췄습니다. 이어서 하려면 지시를 보내세요.`,
      });
      return;
    }
    setTimeout(() => {
      const c = this.chats.store.chat(chatId);
      if (!c?.goal || c.goal.status !== "active" || this.chats.isBusy(chatId) || c.status === "working") return;
      this.setGoal(chatId, { ...c.goal, turns: c.goal.turns + 1, updatedAt: Date.now() });
      const text = `[목표 계속] 목표: ${c.goal.objective}\n지금까지: ${c.goal.progress || "(보고 없음)"}\n남은 일을 이어서 하라. 다 이뤘으면 update_goal(status=complete)로 알리고 보고하라.`;
      void this.chats.startTurn(chatId, "목표를 향해 계속 진행", [], () => this.instructWith(c, text, c.goal!.objective));
    }, 300);
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
  private askUser(chatId: number, question: string, options: string[]): Promise<string> {
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
    // Wake anything waiting for a scope so it sees the stop.
    const w = this.scopeWaiters.get(chatId) ?? [];
    this.scopeWaiters.set(chatId, []);
    for (const f of w) f();
    await this.chats.stop(chatId);
  }

  forget(chatId: number) {
    this.judge.forget(chatId);
    for (const [id, reg] of [...this.bridgeKeys]) {
      if (!id.startsWith(`br-${chatId}-`)) continue;
      this.chats.bridge.unregister(reg.key);
      this.bridgeKeys.delete(id);
    }
    this.instructions.delete(chatId);
  }
}

function goalStatusLabel(s: string) {
  return s === "complete" ? "완료" : s === "blocked" ? "막힘" : s === "paused" ? "멈춤" : "진행 중";
}

function clipText(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function kindPrefix(kind: ConsultKind, from: string, scope: string[]): string {
  switch (kind) {
    case "implement":
      return `[${from}의 구현 요청${scope.length ? ` · 고칠 수 있는 범위: ${scope.join(", ")}` : ""}]\n`;
    case "review":
      return `[${from}의 리뷰 요청 — 파일을 고치지 말고 문제점만 보고하세요]\n`;
    default:
      return `[${from}의 의견 요청 — 파일을 고치지 마세요]\n`;
  }
}

/** The master sees images inline but needs paths to hand files to workers. */
function attachmentNote(files: AttachmentRef[]): string {
  if (!files.length) return "";
  return "\n\n[첨부 파일 경로 — 작업자에게 넘길 때 attach에 사용]\n" + files.map((f) => `- ${f.path}`).join("\n");
}

/** Project-relative path (for scope checks). */
export function relToProject(folder: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolvePath(folder, p);
  const rel = relative(folder, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

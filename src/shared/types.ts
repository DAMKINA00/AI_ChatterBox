// Types shared by main, preload and renderer.
import type { ProviderUsage } from "./usage";

export type AgentKind = "claude" | "codex";

export const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/**
 * Who said / did something in a chat: "orch" = the master (마스터), or "w<agent id>" = a worker
 * (클로드 N호 / 지피티 N호). Workers are created and released by the master as the work needs.
 */
export type Role = "orch" | `w${number}`;

export const MASTER_LABEL = "마스터";

export type WorkerKind = "claude" | "gpt";
export const WORKER_KIND_LABEL: Record<WorkerKind, string> = { claude: "클로드", gpt: "지피티" };
export const WORKER_AGENT: Record<WorkerKind, AgentKind> = { claude: "claude", gpt: "codex" };

export interface ChatAgent {
  id: number;
  chatId: number;
  /** Role key used in events: `w${id}` */
  key: Role;
  kind: WorkerKind;
  /** Per chat and kind, never reused. */
  number: number;
  /** "클로드 2호" */
  nickname: string;
  /** What the master spawned it for. */
  job: string;
  sessionId: string | null;
  status: "active" | "released";
  createdAt: number;
}

export const workerKey = (id: number): Role => `w${id}`;
export const isWorkerKey = (r: string): r is `w${number}` => /^w\d+$/.test(r);

/** Display name for a role key. */
export function roleName(role: Role | null | undefined, agents: ChatAgent[] | undefined): string {
  if (!role || role === "orch") return MASTER_LABEL;
  return agents?.find((a) => a.key === role)?.nickname ?? "작업자";
}

/** "claude" | "gpt" | "orch" — for colors. */
export function roleTone(role: Role | null | undefined, agents: ChatAgent[] | undefined): "orch" | WorkerKind {
  if (!role || role === "orch") return "orch";
  return agents?.find((a) => a.key === role)?.kind ?? "claude";
}

/** Orchestrator model, encoded as "<agent>:<model id>", e.g. "claude:opus" or "codex:gpt-6-astra". */
export type OrchestratorModel = `${AgentKind}:${string}`;

/** The orchestrator model a chat uses (its own override, else the project's). */
export function chatOrchestrator(chat: { orchestratorModelOverride: string | null }, project: { settings: { orchestratorModel: string } }) {
  return parseOrchestrator(chat.orchestratorModelOverride ?? project.settings.orchestratorModel);
}

export function parseOrchestrator(m: string): { agent: AgentKind; model: string } {
  const i = m.indexOf(":");
  const agent = m.slice(0, i) === "codex" ? "codex" : "claude";
  return { agent, model: m.slice(i + 1) };
}

export interface ProjectSettings {
  orchestratorModel: OrchestratorModel;
  /** Claude worker --model value (alias or id). */
  claudeModel: string;
  /** GPT worker model id (Codex model/list). */
  codexModel: string;
  /** Lead must get a Codex/Claude review before finishing code changes. */
  reviewGate: boolean;
  /** Max consults per user instruction. */
  maxConsults: number;
  /** Max review round-trips per user instruction. */
  maxReviews: number;
  /** Minutes per user instruction before the lead is told to wrap up. */
  maxMinutes: number;
  /** Max workers of each kind alive at once in a chat. */
  maxClaudeWorkers: number;
  maxGptWorkers: number;
  /** Who answers workers' approval requests. */
  approvalMode: ApprovalMode;
  /** Let the orchestrator also allow high-risk requests (otherwise they go to the user). */
  delegateHighRisk: boolean;
}

export type ApprovalMode = "orchestrator" | "user";
export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  orchestrator: "마스터 자동 판단",
  user: "매번 직접 승인",
};

/** Prefills the new-project form only. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

export interface Project {
  id: number;
  name: string;
  folder: string;
  settings: ProjectSettings;
  createdAt: number;
  archived: boolean;
}

/** interrupted = the app was quit or crashed mid-run; the chat offers "이어서 진행". */
export type ChatStatus = "idle" | "working" | "approval" | "done" | "error" | "interrupted";

export interface Chat {
  id: number;
  projectId: number;
  title: string;
  /** Orchestrator conversations, one per CLI (the project may switch the orchestrator's CLI). */
  orchClaudeSessionId: string | null;
  orchCodexThreadId: string | null;
  /** Worker conversations. */
  claudeSessionId: string | null;
  codexThreadId: string | null;
  /** Per-chat model overrides; null = follow the project. */
  orchestratorModelOverride: OrchestratorModel | null;
  claudeModelOverride: string | null;
  codexModelOverride: string | null;
  /** Per-chat approval mode; null = follow the project. */
  approvalModeOverride: ApprovalMode | null;
  goal: ChatGoal | null;
  status: ChatStatus;
  unread: boolean;
  archived: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export type ConsultKind = "implement" | "review" | "opinion";
export type ConsultStatus = "running" | "done" | "error" | "stopped" | "limited";

export const CONSULT_KIND_LABEL: Record<ConsultKind, string> = { implement: "구현", review: "리뷰", opinion: "의견" };

export interface Consult {
  id: number;
  chatId: number;
  seq: number;
  fromRole: Role;
  toRole: Role;
  /** implement: path globs the worker may write (relative to the project folder). */
  scope: string[];
  kind: ConsultKind;
  request: string;
  responseSummary: string | null;
  filesChanged: string[];
  status: ConsultStatus;
  startedAt: number;
  endedAt: number | null;
}

/** Which conversation an event belongs to; worker turns run on behalf of a consult carry its node. */
export type NodeId = Role | `consult:${number}`;

export interface AttachmentRef {
  id: number;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface FileDiff {
  path: string;
  kind: "add" | "update" | "delete";
  /** Unified diff text (may be empty when unknown). */
  diff: string;
}

export type Risk = "low" | "high";

export interface ApprovalRequest {
  id: string;
  role: Role;
  /** e.g. "Write", "명령 실행", "파일 변경" */
  title: string;
  /** Command line, path, or JSON of the input. */
  detail: string;
  reason?: string;
  risk: Risk;
  riskReason?: string;
  diffs?: FileDiff[];
  /** Why the orchestrator handed this one to the user. */
  judgeReason?: string;
}

export type ApprovalDecision = "once" | "chat" | "deny";

/** Normalized event stream. Every event also carries the agent that produced it (see TimelineEvent). */
export type AgentEvent =
  | { type: "user"; text: string; attachments: AttachmentRef[]; queued?: boolean }
  | { type: "text_delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: string; diffs?: FileDiff[] }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "file_change"; id: string; files: FileDiff[]; ok: boolean }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision | "auto" | "expired" }
  /** An approval the orchestrator (or a remembered decision) answered without the user. */
  | { type: "approval_auto"; request: ApprovalRequest; decision: "allow" | "deny"; reason: string; reused?: boolean }
  | { type: "consult_start"; consultId: number; kind: ConsultKind; from: Role; to: Role; request: string; attachments: AttachmentRef[]; scope?: string[] }
  | { type: "consult_end"; consultId: number; status: ConsultStatus; summary: string; files: string[] }
  | { type: "ask_user"; id: string; question: string; options: string[] }
  | { type: "ask_user_answer"; id: string; answer: string }
  | { type: "notice"; text: string }
  /** Checklist from the orchestrator's native plan tool (Claude TodoWrite / Codex update_plan). */
  | { type: "plan_update"; steps: PlanStep[]; explanation?: string }
  /** /plan proposal lifecycle: proposed → running → done / cancelled. */
  | { type: "plan_state"; state: "proposed" | "running" | "done" | "cancelled" }
  | { type: "goal_update"; goal: ChatGoal | null }
  | { type: "turn_end"; ok: boolean; error?: string; interrupted?: boolean }
  | { type: "error"; message: string; kind?: "auth" | "missing_cli" | "process" };

export interface PlanStep {
  title: string;
  status: "pending" | "inProgress" | "completed";
}

export type GoalStatus = "active" | "complete" | "blocked" | "paused";

/** /goal: a persistent objective the orchestrator keeps working toward across turns. */
export interface ChatGoal {
  objective: string;
  status: GoalStatus;
  /** Latest progress note from the orchestrator. */
  progress: string;
  /** Turns spent on it so far (auto-continuation is bounded). */
  turns: number;
  updatedAt: number;
}

export interface TimelineEvent {
  id: number;
  chatId: number;
  node: NodeId;
  /** Role that produced the event (null for the user). */
  role: Role | null;
  at: number;
  event: AgentEvent;
}

export interface CliInfo {
  agent: AgentKind;
  path: string | null;
  error?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  /** The CLI hides it from pickers. */
  hidden?: boolean;
  /** The CLI offers an upgrade (a newer model replaces it). */
  deprecated?: boolean;
}

export type Theme = "dark" | "light";

/** Rate-limit usage per provider (see shared/usage.ts for what is displayed). */
export interface UsageInfo {
  claude?: ProviderUsage;
  codex?: ProviderUsage;
}

export interface ChatterBoxApi {
  // projects
  listProjects(): Promise<Project[]>;
  createProject(input: { name: string; folder: string; settings: ProjectSettings }): Promise<Project>;
  updateProject(id: number, patch: { name?: string; folder?: string; settings?: ProjectSettings; archived?: boolean }): Promise<Project>;
  deleteProject(id: number): Promise<void>;
  pickFolder(): Promise<string | null>;
  // chats
  listChats(): Promise<Chat[]>;
  createChat(projectId: number): Promise<Chat>;
  updateChat(
    id: number,
    patch: {
      title?: string;
      archived?: boolean;
      orchestratorModelOverride?: OrchestratorModel | null;
      claudeModelOverride?: string | null;
      codexModelOverride?: string | null;
      approvalModeOverride?: ApprovalMode | null;
    },
  ): Promise<Chat>;
  deleteChat(id: number): Promise<void>;
  markViewed(id: number): Promise<void>;
  listConsults(chatId: number): Promise<Consult[]>;
  listAgents(chatId: number): Promise<ChatAgent[]>;
  loadEvents(chatId: number): Promise<TimelineEvent[]>;
  /** Chat ids whose messages contain the text. */
  searchChats(q: string): Promise<number[]>;
  send(chatId: number, text: string, attachmentIds: number[]): Promise<void>;
  stop(chatId: number): Promise<void>;
  /** Continue a run the app quit or crashed in the middle of. */
  resume(chatId: number): Promise<void>;
  /** Slash command from the composer: /plan, /goal, /review, /compact … */
  command(chatId: number, name: string, arg: string): Promise<void>;
  dismissInterrupted(chatId: number): Promise<void>;
  answerApproval(chatId: number, approvalId: string, decision: ApprovalDecision): Promise<void>;
  answerAskUser(chatId: number, askId: string, answer: string): Promise<void>;
  // attachments
  attachFromPaths(chatId: number, paths: string[]): Promise<AttachmentRef[]>;
  attachFromBytes(chatId: number, name: string, mime: string, bytes: Uint8Array): Promise<AttachmentRef>;
  pickAttachments(chatId: number): Promise<AttachmentRef[]>;
  removeAttachment(id: number): Promise<void>;
  pathForFile(file: File): string;
  // misc
  cliInfo(): Promise<CliInfo[]>;
  models(agent: AgentKind): Promise<ModelOption[]>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
  usage(): Promise<UsageInfo>;
  openPath(path: string): Promise<void>;
  // push events
  onEvent(cb: (e: TimelineEvent) => void): () => void;
  onChatUpdated(cb: (chat: Chat) => void): () => void;
  onConsultUpdated(cb: (consult: Consult) => void): () => void;
  onAgentsUpdated(cb: (chatId: number, agents: ChatAgent[]) => void): () => void;
  onUsage(cb: (u: UsageInfo) => void): () => void;
  /** Main asks to show a chat (tray notification clicked). */
  onSelectChat(cb: (chatId: number) => void): () => void;
}

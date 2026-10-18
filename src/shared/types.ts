// Types shared by main, preload and renderer.
import type { ProviderUsage } from "./usage";

export type AgentKind = "claude" | "codex" | "gemini" | "grok";
export const GEMINI_WEB_MODEL = "gemini-web-argon";
export type GeminiWebAccountId = `gemini-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
export const GEMINI_WRITING_INSTRUCTIONS = "기본 글쓰기 담당은 Antigravity/Gemini다. 사용자가 다른 작업을 명시적으로 지정하면 해당 요청을 수행한다. 사용 가능한 도구만 사용하고, 없는 기능이나 실행하지 않은 결과를 꾸며내지 않는다.";

export interface GeminiWebUsage {
  status: "unknown" | "available" | "limited" | "error";
  detail: string;
  checkedAt: number;
  remaining?: number;
  limit?: number;
  resetText?: string;
  current?: { usedPercent: number; resetText?: string };
  weekly?: { usedPercent: number; resetText?: string };
}

export interface GeminiWebStatus {
  accountId: GeminiWebAccountId;
  state: "closed" | "login_required" | "ready" | "busy" | "error";
  message: string;
  model?: string;
  checkedAt: number;
  usage: GeminiWebUsage;
}

export interface GeminiWebAccountStatus extends GeminiWebStatus {
  label: string;
  enabled: boolean;
  remainingPercent?: number;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}
export interface AgentMetrics extends TokenCounts {
  turnId: string;
  elapsedMs: number;
  model?: string;
  /** The option sent to the CLI; provider-side policy can further cap it. */
  reasoningEffort?: string;
  approximate?: boolean;
  /** Native thread cumulative counters, used only as a resume baseline. */
  nativeId?: string;
  total?: TokenCounts;
}

export const AGENT_EXPRESSIONS = ["neutral", "thinking", "speaking", "happy", "confident", "surprised", "embarrassed", "worried", "sad", "angry", "tired", "waiting"] as const;
export type AgentExpression = (typeof AGENT_EXPRESSIONS)[number];
export function isAgentExpression(value: unknown): value is AgentExpression {
  return typeof value === "string" && (AGENT_EXPRESSIONS as readonly string[]).includes(value);
}

export const AGENT_LABEL: Record<AgentKind, string> = { claude: "클로드", codex: "지피티", gemini: "제미나이", grok: "그록" };

/**
 * Who said / did something in a chat: "orch" = the master (마스터), or "w<agent id>" = a worker
 * (클로드 N호 / 지피티 N호). Workers are created and released by the master as the work needs.
 */
export type Role = "orch" | `w${number}`;

export const MASTER_LABEL = "마스터";

export type WorkerKind = "claude" | "gpt" | "gemini" | "grok";
export const WORKER_KIND_LABEL: Record<WorkerKind, string> = { claude: "클로드", gpt: "지피티", gemini: "제미나이", grok: "그록" };
export const WORKER_AGENT: Record<WorkerKind, AgentKind> = { claude: "claude", gpt: "codex", gemini: "gemini", grok: "grok" };

export interface ChatAgent {
  id: number;
  chatId: number;
  /** Role key used in events: `w${id}` */
  key: Role;
  kind: WorkerKind;
  /** Stable per chat/kind; reactivation keeps the same worker identity and number. */
  number: number;
  /** "클로드 2호" */
  nickname: string;
  /** What the master spawned it for. */
  job: string;
  sessionId: string | null;
  /** Gemini web account explicitly selected by the master; absent on legacy/unbound workers. */
  webAccountId?: GeminiWebAccountId;
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
  const prefix = m.slice(0, i);
  const agent: AgentKind = ["claude", "codex", "gemini", "grok"].includes(prefix) ? prefix as AgentKind : "claude";
  return { agent, model: m.slice(i + 1) };
}

export interface ProjectSettings {
  claudeStrengths: string;
  claudeCautions: string;
  gptStrengths: string;
  gptCautions: string;
  geminiStrengths: string;
  geminiCautions: string;
  orchestratorModel: OrchestratorModel;
  /** Claude worker --model value (alias or id). */
  claudeModel: string;
  /** GPT worker model id (Codex model/list). */
  codexModel: string;
  /** Antigravity model slug. Empty selects an available Pro-compatible Gemini model. */
  geminiModel: string;
  grokModel: string;
  grokStrengths: string;
  grokCautions: string;
  /** Empty = CLI default; auto = master chooses medium/high/xhigh for each worker assignment. */
  orchestratorEffort: string;
  claudeEffort: string;
  codexEffort: string;
  geminiEffort: string;
  grokEffort: string;
  /** Lead must get a Codex/Claude review before finishing code changes. */
  reviewGate: boolean;
  /** Max consults per user instruction. */
  maxConsults: number;
  /** Max review round-trips per user instruction. */
  maxReviews: number;
  /** Max workers of each kind alive at once in a chat. */
  maxClaudeWorkers: number;
  maxGptWorkers: number;
  maxGeminiWorkers: number;
  maxGrokWorkers: number;
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

export const MAX_CONSULTS = 999;
export const MAX_REVIEWS = 99;
/** Defaults for new projects and settings absent in older project records. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  claudeStrengths: "기술 업무의 기본 담당. 소스 분석·원인 조사·구현·테스트·문서의 기술 검증과 파일 제작·모션그래픽·애니메이션 제작을 우선 배정합니다. 문서 본문과 대사 작성·문장 다듬기는 제미나이에게 맡깁니다.",
  claudeCautions: "이미지는 도구를 사용할 수 있는 지피티에게 맡깁니다. 중요한 버그·오류는 지피티와 각각 조사합니다. 사용 한도·작업량으로 지연되면 재배정합니다.",
  gptStrengths: "이미지 생성·편집, 중요한 버그·오류의 독립 조사 및 필요한 교차검증.",
  gptCautions: "일반 분석·구현·테스트·문서 파일 제작과 모션그래픽은 클로드 우선입니다. 글쓰기는 제미나이에게 맡깁니다. 이미지 도구가 필요하거나 교차검증의 필요성이 크거나 클로드가 실행 불가·과부하일 때 배정합니다.",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  geminiModel: "",
  grokModel: "",
  grokStrengths: "사용자가 지정한 작업, 조사·구현·이미지 생성과 동료 협업.",
  grokCautions: "실제 CLI·모델·도구 제공 여부를 확인하고 불가능한 기능은 실행한 것처럼 보고하지 않습니다.",
  orchestratorEffort: "xhigh",
  claudeEffort: "auto",
  codexEffort: "auto",
  geminiEffort: "auto",
  grokEffort: "auto",
  geminiStrengths: "문장 다듬기, 대사·시나리오, 문서 작성·요약·번역을 우선 배정하며 명시적으로 지정한 다른 작업도 수행합니다.",
  geminiCautions: "CLI는 승인과 작업 범위 안에서 코드·이미지 도구를 사용합니다. Gemini 웹은 로컬 파일·명령·MCP를 실행할 수 없습니다. 실제 계정에서 제공되는 모델과 도구만 사용합니다.",
  reviewGate: true,
  maxConsults: 100,
  maxReviews: 20,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  maxGeminiWorkers: 1,
  maxGrokWorkers: 3,
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
export type ChatStatus = "idle" | "working" | "approval" | "pausing" | "paused" | "done" | "error" | "interrupted";

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
  geminiModelOverride: string | null;
  grokModelOverride: string | null;
  orchestratorEffortOverride: string | null;
  claudeEffortOverride: string | null;
  codexEffortOverride: string | null;
  geminiEffortOverride: string | null;
  grokEffortOverride: string | null;
  /** Per-chat approval mode; null = follow the project. */
  approvalModeOverride: ApprovalMode | null;
  goal: ChatGoal | null;
  status: ChatStatus;
  unread: boolean;
  archived: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export type ConsultKind = "implement" | "review" | "opinion" | "writing";
export type ConsultStatus = "running" | "done" | "error" | "stopped" | "limited";

export const CONSULT_KIND_LABEL: Record<ConsultKind, string> = { implement: "구현", review: "리뷰", opinion: "의견", writing: "글쓰기" };

export interface Consult {
  /** Requested by the master and actually applied, retained with this assignment. */
  requestedEffort?: string;
  effort?: string;
  /** Failed assignment this retry/reassignment replaces. */
  supersedes?: number;
  /** User instruction event id; absent in records before 0.3.2. */
  instructionId?: number;
  reason?: string;
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
  /** Rename destination; both source and destination must pass scope checks. */
  movePath?: string;
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
  | { type: "peer_message"; from: Role; to: Role; text: string }
  | { type: "artifacts"; paths: string[] }
  | { type: "agent_usage"; metrics: AgentMetrics }
  | { type: "dispatch"; instructionId: number; mode: "direct" | "delegated"; reason: string; dualInvestigation?: boolean }
  | { type: "image_generation"; id: string; status: "running" | "done" | "error"; prompt?: string; attachment?: AttachmentRef; error?: string }
  | { type: "expression"; expression: AgentExpression }
  | { type: "user"; text: string; attachments: AttachmentRef[]; queued?: boolean; delivery?: "now" | "next" }
  | { type: "text_delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: string; diffs?: FileDiff[] }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "file_change"; id: string; files: FileDiff[]; ok: boolean }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision | "auto" | "expired" }
  /** An approval the orchestrator (or a remembered decision) answered without the user. */
  | { type: "approval_auto"; request: ApprovalRequest; decision: "allow" | "deny"; reason: string; reused?: boolean }
  | { type: "consult_start"; consultId: number; kind: ConsultKind; from: Role; to: Role; request: string; attachments: AttachmentRef[]; scope?: string[]; instructionId?: number; reason?: string }
  | { type: "consult_end"; consultId: number; status: ConsultStatus; summary: string; files: string[] }
  | { type: "ask_user"; id: string; question: string; options: string[] }
  | { type: "ask_user_answer"; id: string; answer: string }
  | { type: "notice"; text: string; webAccountId?: GeminiWebAccountId }
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
  authStatus?: "authenticated" | "required" | "unknown";
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
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export type Theme = "dark" | "light";

/** Rate-limit usage per provider (see shared/usage.ts for what is displayed). */
export interface UsageInfo {
  claude?: ProviderUsage;
  codex?: ProviderUsage;
  gemini?: ProviderUsage;
  grok?: ProviderUsage;
  geminiWeb?: GeminiWebUsage;
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
      geminiModelOverride?: string | null;
      grokModelOverride?: string | null;
      orchestratorEffortOverride?: string | null;
      claudeEffortOverride?: string | null;
      codexEffortOverride?: string | null;
      geminiEffortOverride?: string | null;
      grokEffortOverride?: string | null;
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
  send(chatId: number, text: string, attachmentIds: number[], delivery?: "now" | "next"): Promise<void>;
  stop(chatId: number): Promise<void>;
  pause(chatId: number): Promise<void>;
  /** Continue a run the app quit or crashed in the middle of. */
  resume(chatId: number): Promise<void>;
  /** Slash command from the composer: /plan, /goal, /review, /compact … */
  command(chatId: number, name: string, arg: string): Promise<void>;
  dismissInterrupted(chatId: number): Promise<void>;
  answerApproval(chatId: number, approvalId: string, decision: ApprovalDecision): Promise<ApprovalDecision | null>;
  answerAskUser(chatId: number, askId: string, answer: string): Promise<void>;
  // attachments
  attachFromPaths(chatId: number, paths: string[]): Promise<AttachmentRef[]>;
  attachFromBytes(chatId: number, name: string, mime: string, bytes: Uint8Array): Promise<AttachmentRef>;
  pickAttachments(chatId: number): Promise<AttachmentRef[]>;
  removeAttachment(id: number): Promise<void>;
  pathForFile(file: File): string;
  // misc
  cliInfo(checkAuth?: boolean): Promise<CliInfo[]>;
  models(agent: AgentKind): Promise<ModelOption[]>;
  geminiWeb(action: "status" | "open" | "login" | "refresh", accountId?: GeminiWebAccountId): Promise<GeminiWebStatus>;
  geminiWebAccounts(action: "list" | "add" | "update", input?: { accountId?: GeminiWebAccountId; label?: string; enabled?: boolean }): Promise<GeminiWebAccountStatus[]>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
  usage(): Promise<UsageInfo>;
  openPath(path: string): Promise<void>;
  previewImage(chatId: number, href: string): Promise<AttachmentRef | null>;
  linkAction(chatId: number, href: string, action: "open" | "reveal" | "save"): Promise<{ canceled?: boolean; path?: string }>;
  // push events
  onEvent(cb: (e: TimelineEvent) => void): () => void;
  onChatUpdated(cb: (chat: Chat) => void): () => void;
  onConsultUpdated(cb: (consult: Consult) => void): () => void;
  onAgentsUpdated(cb: (chatId: number, agents: ChatAgent[]) => void): () => void;
  onUsage(cb: (u: UsageInfo) => void): () => void;
  onGeminiWebLogin(cb: (status: GeminiWebStatus) => void): () => void;
  /** Main asks to show a chat (tray notification clicked). */
  onSelectChat(cb: (chatId: number) => void): () => void;
}

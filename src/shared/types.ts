// Types shared by main, preload and renderer.

export type AgentKind = "claude" | "codex";

export const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/** A chat has three conversations: the orchestrator and two workers. */
export type Role = "orch" | "claude" | "gpt";

export const ROLE_LABEL: Record<Role, string> = { orch: "오케스트레이터", claude: "Claude", gpt: "GPT" };
export const WORKER_AGENT: Record<"claude" | "gpt", AgentKind> = { claude: "claude", gpt: "codex" };

/** Orchestrator model, encoded as "<agent>:<model id>", e.g. "claude:opus" or "codex:gpt-6-astra". */
export type OrchestratorModel = `${AgentKind}:${string}`;

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
}

/** Prefills the new-project form only. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
};

export interface Project {
  id: number;
  name: string;
  folder: string;
  settings: ProjectSettings;
  createdAt: number;
  archived: boolean;
}

export type ChatStatus = "idle" | "working" | "approval" | "done" | "error";

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
  /** Per-chat worker model overrides; null = follow the project. */
  claudeModelOverride: string | null;
  codexModelOverride: string | null;
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
  | { type: "consult_start"; consultId: number; kind: ConsultKind; from: Role; to: Role; request: string; attachments: AttachmentRef[] }
  | { type: "consult_end"; consultId: number; status: ConsultStatus; summary: string; files: string[] }
  | { type: "ask_user"; id: string; question: string; options: string[] }
  | { type: "ask_user_answer"; id: string; answer: string }
  | { type: "notice"; text: string }
  | { type: "turn_end"; ok: boolean; error?: string; interrupted?: boolean }
  | { type: "error"; message: string; kind?: "auth" | "missing_cli" | "process" };

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
}

export type Theme = "dark" | "light";

export interface UsageInfo {
  claude?: { fiveHour?: number; resetsAt?: number; status?: string };
  codex?: { primary?: { usedPercent: number; resetsAt?: number | null }; secondary?: { usedPercent: number; resetsAt?: number | null } };
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
    patch: { title?: string; archived?: boolean; claudeModelOverride?: string | null; codexModelOverride?: string | null },
  ): Promise<Chat>;
  deleteChat(id: number): Promise<void>;
  markViewed(id: number): Promise<void>;
  listConsults(chatId: number): Promise<Consult[]>;
  loadEvents(chatId: number): Promise<TimelineEvent[]>;
  /** Chat ids whose messages contain the text. */
  searchChats(q: string): Promise<number[]>;
  send(chatId: number, text: string, attachmentIds: number[]): Promise<void>;
  stop(chatId: number): Promise<void>;
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
  onUsage(cb: (u: UsageInfo) => void): () => void;
}

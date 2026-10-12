// Types shared by main, preload and renderer.

export type AgentKind = "claude" | "codex";

export type SessionStatus = "idle" | "running" | "error";

export interface Workspace {
  id: number;
  path: string;
  name: string;
  createdAt: number;
}

export interface Session {
  id: number;
  workspaceId: number;
  agent: AgentKind;
  /** Claude session_id / Codex thread id; null until the CLI reports it. */
  nativeId: string | null;
  title: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRequest {
  /** Opaque id used to route the answer back to the driver. */
  id: string;
  /** Short label, e.g. "명령 실행" or the tool name. */
  title: string;
  /** Command line, file path, or JSON of the tool input. */
  detail: string;
  reason?: string;
}

/** Normalized event stream emitted by every AgentDriver. */
export type AgentEvent =
  | { type: "user"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: string }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "file_change"; id: string; summary: string; ok: boolean }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "turn_end"; ok: boolean; error?: string; interrupted?: boolean }
  | { type: "error"; message: string; kind?: "auth" | "missing_cli" | "process" };

export type ApprovalDecision = "allow" | "deny";

export interface StoredEvent {
  id: number;
  sessionId: number;
  at: number;
  event: AgentEvent;
}

export interface AppSettings {
  claudePath?: string;
  codexPath?: string;
}

export interface CliInfo {
  agent: AgentKind;
  path: string | null;
  error?: string;
}

/** API exposed to the renderer through the preload bridge. */
export interface ChatterBoxApi {
  listWorkspaces(): Promise<Workspace[]>;
  pickWorkspace(): Promise<Workspace | null>;
  listSessions(workspaceId: number): Promise<Session[]>;
  createSession(workspaceId: number, agent: AgentKind): Promise<Session>;
  loadEvents(sessionId: number): Promise<StoredEvent[]>;
  send(sessionId: number, text: string): Promise<void>;
  stop(sessionId: number): Promise<void>;
  answerApproval(sessionId: number, approvalId: string, decision: ApprovalDecision): Promise<void>;
  cliInfo(): Promise<CliInfo[]>;
  onEvent(cb: (sessionId: number, event: AgentEvent) => void): () => void;
  onSessionUpdated(cb: (session: Session) => void): () => void;
}

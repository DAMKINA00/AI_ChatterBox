import type { AgentEvent, AgentKind, ApprovalDecision } from "../../shared/types";

export interface DriverCallbacks {
  onEvent(event: AgentEvent): void;
  /** Claude session_id / Codex thread id, once known. */
  onNativeId(id: string): void;
}

/** One chat session backed by a CLI. Emits normalized AgentEvents through DriverCallbacks. */
export interface AgentDriver {
  readonly agent: AgentKind;
  /** Starts a turn. Resolves once the input is handed to the CLI, not when the turn ends. */
  send(text: string): Promise<void>;
  /** Interrupts the running turn, if any. */
  stop(): Promise<void>;
  answerApproval(approvalId: string, decision: ApprovalDecision): void;
  /** Ends the backing process (stdin EOF, then kill the tree). */
  dispose(): Promise<void>;
}

export interface DriverOptions {
  cwd: string;
  /** Existing native id to resume, or null for a new conversation. */
  nativeId: string | null;
  exePath: string;
}

import type { AgentEvent, AgentKind, AttachmentRef, UsageInfo, TokenCounts } from "../../shared/types";
import type { ApprovalInput, VerdictResult } from "../approvals";

export interface AgentInput {
  text: string;
  attachments: AttachmentRef[];
  /** Enforced planning/review turn: never grant mutations or shell escalation. */
  noWrites?: boolean;
}

/** What a driver needs from the chat that owns it. */
export interface DriverHost {
  image?(image: { id: string; path?: string; base64?: string }): AttachmentRef;
  emit(event: AgentEvent): void;
  /** Claude session_id / Codex thread id, once known. */
  nativeId(id: string): void;
  approve(input: Omit<ApprovalInput, "role" | "node">): Promise<VerdictResult>;
  usage?(u: UsageInfo): void;
}

/** One conversation backed by a CLI. Emits normalized AgentEvents through DriverHost. */
export interface AgentDriver {
  readonly agent: AgentKind;
  readonly running: boolean;
  /** Starts a turn. Resolves once the input is handed to the CLI, not when the turn ends. */
  send(input: AgentInput): Promise<void>;
  /** Interrupts the running turn, if any. */
  stop(): Promise<void>;
  /** Ends the backing process (stdin EOF, then kill the tree). */
  dispose(): Promise<void>;
}

export interface DriverOptions {
  tokenBaseline?: TokenCounts;
  /** Master coordinates images through GPT workers. */
  allowImages?: boolean;
  cwd: string;
  /** Existing native id to resume, or null for a new conversation. */
  nativeId: string | null;
  exePath: string;
  model?: string;
  /** Extra system instructions (Claude --append-system-prompt / Codex developerInstructions). */
  instructions?: string;
  /** Tool-less approval judge: no edits or shell escalation. */
  readOnly?: boolean;
  /** Codex thread config overrides (e.g. mcp_servers for the orchestrator's tools). */
  codexConfig?: Record<string, unknown>;
  /** Don't keep the conversation on disk (the approval judge). */
  ephemeral?: boolean;
}

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Anthropic API image limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Text appended to the prompt for attachments the CLI can't take inline. */
export function fileNote(files: AttachmentRef[]): string {
  if (!files.length) return "";
  return "\n\n[첨부 파일]\n" + files.map((f) => `- ${f.name}: ${f.path}`).join("\n") + "\n(필요하면 위 경로의 파일을 읽어서 참고하세요.)";
}

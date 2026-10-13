// Central approval policy for both agents: risk classification, per-chat "allow for this chat"
// memory, and routing the question to the chat's inline approval card.
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ApprovalDecision, ApprovalRequest, FileDiff, NodeId, Risk, Role } from "../shared/types";

export type Verdict = "allow" | "allow_chat" | "deny";

export interface ApprovalInput {
  role: Role;
  node: NodeId;
  title: string;
  detail: string;
  reason?: string;
  /** Key for "allow for this chat", e.g. "Write" or "cmd:npm". */
  key: string;
  command?: string;
  paths?: string[];
  diffs?: FileDiff[];
}

export interface ApprovalHost {
  emitRequest(chatId: number, node: NodeId, role: Role, request: ApprovalRequest): void;
  emitResolved(chatId: number, node: NodeId, role: Role, id: string, decision: ApprovalDecision | "auto" | "expired"): void;
  log(chatId: number, role: Role, action: unknown, risk: Risk, decision: string, scope: string): void;
  pendingChanged(chatId: number, pending: number): void;
}

const DANGEROUS_CMD = [
  [/(^|[\s;&|('"])(rm|rmdir|del|erase|rd|Remove-Item|ri)(\s|$)/i, "삭제 명령"],
  [/\bgit\s+push\b/i, "git push"],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f)/i, "되돌릴 수 없는 git 명령"],
  [/\b(format|shutdown|Stop-Computer|Restart-Computer)\b/i, "시스템 명령"],
  [/\breg(\.exe)?\s+(add|delete)\b|Set-ItemProperty\s+-Path\s+['"]?HK/i, "레지스트리 변경"],
] as const;
const SECRET_PATH = /(\.ssh[\\/]|\.aws[\\/]|\.git-credentials|\.npmrc|(^|[\\/])\.env(\.|$|[\\/])|id_rsa|id_ed25519|credentials(\.json)?$|\.claude[\\/]\.credentials|\.codex[\\/]auth\.json)/i;

export function classify(input: ApprovalInput, folder: string): { risk: Risk; reason?: string } {
  if (input.command) {
    for (const [re, why] of DANGEROUS_CMD) if (re.test(input.command)) return { risk: "high", reason: why };
    if (SECRET_PATH.test(input.command)) return { risk: "high", reason: "자격 증명 파일 접근" };
  }
  for (const p of input.paths ?? []) {
    if (SECRET_PATH.test(p)) return { risk: "high", reason: "자격 증명 파일 접근" };
    const abs = isAbsolute(p) ? p : resolve(folder, p);
    const rel = relative(folder, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return { risk: "high", reason: "작업 폴더 밖 경로" };
  }
  return { risk: "low" };
}

interface Pending {
  chatId: number;
  node: NodeId;
  role: Role;
  input: ApprovalInput;
  risk: Risk;
  resolve: (v: Verdict) => void;
}

export class ApprovalService {
  private pending = new Map<string, Pending>();
  private chatAllow = new Map<number, Set<string>>();

  constructor(private host: ApprovalHost) {}

  request(chatId: number, folder: string, input: ApprovalInput): Promise<Verdict> {
    const { risk, reason } = classify(input, folder);
    const allowKey = `${input.role}:${input.key}`;
    if (risk === "low" && this.chatAllow.get(chatId)?.has(allowKey)) {
      this.host.log(chatId, input.role, input, risk, "allow", "chat-auto");
      return Promise.resolve("allow");
    }
    const id = `ap:${randomUUID()}`;
    const request: ApprovalRequest = {
      id,
      role: input.role,
      title: input.title,
      detail: input.detail,
      reason: input.reason,
      risk,
      riskReason: reason,
      diffs: input.diffs,
    };
    return new Promise((resolvePromise) => {
      this.pending.set(id, { chatId, node: input.node, role: input.role, input, risk, resolve: resolvePromise });
      this.host.emitRequest(chatId, input.node, input.role, request);
      this.host.pendingChanged(chatId, this.pendingCount(chatId));
    });
  }

  answer(chatId: number, id: string, decision: ApprovalDecision) {
    const p = this.pending.get(id);
    if (!p || p.chatId !== chatId) return;
    this.pending.delete(id);
    // High-risk actions can only be allowed once.
    const effective: ApprovalDecision = decision === "chat" && p.risk === "high" ? "once" : decision;
    if (effective === "chat") {
      const set = this.chatAllow.get(chatId) ?? new Set<string>();
      set.add(`${p.role}:${p.input.key}`);
      this.chatAllow.set(chatId, set);
    }
    this.host.log(chatId, p.role, p.input, p.risk, effective === "deny" ? "deny" : "allow", effective);
    this.host.emitResolved(chatId, p.node, p.role, id, effective);
    this.host.pendingChanged(chatId, this.pendingCount(chatId));
    p.resolve(effective === "deny" ? "deny" : effective === "chat" ? "allow_chat" : "allow");
  }

  /** Deny everything still waiting in a chat (stop, process exit, quit). */
  cancelChat(chatId: number, role?: Role) {
    for (const [id, p] of [...this.pending]) {
      if (p.chatId !== chatId || (role && p.role !== role)) continue;
      this.pending.delete(id);
      this.host.emitResolved(chatId, p.node, p.role, id, "expired");
      p.resolve("deny");
    }
    this.host.pendingChanged(chatId, this.pendingCount(chatId));
  }

  pendingCount(chatId: number): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.chatId === chatId) n++;
    return n;
  }
}

export const newId = () => randomUUID();

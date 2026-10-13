// Central approval policy for every agent:
//  1. read-only tools → allowed silently (no judge, no card)
//  2. remembered decisions (user's "이 채팅 동안 허용", or an identical action the judge already allowed)
//  3. approval mode "orchestrator": the chat's judge (orchestrator model) decides allow / deny / ask_user.
//     Hard-floor actions (outside the folder, recursive deletes, git push, secrets, system changes,
//     uploads) are never auto-allowed unless the project delegates high-risk requests too;
//     the judge may still deny them.
//  4. otherwise (or when the judge asks / fails): the inline approval card for the user.
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentEvent, ApprovalDecision, ApprovalMode, ApprovalRequest, FileDiff, NodeId, Risk, Role } from "../shared/types";

export type Verdict = "allow" | "allow_chat" | "deny";
export interface VerdictResult {
  verdict: Verdict;
  /** Shown to the agent on deny (Claude gets it as the tool error). */
  reason?: string;
}

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
  /** The action only reads (Claude Read/Grep/Glob…). */
  readOnly?: boolean;
  /** The action writes these paths (vs. only reading them). */
  writes?: boolean;
}

export interface JudgeAnswer {
  decision: "allow" | "deny" | "ask_user";
  reason: string;
}

export interface ApprovalHost {
  emit(chatId: number, node: NodeId, role: Role, event: AgentEvent): void;
  log(chatId: number, role: Role, action: unknown, risk: Risk, decision: string, scope: string, decidedBy: string, reason?: string): void;
  pendingChanged(chatId: number, pending: number): void;
  /** Effective approval mode + high-risk delegation for the chat. */
  mode(chatId: number): { mode: ApprovalMode; delegateHighRisk: boolean };
  /** Ask the chat's judge; null when it can't answer (no judge, timeout, malformed). */
  judge?(chatId: number, request: ApprovalRequest, input: ApprovalInput): Promise<JudgeAnswer | null>;
}

const SECRET_PATH = /(\.ssh[\\/]|\.aws[\\/]|\.gnupg[\\/]|\.git-credentials|\.npmrc|\.pypirc|(^|[\\/\s'"])\.env(\.|$|[\\/\s'"])|id_rsa|id_ed25519|credentials(\.json)?($|[\s'"])|\.claude[\\/]\.credentials|\.codex[\\/]auth\.json|\btokens?\.json)/i;

/** Hard floor: never auto-allowed unless the project delegates high-risk requests. */
const CRITICAL_CMD: [RegExp, string][] = [
  [/\bgit\s+push\b/i, "git push"],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|filter-(branch|repo)|rebase\b|commit\s+--amend|push\s+.*--force)/i, "git 기록 변경"],
  [/(^|[\s;&|(])(rm|rmdir)\s+(-\w*[rR]\w*|--recursive)/, "재귀 삭제"],
  [/Remove-Item\b[^;|]*-Recurse|\b(rd|rmdir)\s+\/s\b|\bdel\s+(\/\w\s+)*\/s\b|\bdeltree\b/i, "재귀 삭제"],
  [/\b(format|diskpart|shutdown|Stop-Computer|Restart-Computer|bcdedit|sc(\.exe)?\s+(delete|config))\b/i, "시스템 변경"],
  [/\breg(\.exe)?\s+(add|delete|import)\b|(Set|New|Remove)-ItemProperty\s+[^;|]*HK(LM|CU)|Set-ExecutionPolicy/i, "레지스트리·시스템 변경"],
  [/\bcurl\b[^;|]*(\s-T\s|--upload-file|\s-F\s|--form|\s-d\s+@|--data(-binary)?\s+@)|Invoke-(WebRequest|RestMethod)\b[^;|]*-(InFile|Method\s+(Post|Put))|\bscp\s|\brsync\s[^;|]*:|\bftp\s/i, "네트워크로 업로드"],
];
const DELETE_CMD = /(^|[\s;&|('"])(rm|del|erase|Remove-Item|ri)(\s|$)/i;
/** Claude tools that only read. */
export const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "WebSearch", "ToolSearch"]);

export interface Classification {
  risk: Risk;
  reason?: string;
  /** Hard floor (see above). */
  critical: boolean;
}

export function classify(input: ApprovalInput, folder: string): Classification {
  const cmd = input.command ?? "";
  if (cmd) {
    for (const [re, why] of CRITICAL_CMD) if (re.test(cmd)) return { risk: "high", reason: why, critical: true };
    if (SECRET_PATH.test(cmd)) return { risk: "high", reason: "자격 증명·비밀 파일 접근", critical: true };
  }
  for (const p of input.paths ?? []) {
    if (SECRET_PATH.test(p)) return { risk: "high", reason: "자격 증명·비밀 파일 접근", critical: true };
    const abs = isAbsolute(p) ? p : resolve(folder, p);
    const rel = relative(folder, abs);
    const outside = rel.startsWith("..") || isAbsolute(rel);
    if (outside && (input.writes || !!cmd)) return { risk: "high", reason: "작업 폴더 밖 쓰기", critical: true };
    if (outside) return { risk: "high", reason: "작업 폴더 밖 읽기", critical: false };
  }
  if (cmd && DELETE_CMD.test(cmd)) return { risk: "high", reason: "파일 삭제", critical: false };
  return { risk: "low", critical: false };
}

interface Pending {
  chatId: number;
  node: NodeId;
  role: Role;
  input: ApprovalInput;
  risk: Risk;
  resolve: (v: VerdictResult) => void;
}

export class ApprovalService {
  private pending = new Map<string, Pending>();
  private chatAllow = new Map<number, Set<string>>();
  /** Exact actions the judge already allowed, per chat. */
  private judged = new Map<number, Set<string>>();

  constructor(private host: ApprovalHost) {}

  async request(chatId: number, folder: string, input: ApprovalInput): Promise<VerdictResult> {
    const c = classify(input, folder);
    const log = (decision: string, scope: string, by: string, reason?: string) =>
      this.host.log(chatId, input.role, input, c.risk, decision, scope, by, reason);

    // 1. Reads (Claude asks for reads outside its cwd, e.g. a user skill file).
    if (input.readOnly && !(c.critical && c.reason?.startsWith("자격"))) {
      log("allow", "read-only", "auto");
      return { verdict: "allow" };
    }
    // 2. Remembered decisions.
    if (!c.critical && this.chatAllow.get(chatId)?.has(`${input.role}:${input.key}`)) {
      log("allow", "chat", "user-memo");
      return { verdict: "allow" };
    }
    const exact = `${input.role}|${input.title}|${input.detail}`;
    const base: Omit<ApprovalRequest, "id"> = {
      role: input.role,
      title: input.title,
      detail: input.detail,
      reason: input.reason,
      risk: c.risk,
      riskReason: c.reason,
      diffs: input.diffs,
    };
    if (this.judged.get(chatId)?.has(exact)) {
      log("allow", "once", "orchestrator-memo");
      this.host.emit(chatId, input.node, input.role, {
        type: "approval_auto",
        request: { ...base, id: `ap:${randomUUID()}` },
        decision: "allow",
        reason: "같은 요청을 앞서 허용함",
        reused: true,
      });
      return { verdict: "allow" };
    }

    // 3. The orchestrator decides (workers only; the orchestrator's own requests go to the user).
    const { mode, delegateHighRisk } = this.host.mode(chatId);
    let judgeReason: string | undefined;
    if (mode === "orchestrator" && input.role !== "orch" && this.host.judge) {
      const id = `ap:${randomUUID()}`;
      const answer = await this.host.judge(chatId, { ...base, id }, input).catch(() => null);
      if (answer?.decision === "deny") {
        log("deny", "once", "orchestrator", answer.reason);
        this.host.emit(chatId, input.node, input.role, { type: "approval_auto", request: { ...base, id }, decision: "deny", reason: answer.reason });
        return { verdict: "deny", reason: `오케스트레이터가 거부했습니다: ${answer.reason}` };
      }
      if (answer?.decision === "allow" && (!c.critical || delegateHighRisk)) {
        log("allow", "once", "orchestrator", answer.reason);
        const set = this.judged.get(chatId) ?? new Set<string>();
        set.add(exact);
        this.judged.set(chatId, set);
        this.host.emit(chatId, input.node, input.role, { type: "approval_auto", request: { ...base, id }, decision: "allow", reason: answer.reason });
        return { verdict: "allow" };
      }
      judgeReason = answer
        ? answer.decision === "allow"
          ? `오케스트레이터는 허용하려 했지만 고위험 작업(${c.reason})이라 직접 확인이 필요합니다. 판단: ${answer.reason}`
          : `오케스트레이터 의견: ${answer.reason}`
        : "오케스트레이터가 판단하지 못해 직접 확인이 필요합니다.";
    }

    // 4. Ask the user.
    const id = `ap:${randomUUID()}`;
    const request: ApprovalRequest = { ...base, id, judgeReason };
    return new Promise((resolvePromise) => {
      this.pending.set(id, { chatId, node: input.node, role: input.role, input, risk: c.risk, resolve: resolvePromise });
      this.host.emit(chatId, input.node, input.role, { type: "approval_request", request });
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
    this.host.log(chatId, p.role, p.input, p.risk, effective === "deny" ? "deny" : "allow", effective, "user");
    this.host.emit(chatId, p.node, p.role, { type: "approval_resolved", id, decision: effective });
    this.host.pendingChanged(chatId, this.pendingCount(chatId));
    p.resolve(
      effective === "deny"
        ? { verdict: "deny", reason: "사용자가 AI_ChatterBox에서 거부했습니다." }
        : { verdict: effective === "chat" ? "allow_chat" : "allow" },
    );
  }

  /** Deny everything still waiting in a chat (stop, process exit, quit). */
  cancelChat(chatId: number, role?: Role) {
    for (const [id, p] of [...this.pending]) {
      if (p.chatId !== chatId || (role && p.role !== role)) continue;
      this.pending.delete(id);
      this.host.emit(chatId, p.node, p.role, { type: "approval_resolved", id, decision: "expired" });
      p.resolve({ verdict: "deny", reason: "작업이 중지되었습니다." });
    }
    this.host.pendingChanged(chatId, this.pendingCount(chatId));
  }

  pendingCount(chatId: number): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.chatId === chatId) n++;
    return n;
  }
}

// Central approval policy for every agent:
//  1. read-only tools → allowed silently (no judge, no card)
//  2. current scope / execution restrictions, before any remembered decision
//  3. approval mode "orchestrator": the chat's judge (orchestrator model) decides allow / deny / ask_user.
//     Hard-floor actions (outside the folder, recursive deletes, git push, secrets, system changes,
//     uploads) are never auto-allowed unless the project delegates high-risk requests too;
//     the judge may still deny them.
//  4. delegated high-risk mode allows an uncertain/failed judgment within runtime restrictions;
//     explicit denials stand. Otherwise show the inline approval card for the user.
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { inScope as matchesScope } from "./scope";
import { isReadCommand } from "./execution-policy";
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
  /** Runtime restrictions (stop, assignment and concurrent mutations). */
  guard?(chatId: number, input: ApprovalInput): string | null;
  /** A worker's current write scope, regardless of assignment kind. */
  writeScope?(chatId: number, role: Role): { globs: string[] | null; why: string; folder: string } | null;
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

function relToFolder(folder: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(folder, p);
  const rel = relative(folder, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
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
  private versions = new Map<number, number>();

  constructor(private host: ApprovalHost) {}

  invalidate(chatId: number) {
    this.chatAllow.delete(chatId);
    this.judged.delete(chatId);
    this.cancelChat(chatId);
  }

  private restriction(chatId: number, input: ApprovalInput): string | null {
    const blocked = this.host.guard?.(chatId, input);
    if (blocked) return blocked;
    if (!input.writes && !input.diffs?.length) return null;
    const sc = this.host.writeScope?.(chatId, input.role);
    if (!sc?.globs) return null;
    const paths = [...(input.paths ?? []), ...(input.diffs?.flatMap((d) => d.movePath ? [d.path, d.movePath] : [d.path]) ?? [])];
    if (!sc.globs.length || !paths.length) return `${sc.why}: 쓰기 범위를 확인할 수 없거나 수정이 금지되어 있습니다.`;
    const bad = paths.find((p) => {
      const rel = relToFolder(sc.folder, p);
      return rel === null || !matchesScope(rel, sc.globs!);
    });
    return bad === undefined ? null : `${sc.why}: ${bad}`;
  }

  async request(chatId: number, folder: string, input: ApprovalInput, judgeSignal?: AbortSignal): Promise<VerdictResult> {
    if (judgeSignal?.aborted) return { verdict: "deny", reason: "승인 판단이 종료되었습니다." };
    const version = this.versions.get(chatId) ?? 0;
    const c = classify(input, folder);
    const log = (decision: string, scope: string, by: string, reason?: string) =>
      this.host.log(chatId, input.role, input, c.risk, decision, scope, by, reason);

    const blocked = this.restriction(chatId, input);
    if (blocked) {
      log("deny", "once", "scope", blocked);
      this.host.emit(chatId, input.node, input.role, {
        type: "approval_auto", request: { id: `ap:${randomUUID()}`, role: input.role, title: input.title, detail: input.detail, risk: c.risk },
        decision: "deny", reason: blocked,
      });
      return { verdict: "deny", reason: blocked };
    }
    const policy = this.host.mode(chatId);
    // The judge's own tools must never ask that same judge to approve them.
    const mode = judgeSignal ? "user" : policy.mode === "orchestrator-all" ? "orchestrator" : policy.mode;
    const delegateHighRisk = policy.mode === "orchestrator-all" || (mode === "orchestrator" && policy.delegateHighRisk);
    // A shell can touch paths not present in its request metadata. Reassess it for every task.
    const reusable = c.risk === "low" && (!input.command || isReadCommand(input.command));
    // Reads (Claude asks for reads outside its cwd, e.g. a user skill file).
    if (input.readOnly && !(c.critical && c.reason?.startsWith("자격"))) {
      log("allow", "read-only", "auto");
      return { verdict: "allow" };
    }
    // 2. Remembered decisions.
    if (reusable && this.chatAllow.get(chatId)?.has(`${input.role}:${input.key}`)) {
      log("allow", "chat", "user-memo");
      return { verdict: "allow" };
    }
    const exact = JSON.stringify([input.role, input.title, input.detail, input.command, input.paths, input.diffs, input.writes]);
    const base: Omit<ApprovalRequest, "id"> = {
      role: input.role,
      title: input.title,
      detail: input.detail,
      reason: input.reason,
      risk: c.risk,
      riskReason: c.reason,
      diffs: input.diffs,
    };
    if (mode === "orchestrator" && reusable && this.judged.get(chatId)?.has(exact)) {
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

    // A separate judge handles both the master and the workers.
    let judgeReason: string | undefined;
    if (mode === "orchestrator" && this.host.judge) {
      const id = `ap:${randomUUID()}`;
      const answer = await this.host.judge(chatId, { ...base, id }, input).catch(() => null);
      if ((this.versions.get(chatId) ?? 0) !== version) return { verdict: "deny", reason: "작업이 중지되었거나 승인 설정이 변경되었습니다. 다시 요청하세요." };
      const changed = this.restriction(chatId, input);
      if (changed) return { verdict: "deny", reason: changed };
      if (answer?.decision === "deny") {
        log("deny", "once", "orchestrator", answer.reason);
        this.host.emit(chatId, input.node, input.role, { type: "approval_auto", request: { ...base, id }, decision: "deny", reason: answer.reason });
        return { verdict: "deny", reason: `마스터가 거부했습니다: ${answer.reason}` };
      }
      if (answer?.decision === "allow" && (!c.critical || delegateHighRisk)) {
        log("allow", "once", "orchestrator", answer.reason);
        const set = this.judged.get(chatId) ?? new Set<string>();
        if (reusable) set.add(exact);
        this.judged.set(chatId, set);
        this.host.emit(chatId, input.node, input.role, { type: "approval_auto", request: { ...base, id }, decision: "allow", reason: answer.reason });
        return { verdict: "allow" };
      }
      judgeReason = answer
        ? answer.decision === "allow"
          ? `마스터는 허용하려 했지만 고위험 작업(${c.reason})이라 직접 확인이 필요합니다. 판단: ${answer.reason}`
          : `마스터 의견: ${answer.reason}`
        : delegateHighRisk ? "승인 판단을 사용할 수 없습니다." : "마스터가 판단하지 못해 직접 확인이 필요합니다.";
    }

    if (mode === "orchestrator" && delegateHighRisk) {
      const id = `ap:${randomUUID()}`;
      const reason = `고위험 자동 승인 설정에 따라 허용했습니다. ${judgeReason ?? "별도 승인 판단을 사용할 수 없습니다."}`;
      log("allow", "once", "orchestrator-delegated", reason);
      this.host.emit(chatId, input.node, input.role, { type: "approval_auto", request: { ...base, id }, decision: "allow", reason });
      return { verdict: "allow" };
    }

    // 5. Ask the user.
    const id = `ap:${randomUUID()}`;
    const request: ApprovalRequest = { ...base, id, judgeReason };
    return new Promise((resolvePromise) => {
      const cancel = () => {
        if (!this.pending.delete(id)) return;
        this.host.emit(chatId, input.node, input.role, { type: "approval_resolved", id, decision: "expired" });
        this.host.pendingChanged(chatId, this.pendingCount(chatId));
        resolve({ verdict: "deny", reason: "승인 판단이 종료되었습니다." });
      };
      const resolve = (result: VerdictResult) => {
        judgeSignal?.removeEventListener("abort", cancel);
        resolvePromise(result);
      };
      this.pending.set(id, { chatId, node: input.node, role: input.role, input, risk: c.risk, resolve });
      judgeSignal?.addEventListener("abort", cancel, { once: true });
      this.host.emit(chatId, input.node, input.role, { type: "approval_request", request });
      this.host.pendingChanged(chatId, this.pendingCount(chatId));
    });
  }

  answer(chatId: number, id: string, decision: ApprovalDecision) {
    const p = this.pending.get(id);
    if (!p || p.chatId !== chatId) return null;
    this.pending.delete(id);
    const blocked = this.restriction(chatId, p.input);
    if (blocked) decision = "deny";
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
        ? { verdict: "deny", reason: blocked ?? "사용자가 AI_ChatterBox에서 거부했습니다." }
        : { verdict: effective === "chat" ? "allow_chat" : "allow" },
    );
    return effective;
  }

  /** Deny everything still waiting in a chat (stop, process exit, quit). */
  cancelChat(chatId: number, role?: Role) {
    this.versions.set(chatId, (this.versions.get(chatId) ?? 0) + 1);
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

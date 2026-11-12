// Rows for the run statistics panel (desktop and remote). Pure: the numbers come from shared/run-stats.
import { summarizeRunStats, type RunStats } from "../../../shared/run-stats";
import { CONSULT_KIND_LABEL, MASTER_LABEL, roleName, type ChatAgent, type Consult, type TimelineEvent } from "../../../shared/types";

export const RUN_STATS_NOTE =
  "기록 구간은 첫 기록부터 마지막 기록(진행 중이면 현재)까지이며 사용자 대기·유휴 시간이 포함됩니다. 모델 추론 시간이나 비용이 아닙니다. 도구 실행과 승인 대기는 서로 겹칠 수 있어 합이 기록 구간보다 클 수 있습니다. 결과 없는 도구 호출은 턴 종료 또는 현재까지, 결정 없는 승인은 현재까지로 계산하며 0초 성공으로 세지 않고 '결과 미확인'과 '승인 대기'로 따로 셉니다. '결과 미확인'은 아직 실행 중인 호출과 턴이 끝날 때까지 결과를 받지 못한 호출을 함께 세며, 실행 중이라는 뜻은 아닙니다.";

/** A tool call with no recorded result: still running, or its turn ended without one. The count cannot tell them apart. */
export const PENDING_TOOL_LABEL = "결과 미확인";

export interface RunStatsRow {
  key: string;
  label: string;
  stats: RunStats;
}

/**
 * Is the master mid-turn? The chat stays "working" after the master's turn_end while a worker finishes, so
 * the clock needs evidence from the master's own turn: a new instruction or its output. Notices, consult
 * results and usage also arrive between turns, and a queued instruction waits for the next boundary.
 */
function masterTurnOpen(events: readonly TimelineEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const { node, role, event } = events[i];
    if (node !== "orch") continue;
    if (event.type === "user" && !event.queued) return true;
    if (role !== "orch") continue;
    if (event.type === "turn_end") return false;
    if (event.type === "text_delta" || event.type === "text" || event.type === "tool_call") return true;
  }
  return false;
}

/** Whole chat, master, each worker, then each consult (newest first). Empty rows are left out. */
export function runStatsRows(events: readonly TimelineEvent[], agents: readonly ChatAgent[] | undefined, consults: readonly Consult[] | undefined, now?: number): { total: RunStats; roles: RunStatsRow[]; consults: RunStatsRow[] } {
  const opts = now === undefined ? {} : { now };
  const total = summarizeRunStats(events, opts);
  // Group once: each row then reads only its own events (the role/node filter inside is idempotent).
  // A long chat has tens of thousands of events and dozens of rows.
  const byRole = new Map<string, TimelineEvent[]>();
  const byNode = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const role = e.role ?? "";
    (byRole.get(role) ?? byRole.set(role, []).get(role)!).push(e);
    (byNode.get(e.node) ?? byNode.set(e.node, []).get(e.node)!).push(e);
  }
  const ofRole = (role: string) => byRole.get(role) ?? [];
  const ofNode = (node: string) => byNode.get(node) ?? [];
  // Only work still running extends to now; a finished master turn or an idle or released worker ends at its last record.
  const roles: RunStatsRow[] = [{ key: "orch", label: MASTER_LABEL, stats: summarizeRunStats(ofRole("orch"), masterTurnOpen(events) ? { ...opts, role: "orch" } : { role: "orch" }) }];
  const busy = new Set((consults ?? []).filter((c) => c.status === "running").map((c) => c.toRole));
  for (const agent of agents ?? []) roles.push({ key: agent.key, label: agent.nickname, stats: summarizeRunStats(ofRole(agent.key), busy.has(agent.key) ? { ...opts, role: agent.key } : { role: agent.key }) });
  const consultRows = [...(consults ?? [])]
    .sort((a, b) => b.seq - a.seq)
    .map((c) => ({
      key: `consult:${c.id}`,
      label: `협의 ${c.seq} · ${roleName(c.toRole, agents as ChatAgent[] | undefined)} · ${CONSULT_KIND_LABEL[c.kind]}`,
      // A finished consult must not grow with the clock.
      stats: summarizeRunStats(ofNode(`consult:${c.id}`), c.status === "running" ? { ...opts, node: `consult:${c.id}` } : { node: `consult:${c.id}` }),
    }));
  return { total, roles: roles.filter((r) => r.stats.eventCount > 0), consults: consultRows.filter((r) => r.stats.eventCount > 0) };
}

/** 0초 · 12초 · 3분 4초 · 1시간 2분 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** Problems worth flagging next to a row. */
export function runStatsFlags(stats: RunStats): string[] {
  const flags: string[] = [];
  if (stats.pendingTools) flags.push(`도구 ${PENDING_TOOL_LABEL} ${stats.pendingTools}`);
  if (stats.pendingApprovals) flags.push(`승인 대기 ${stats.pendingApprovals}`);
  if (stats.failedTools) flags.push(`도구 실패 ${stats.failedTools}`);
  if (stats.failedTurns) flags.push(`턴 실패 ${stats.failedTurns}`);
  return flags;
}

// Read-only history of plans that ended (done/cancelled/incomplete/failed/stopped), kept after a new
// instruction or a new /plan replaced them on the pinned panel. Display only: it never feeds the
// completion guard or the run/cancel commands, and the current plan (currentPlanView) is excluded.
import type { PlanState, PlanStep, TimelineEvent } from "../../../shared/types";

const TERMINAL: ReadonlySet<PlanState> = new Set<PlanState>(["done", "cancelled", "incomplete", "failed", "stopped"]);

export interface PlanHistoryEntry {
  /** plan:<planId> for plans with an id, seg:<n> for a legacy segment without one. */
  key: string;
  planId?: number;
  state: PlanState;
  reason?: string;
  /** The checklist as it was when the plan ended (steps keep their own cancelReason). */
  steps: PlanStep[];
  explanation?: string;
  /** The plan_state event that ended it. */
  eventId: number;
  at: number;
}

const isPlanCommand = (text: string) => /^\/plan(?:\s|$)/.test(text);

/**
 * One pass over the log, following the same segment rules as currentPlanView: a new /plan, an ordinary
 * instruction while the plan is not running, or an update for another planId starts a new segment, so
 * plans never mix. Several end states of one plan keep only the latest; a plan that runs again after an
 * end state leaves the history until it ends again. Newest first.
 */
export function planHistory(events: readonly TimelineEvent[]): PlanHistoryEntry[] {
  const ended = new Map<string, PlanHistoryEntry>();
  let segment = 0;
  let steps: PlanStep[] | null = null;
  let explanation: string | undefined;
  let state: PlanState | "live" = "live";
  let planId: number | undefined;
  const key = () => (planId !== undefined ? `plan:${planId}` : `seg:${segment}`);
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "plan_update" && e.role === "orch") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId) { state = "live"; segment++; }
      if (ev.planId !== undefined) planId = ev.planId;
      steps = ev.steps;
      explanation = ev.explanation;
    } else if (ev.type === "plan_state") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId && ev.state !== "running") continue;
      state = ev.state;
      if (ev.planId !== undefined) planId = ev.planId;
      if (TERMINAL.has(ev.state)) {
        ended.delete(key());
        ended.set(key(), { key: key(), planId, state: ev.state, reason: ev.reason, steps: steps ?? [], explanation, eventId: e.id, at: e.at });
      } else ended.delete(key());
    } else if (ev.type === "user" && !ev.queued && ev.text !== "계획 실행" && !/^\/plan-(?:run|cancel)\b/.test(ev.text)) {
      if (isPlanCommand(ev.text) || state !== "running") {
        steps = null;
        explanation = undefined;
        state = "live";
        planId = undefined;
        segment++;
      }
    }
  }
  // The plan still on the pinned panel is not history yet.
  if (steps !== null) ended.delete(key());
  return [...ended.values()].reverse();
}

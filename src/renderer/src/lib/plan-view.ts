// Display state of checklist steps (owner, prerequisites, consult links). Pure: shared by desktop and remote UI.
import { planStepBlockers } from "../../../shared/plan-steps";
import { isOpenStep, type PlanView } from "../../../shared/plan-lifecycle";
import type { Consult, PlanStep } from "../../../shared/types";
import type { Item } from "../timeline";

/** Plan lifecycle label; "live" is an ordinary instruction's checklist outside /plan. */
export const PLAN_STATE_LABEL: Record<PlanView["state"], string> = {
  proposed: "승인 대기", running: "실행 중", done: "완료", cancelled: "취소됨",
  incomplete: "미완료", failed: "실패", stopped: "중지됨", live: "진행 중",
};

/** States that end a plan without finishing all of it: their reason is always shown. */
export const planEndedEarly = (state: PlanView["state"]) => state === "cancelled" || state === "incomplete" || state === "failed" || state === "stopped";

/** Same chat states the main process treats as busy for /plan-run and /plan-cancel. */
export const chatBusyForPlan = (status: string) => status === "working" || status === "approval" || status === "pausing" || status === "paused";

/** Run/cancel are offered only on a proposal while the chat is idle; the server still checks both. */
export const planActionsAvailable = (state: PlanView["state"], chatStatus: string) => state === "proposed" && !chatBusyForPlan(chatStatus);

export interface PlanCounts { total: number; completed: number; cancelled: number; open: number }

/** Cancelled steps are never counted as completed. */
export function planCounts(steps: readonly PlanStep[]): PlanCounts {
  let completed = 0, cancelled = 0, open = 0;
  for (const s of steps) {
    if (s.status === "completed") completed++;
    else if (s.status === "cancelled") cancelled++;
    else open++;
  }
  return { total: steps.length, completed, cancelled, open };
}

/** "완료 n · 취소 m · 남음 k" (취소 is shown only when there is one). */
export function planCountsText(c: PlanCounts): string {
  return [`완료 ${c.completed}`, ...(c.cancelled ? [`취소 ${c.cancelled}`] : []), `남음 ${c.open}`].join(" · ");
}

/** Steps still owed (pending or in progress), for the "미진행" list of an ended plan. */
export const openPlanSteps = (steps: readonly PlanStep[]) => steps.filter(isOpenStep);

/** Blocker name, marked when the prerequisite was cancelled (it does not count as done). */
export const planBlockerName = (step: PlanStep) => (step.status === "cancelled" ? `${planStepName(step)}(취소됨)` : planStepName(step));

export interface PlanStepView {
  step: PlanStep;
  key: string;
  /** Direct prerequisites that are not completed (empty for completed steps). */
  blockers: PlanStep[];
  /** Pending, structured (ids/dependencies used) and nothing to wait for. */
  ready: boolean;
}

/** Older checklists have no ids/dependencies; they keep the plain list without "실행 가능" noise. */
export function planStepViews(steps: readonly PlanStep[]): PlanStepView[] {
  const list = [...steps];
  const structured = list.some((s) => !!s.id || !!s.dependsOn?.length);
  return list.map((step, index) => {
    const blockers = step.status === "completed" || step.status === "cancelled" ? [] : planStepBlockers(step, list);
    return { step, key: `${index}:${step.id ?? ""}`, blockers, ready: structured && step.status === "pending" && !blockers.length };
  });
}

/** Short name for a blocker: its title, or its id when the title is empty. */
export const planStepName = (step: PlanStep) => step.title.trim() || step.id || "이름 없는 단계";

export interface PlanConsultLink {
  consultId: number;
  /** Absent when the consult is not loaded (deleted chat records, another chat). */
  consult?: Consult;
}

export function planConsultLinks(step: PlanStep, consults: readonly Consult[] | undefined): PlanConsultLink[] {
  return [...new Set(step.consultIds ?? [])].map((consultId) => ({ consultId, consult: consults?.find((c) => c.id === consultId) }));
}

/** Consults that have a card in this timeline, nested ones included: only these can be linked to. */
export function consultCardIds(items: readonly Item[]): Set<number> {
  const ids = new Set<number>();
  const walk = (list: readonly Item[]) => {
    for (const item of list) {
      if (item.kind !== "consult") continue;
      ids.add(item.consultId);
      walk(item.children);
    }
  };
  walk(items);
  return ids;
}

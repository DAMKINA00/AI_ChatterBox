// Display state of checklist steps (owner, prerequisites, consult links). Pure: shared by desktop and remote UI.
import { planStepBlockers, readyGroupSteps } from "../../../shared/plan-steps";
import { isOpenStep, type PlanView } from "../../../shared/plan-lifecycle";
import { CONSULT_KIND_LABEL, WORKER_KIND_LABEL, type Consult, type PlanStep, type TimelineEvent } from "../../../shared/types";
import type { Item } from "../timeline";
import { pendingAsks } from "../../../shared/ask-lifecycle";

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
  /** Can start now. Grouped plans follow the main process (readyGroupSteps): lowest open group only. */
  ready: boolean;
  /** Grouped plan: nothing of its own to wait for, but an earlier group is still open. */
  groupWait: boolean;
}

/**
 * Older checklists have no ids/dependencies; they keep the plain list without "실행 가능" noise. A plan
 * with groups uses the same rule as the main process's execution gate (shared readyGroupSteps): only
 * pending steps of the lowest group that still has open steps, with every prerequisite completed. Steps
 * without a group in such a plan are not counted as startable.
 */
export function planStepViews(steps: readonly PlanStep[]): PlanStepView[] {
  const list = [...steps];
  const structured = list.some((s) => !!s.id || !!s.dependsOn?.length);
  const grouped = list.some((s) => s.group !== undefined);
  const readySet = grouped ? new Set(readyGroupSteps(list)) : null;
  return list.map((step, index) => {
    const blockers = step.status === "completed" || step.status === "cancelled" ? [] : planStepBlockers(step, list);
    const free = step.status === "pending" && !blockers.length;
    const ready = readySet ? readySet.has(step) : structured && free;
    return { step, key: `${index}:${step.id ?? ""}`, blockers, ready, groupWait: !!readySet && free && step.group !== undefined && !ready };
  });
}

export interface PlanGroupView {
  /** 1-based wave; steps with the same number may run at the same time. 0 with `undetermined`. */
  group: number;
  steps: PlanStepView[];
  /** Wave cannot be inferred: a prerequisite is missing or the dependencies form a cycle. */
  undetermined?: true;
}

/**
 * Steps of a structured plan split into waves that may run at the same time. A step's own `group` wins;
 * otherwise its wave is one past the deepest prerequisite. A step whose prerequisites are unknown or form
 * a cycle (or depend on such a step) is not placed in a wave at all: it goes to a trailing "undetermined"
 * bucket, so the result never depends on the order of the input. Plain checklists (no groups, no
 * dependencies) return null and keep the flat list.
 */
export function planGroups(views: readonly PlanStepView[]): PlanGroupView[] | null {
  const steps = views.map((v) => v.step);
  if (!steps.some((s) => s.group !== undefined || !!s.dependsOn?.length)) return null;
  const byId = new Map(steps.flatMap((s) => (s.id ? [[s.id, s] as const] : [])));
  const memo = new Map<PlanStep, number | null>();
  const visiting = new Set<PlanStep>();
  /** Wave number, or null when it cannot be determined. */
  const wave = (step: PlanStep): number | null => {
    if (step.group !== undefined && Number.isFinite(step.group)) return Math.max(1, Math.floor(step.group));
    if (memo.has(step)) return memo.get(step)!;
    if (visiting.has(step)) return null;
    visiting.add(step);
    let d: number | null = 1;
    for (const id of step.dependsOn ?? []) {
      const dep = byId.get(id);
      const w = dep && dep !== step ? wave(dep) : null;
      if (w === null) { d = null; break; }
      d = Math.max(d, w + 1);
    }
    visiting.delete(step);
    memo.set(step, d);
    return d;
  };
  // A step is memoized with a number only when every prerequisite already has one, and a cycle returns
  // null to every member on the way back, so the buckets do not depend on the input order.
  const groups = new Map<number, PlanStepView[]>();
  const unknown: PlanStepView[] = [];
  for (const v of views) {
    const g = wave(v.step);
    if (g === null) unknown.push(v);
    else groups.set(g, [...(groups.get(g) ?? []), v]);
  }
  const out: PlanGroupView[] = [...groups.entries()].sort(([a], [b]) => a - b).map(([group, list]) => ({ group, steps: list }));
  if (unknown.length) out.push({ group: 0, steps: unknown, undetermined: true });
  return out;
}

/** "구현 · 클로드" style labels of a step's kind and model family, when the plan recorded them. */
export function planStepTags(step: PlanStep): { kind?: string; agentKind?: string } {
  return {
    ...(step.kind ? { kind: CONSULT_KIND_LABEL[step.kind] ?? step.kind } : {}),
    ...(step.agentKind ? { agentKind: WORKER_KIND_LABEL[step.agentKind] ?? step.agentKind } : {}),
  };
}

/**
 * Version of the plan on screen: the `version` of its latest proposal (plan_state "proposed" of the same
 * plan id). Proposals recorded before versions existed count as 1, as the main process treats them.
 */
export function planVersion(events: readonly TimelineEvent[], planId: number | undefined): number {
  // A history snapshot replays the plan as one plan_state (possibly "running") that carries the version.
  const e = events.findLast((x) => x.event.type === "plan_state" && (x.event.state === "proposed" || x.event.version !== undefined) && (planId === undefined || x.event.planId === undefined || x.event.planId === planId));
  const v = e?.event.type === "plan_state" ? e.event.version : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 1;
}

/**
 * /plan-run argument "planId:version": the plan and version the user approved, so neither a newer
 * version nor another plan proposed meanwhile is run unseen. A legacy proposal without a plan id sends ""
 * (the main process then runs the latest proposal and says so).
 */
export const planRunArg = (planId: number | undefined, version: number) => (planId === undefined ? "" : `${planId}:${version}`);

export const PLAN_CHANGED_TEXT = "계획이 바뀌었습니다. 다시 확인해 주세요.";

/** The main process refused /plan-run because a newer version was proposed meanwhile. */
export function isPlanChangedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("계획이 바뀌었습니다");
}

/** "Title (id)" of the step a review step checks; the bare id when that step is not in the list. */
export function planReviewTarget(step: PlanStep, steps: readonly PlanStep[]): string | undefined {
  if (!step.reviewOf) return undefined;
  const target = steps.find((s) => s.id === step.reviewOf);
  return target ? `${planStepName(target)} (${step.reviewOf})` : step.reviewOf;
}

/** The master's latest question still waiting for the user's answer, if any. */
export function pendingAskId(events: readonly TimelineEvent[]): string | undefined {
  const last = pendingAsks(events).at(-1)?.event;
  return last?.type === "ask_user" ? last.id : undefined;
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

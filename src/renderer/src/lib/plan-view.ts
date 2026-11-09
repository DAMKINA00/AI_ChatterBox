// Display state of checklist steps (owner, prerequisites, consult links). Pure: shared by desktop and remote UI.
import { planStepBlockers } from "../../../shared/plan-steps";
import type { Consult, PlanStep } from "../../../shared/types";
import type { Item } from "../timeline";

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
    const blockers = step.status === "completed" ? [] : planStepBlockers(step, list);
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

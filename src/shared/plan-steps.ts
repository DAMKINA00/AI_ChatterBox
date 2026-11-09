import type { PlanStep } from "./types";

const STATUSES: PlanStep["status"][] = ["pending", "inProgress", "completed"];
const MAX_STEPS = 200;
const MAX_ID = 80;
const MAX_OWNER = 80;
const MAX_LINKS = 50;

/**
 * Normalize a checklist from a model. Older `{title, status}` lists stay valid: an unknown status is
 * pending and a step without a title is dropped. Dependency mistakes are rejected rather than repaired,
 * because a silently dropped edge would present blocked work as ready.
 */
export function validatePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) throw new Error("steps는 배열이어야 합니다.");
  if (raw.length > MAX_STEPS) throw new Error(`체크리스트는 최대 ${MAX_STEPS}단계입니다.`);
  const steps: PlanStep[] = [];
  for (const item of raw) {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const title = String(s.title ?? "").trim();
    if (!title) continue;
    const step: PlanStep = { title, status: STATUSES.includes(s.status as PlanStep["status"]) ? s.status as PlanStep["status"] : "pending" };
    const id = optionalText(s.id, "id", MAX_ID);
    if (id) step.id = id;
    const owner = optionalText(s.owner, "owner", MAX_OWNER);
    if (owner) step.owner = owner;
    if (s.dependsOn !== undefined && s.dependsOn !== null) {
      if (!Array.isArray(s.dependsOn) || s.dependsOn.length > MAX_LINKS || s.dependsOn.some(d => typeof d !== "string" || !d.trim() || d.length > MAX_ID))
        throw new Error(`"${title}"의 dependsOn은 단계 id 목록이어야 합니다.`);
      const dependsOn = [...new Set((s.dependsOn as string[]).map(d => d.trim()))];
      if (dependsOn.length) step.dependsOn = dependsOn;
    }
    if (s.consultIds !== undefined && s.consultIds !== null) {
      if (!Array.isArray(s.consultIds) || s.consultIds.length > MAX_LINKS || s.consultIds.some(c => !Number.isSafeInteger(c) || (c as number) <= 0))
        throw new Error(`"${title}"의 consultIds는 협의 id 목록이어야 합니다.`);
      const consultIds = [...new Set(s.consultIds as number[])];
      if (consultIds.length) step.consultIds = consultIds;
    }
    steps.push(step);
  }
  const byId = new Map<string, PlanStep>();
  for (const step of steps) {
    if (!step.id) continue;
    if (byId.has(step.id)) throw new Error(`단계 id가 중복됩니다: ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of steps) for (const dep of step.dependsOn ?? []) {
    if (dep === step.id) throw new Error(`단계 ${step.id}이(가) 자기 자신을 선행으로 지정했습니다.`);
    if (!byId.has(dep)) throw new Error(`"${step.title}"의 선행 단계 ${dep}이(가) 목록에 없습니다.`);
  }
  // Iterative so a long chain from a model cannot overflow the stack.
  const state = new Map<string, "visiting" | "done">();
  for (const start of byId.keys()) {
    if (state.has(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, "visiting");
    while (stack.length) {
      const top = stack[stack.length - 1];
      const deps = byId.get(top.id)!.dependsOn ?? [];
      if (top.next >= deps.length) {
        state.set(top.id, "done");
        stack.pop();
        continue;
      }
      const dep = deps[top.next++];
      if (state.get(dep) === "visiting") throw new Error(`선행 관계에 순환이 있습니다: ${[...stack.slice(stack.findIndex(f => f.id === dep)).map(f => f.id), dep].join(" → ")}`);
      if (!state.has(dep)) {
        state.set(dep, "visiting");
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  return steps;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${field}은(는) ${max}자 이하의 문자열이어야 합니다.`);
  return value.trim() || undefined;
}

/** Direct prerequisites that are not completed yet. */
export function planStepBlockers(step: PlanStep, steps: PlanStep[]): PlanStep[] {
  if (!step.dependsOn?.length) return [];
  return steps.filter(s => s.id !== undefined && step.dependsOn!.includes(s.id) && s.status !== "completed");
}

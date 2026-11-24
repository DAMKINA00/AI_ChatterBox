import type { ConsultKind, PlanStep, WorkerKind } from "./types";

const STATUSES: PlanStep["status"][] = ["pending", "inProgress", "completed", "cancelled"];
const MAX_REASON = 300;
export const DEFAULT_CANCEL_REASON = "사유가 기록되지 않았습니다.";
const MAX_STEPS = 200;
const MAX_ID = 80;
const MAX_OWNER = 80;
const MAX_LINKS = 50;

/**
 * Normalize a checklist from a model. Older `{title, status}` lists stay valid: an unknown status is
 * pending and a step without a title is dropped. Dependency mistakes are rejected rather than repaired,
 * because a silently dropped edge would present blocked work as ready.
 *
 * `previous` is the plan's last recorded list. A cancellation is kept: the step stays cancelled (there is
 * no reopening; new work is a new step) and keeps its recorded reason unless a new one is given. Each
 * cancellation kept against the input is described in `notes`.
 */
export function validatePlanSteps(raw: unknown, previous?: readonly PlanStep[], notes?: string[]): PlanStep[] {
  if (!Array.isArray(raw)) throw new Error("steps는 배열이어야 합니다.");
  if (raw.length > MAX_STEPS) throw new Error(`체크리스트는 최대 ${MAX_STEPS}단계입니다.`);
  const before = new Map((previous ?? []).map((p) => [p.id ?? p.title, p]));
  const steps: PlanStep[] = [];
  for (const item of raw) {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const title = String(s.title ?? "").trim();
    if (!title) continue;
    const step: PlanStep = { title, status: STATUSES.includes(s.status as PlanStep["status"]) ? s.status as PlanStep["status"] : "pending" };
    const id = optionalText(s.id, "id", MAX_ID);
    if (id) step.id = id;
    const prior = before.get(id ?? title);
    if (prior?.status === "cancelled" && step.status !== "cancelled") {
      notes?.push(`${id ?? title}: 취소된 단계는 다시 열지 않습니다(취소 유지). 이어서 할 일이면 새 단계로 추가하세요.`);
      step.status = "cancelled";
    }
    if (step.status === "cancelled") {
      // Decided on the raw input: a missing reason never replaces the one already recorded.
      const reason = typeof s.cancelReason === "string" ? s.cancelReason.trim().slice(0, MAX_REASON) : "";
      step.cancelReason = reason || (prior?.status === "cancelled" ? prior.cancelReason : undefined) || DEFAULT_CANCEL_REASON;
    }
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
    taskFields(step, s, title);
    // A later checklist update that omits the task fields keeps those the plan already recorded.
    if (prior) for (const k of TASK_FIELDS) if (step[k] === undefined && prior[k] !== undefined) (step as any)[k] = Array.isArray(prior[k]) ? [...(prior[k] as string[])] : prior[k];
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

const CONSULT_KINDS: ConsultKind[] = ["implement", "review", "opinion", "writing"];
const WORKER_KINDS: WorkerKind[] = ["claude", "gpt", "gemini", "grok", "deepseek"];
const TASK_FIELDS = ["kind", "agentKind", "scope", "group", "done", "reviewOf"] as const;
const MAX_DONE = 500;
const MAX_SCOPE = 50;

/** Optional plan-mode task fields; malformed values are rejected, absent ones stay absent. */
function taskFields(step: PlanStep, s: Record<string, unknown>, title: string) {
  if (s.kind !== undefined && s.kind !== null) {
    if (!CONSULT_KINDS.includes(s.kind as ConsultKind)) throw new Error(`"${title}"의 kind는 ${CONSULT_KINDS.join("|")} 중 하나여야 합니다.`);
    step.kind = s.kind as ConsultKind;
  }
  if (s.agentKind !== undefined && s.agentKind !== null) {
    if (!WORKER_KINDS.includes(s.agentKind as WorkerKind)) throw new Error(`"${title}"의 agentKind는 ${WORKER_KINDS.join("|")} 중 하나여야 합니다.`);
    step.agentKind = s.agentKind as WorkerKind;
  }
  if (s.scope !== undefined && s.scope !== null) {
    if (!Array.isArray(s.scope) || s.scope.length > MAX_SCOPE || s.scope.some(g => typeof g !== "string" || !g.trim() || g.length > 300))
      throw new Error(`"${title}"의 scope는 경로 glob 문자열 목록이어야 합니다.`);
    step.scope = [...new Set((s.scope as string[]).map(g => g.trim()))];
  }
  if (s.group !== undefined && s.group !== null) {
    if (!Number.isSafeInteger(s.group) || (s.group as number) < 1 || (s.group as number) > 100) throw new Error(`"${title}"의 group은 1 이상 100 이하 정수여야 합니다.`);
    step.group = s.group as number;
  }
  const done = optionalText(s.done, "done", MAX_DONE);
  if (done) step.done = done;
  const reviewOf = optionalText(s.reviewOf, "reviewOf", MAX_ID);
  if (reviewOf) step.reviewOf = reviewOf;
}

/**
 * Strict checks for a plan submitted with propose_plan: every task names its id, kind, worker family,
 * group and completion criterion; dependencies point to an earlier group; a review names an existing task.
 * Scope overlap is checked by the caller (it needs the main-process glob rules).
 */
export function validateProposedTasks(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("tasks에 작업을 1개 이상 넣으세요.");
  const items = raw.map((t) => ({ ...(t && typeof t === "object" ? t : {}), status: "pending" }));
  const steps = validatePlanSteps(items);
  if (steps.length !== raw.length) throw new Error("모든 작업에 title이 필요합니다.");
  for (const s of steps) {
    const missing = [!s.id && "id", !s.kind && "kind", !s.agentKind && "agentKind", s.group === undefined && "group", !s.done && "done"].filter(Boolean);
    if (missing.length) throw new Error(`"${s.title}"에 ${missing.join(", ")}이(가) 필요합니다.`);
    if (!s.scope) s.scope = [];
    if (s.kind === "implement" && !s.scope.length) throw new Error(`구현 작업 ${s.id}에는 고칠 경로(scope)를 지정하세요.`);
  }
  const byId = new Map(steps.map((s) => [s.id!, s]));
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (byId.get(dep)!.group! >= s.group!) throw new Error(`작업 ${s.id}(group ${s.group})의 선행 ${dep}은(는) 더 앞선 group에 있어야 합니다.`);
    }
    if (s.reviewOf !== undefined) {
      const target = byId.get(s.reviewOf);
      if (!target) throw new Error(`작업 ${s.id}의 reviewOf ${s.reviewOf}이(가) 목록에 없습니다.`);
      if (target.group! >= s.group!) throw new Error(`리뷰 ${s.id}은(는) 대상 ${s.reviewOf}보다 뒤 group이어야 합니다.`);
    }
  }
  return steps;
}

/** Pending steps that can start now: every dependency completed, in the lowest group that still has open steps. */
export function readyGroupSteps(steps: readonly PlanStep[]): PlanStep[] {
  const open = steps.filter((s) => s.status === "pending" || s.status === "inProgress");
  const grouped = open.filter((s) => s.group !== undefined);
  if (!grouped.length) return [];
  const lowest = Math.min(...grouped.map((s) => s.group!));
  return grouped.filter((s) => s.group === lowest && s.status === "pending" && !planStepBlockers(s, steps as PlanStep[]).length);
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

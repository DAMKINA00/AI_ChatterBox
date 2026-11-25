// Plan lifecycle helpers shared by the main process (completion guard, /plan commands) and the renderer.
import type { PlanState, PlanStep, TimelineEvent } from "./types";

/** Identity of a step across updates of the same plan: its id, otherwise its title. */
export const stepKey = (step: PlanStep): string => step.id ?? step.title;

/** Not finished and not cancelled: the work the plan still owes. */
export const isOpenStep = (step: PlanStep): boolean => step.status === "pending" || step.status === "inProgress";

const isMasterPlan = (e: TimelineEvent) => e.event.type === "plan_update" && e.role === "orch" && e.node === "orch";

/** Steps a later update of the same plan must keep: unfinished work, and cancellations with their reason. */
const mustStay = (step: PlanStep) => isOpenStep(step) || step.status === "cancelled";

/**
 * Steps of the previous update that the next one leaves out although they must stay. A plan may not
 * drop unfinished work or a cancellation silently: an open step has to be completed or cancelled with a
 * reason, and a cancelled one stays listed. A completed step may be left out (its record stays in the
 * earlier update).
 */
export function droppedSteps(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanStep[] {
  const kept = new Set(next.map(stepKey));
  return previous.filter((step) => mustStay(step) && !kept.has(stepKey(step)));
}

/**
 * Native plan tools report steps by title only. A step without an id takes the identity and recorded
 * links (id, owner, dependsOn, consultIds) of the previous step with the same title, but only when the
 * title is unique on both sides; an ambiguous title is left as reported rather than guessed.
 */
export function alignNativeSteps(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanStep[] {
  const count = (list: readonly PlanStep[], title: string) => list.filter((s) => s.title.trim() === title).length;
  const taken = new Set(next.flatMap((s) => s.id ? [s.id] : []));
  return next.map((step) => {
    if (step.id) return step;
    const title = step.title.trim();
    if (count(next, title) !== 1 || count(previous, title) !== 1) return step;
    const prior = previous.find((s) => s.title.trim() === title)!;
    if (!prior.id || taken.has(prior.id)) return step;
    taken.add(prior.id);
    return {
      ...step,
      id: prior.id,
      ...(step.owner ? {} : prior.owner ? { owner: prior.owner } : {}),
      ...(step.dependsOn ? {} : prior.dependsOn ? { dependsOn: prior.dependsOn } : {}),
      ...(step.consultIds ? {} : prior.consultIds ? { consultIds: prior.consultIds } : {}),
    };
  });
}

/**
 * For updates that cannot be refused (native plan tools report a whole list): the next list with every
 * step that must stay put back after its previous neighbour. Unfinished ones stay unfinished. A recorded
 * step that a kept or listed step depends on comes back too, so the dependency stays valid.
 */
export function keepDroppedSteps(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanStep[] {
  const out = [...next];
  const missing = new Set(droppedSteps(previous, next).map(stepKey));
  // Prerequisites of every step that will be listed, followed through recorded dependencies.
  const listed = () => new Set([...next.map(stepKey), ...missing]);
  for (let changed = true; changed;) {
    changed = false;
    const keys = listed();
    for (const step of [...next, ...previous.filter((p) => missing.has(stepKey(p)))]) {
      for (const dep of step.dependsOn ?? []) {
        if (keys.has(dep) || missing.has(dep) || !previous.some((p) => p.id === dep)) continue;
        missing.add(dep);
        changed = true;
      }
    }
  }
  if (!missing.size) return out;
  previous.forEach((step, index) => {
    if (!missing.has(stepKey(step))) return;
    const before = previous.slice(0, index).reverse().map(stepKey);
    const anchor = before.map((key) => out.findIndex((s) => stepKey(s) === key)).find((i) => i >= 0) ?? -1;
    out.splice(anchor + 1, 0, step);
  });
  return out;
}

/**
 * The latest checklist the master recorded for plan `planId`. New updates from the checklist tool and
 * from native plan tools are stamped with the plan when they arrive; older unstamped records are never
 * attached to a plan after the fact.
 */
export function planStepsFor(events: readonly TimelineEvent[], planId: number): PlanStep[] | undefined {
  const e = events.findLast((x) => isMasterPlan(x) && x.event.type === "plan_update" && x.event.planId === planId);
  return e?.event.type === "plan_update" ? e.event.steps : undefined;
}

/** Short list of open steps for notices and the incomplete reason. */
export function openStepsText(steps: readonly PlanStep[], max = 10): string {
  const open = steps.filter(isOpenStep);
  const shown = open.slice(0, max).map((s) => `${s.id ? `${s.id} ` : ""}${s.title}${s.status === "inProgress" ? "(진행 중)" : ""}`);
  return shown.join(", ") + (open.length > max ? ` 외 ${open.length - max}개` : "");
}

/** The last recorded plan_state, if any. */
export function latestPlanState(events: readonly TimelineEvent[]): { state: PlanState; planId?: number; reason?: string; eventId: number } | undefined {
  const e = events.findLast((x) => x.event.type === "plan_state");
  return e?.event.type === "plan_state" ? { state: e.event.state, planId: e.event.planId, reason: e.event.reason, eventId: e.id } : undefined;
}

/**
 * The plan id of the proposal waiting for approval, if it is still the latest thing the user asked
 * for: the last plan_state is "proposed" and no user message came after its submitted steps. Queued
 * input received before submission belongs to that plan; input after it supersedes the proposal.
 * Older proposals without a planId resolve to the /plan message just before them.
 */
export function pendingProposal(events: readonly TimelineEvent[]): number | undefined {
  const last = latestPlanState(events);
  if (last?.state !== "proposed") return undefined;
  const planId = last.planId ?? events.findLast((e) => e.id < last.eventId && e.event.type === "user" && !e.event.queued && (isPlanCommand(e.event.text) || !!e.event.plan))?.id;
  if (planId === undefined) return undefined;
  const submitted = events.findLast((e) => e.id < last.eventId && isMasterPlan(e) && e.event.type === "plan_update" && e.event.planId === planId)?.id ?? planId;
  const superseded = events.some((e) => e.event.type === "user" && e.id > planId && (!e.event.queued || e.id > submitted));
  return superseded ? undefined : planId;
}

/** Explicit chat approval, not a question, quotation, conditional instruction or negated command. */
export function isPlanExecutionRequest(text: string): boolean {
  const direct = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`|“[^”]*”|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/g, "")
    .split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join("\n");
  // A qualification anywhere in the message must not accidentally approve work now.
  if (/(?:진행|실행|시작)(?:하|해|하지|시키)?\s*(?:지\s*마|주지\s*마|말|안|않|금지|취소)|(?:진행|실행|시작)하지|(?:아직|지금은|당장은|나중에|다음에)\s*(?:진행|실행|시작)|(?:검토|확인|승인|완료)\s*(?:후|뒤)|(?:하면|되면|끝나면|완료되면|승인하면|전에는)|[?？]/.test(direct)) return false;
  return /(?:^|[\s.!。])(?:진행|실행|시작)(?:해(?:\s*줘|\s*주세요|라)?|하(?:세요|자|십시오|도록\s*해(?:줘|주세요)))(?=\s*(?:$|[.!。,\n]|그리고\s))/.test(direct.trim())
    || /^(?:진행|실행|시작|계획\s*실행)[.!。]*$/.test(direct.trim());
}

/** "/plan …" itself; "/plan-run" and "/plan-cancel" are commands on the same plan. */
const isPlanCommand = (text: string) => /^\/plan(?:\s|$)/.test(text);

export interface PlanView {
  planId?: number;
  steps: PlanStep[];
  explanation?: string;
  /** "live": a checklist of an ordinary instruction, outside the /plan lifecycle. */
  state: PlanState | "live";
  reason?: string;
  /** Version of the proposal (propose_plan revisions); absent on older plans (read as 1). */
  version?: number;
}

/**
 * The plan to show for a chat: the latest one, never mixed with an earlier plan. A new ordinary
 * instruction or a new /plan starts fresh. A running plan keeps its checklist through follow-ups only
 * while it is running; finished, cancelled or failed plans stay visible until something replaces them.
 */
export function currentPlanView(events: readonly TimelineEvent[]): PlanView | null {
  let view = null as PlanView | null;
  let state: PlanView["state"] = "live";
  let reason: string | undefined;
  let planId: number | undefined;
  let version: number | undefined;
  const withVersion = (v: PlanView): PlanView => (version !== undefined ? { ...v, version } : v);
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "plan_update" && e.role === "orch") {
      // An update for another plan id replaces the shown plan instead of merging into it.
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId) { state = "live"; reason = undefined; version = undefined; }
      if (ev.planId !== undefined) planId = ev.planId;
      view = ev.steps.length ? withVersion({ planId, steps: ev.steps, explanation: ev.explanation, state, reason }) : null;
    } else if (ev.type === "plan_state") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId && ev.state !== "running") continue;
      if (ev.planId !== undefined && ev.planId !== planId) version = undefined;
      state = ev.state;
      reason = ev.reason;
      if (ev.version !== undefined) version = ev.version;
      if (ev.planId !== undefined) planId = ev.planId;
      if (view) view = withVersion({ ...view, planId, state, reason });
    } else if (ev.type === "user" && !ev.queued && ev.text !== "계획 실행" && !/^\/plan-(?:run|cancel)\b/.test(ev.text)) {
      if (isPlanCommand(ev.text) || ev.plan || state !== "running") {
        view = null;
        state = "live";
        reason = undefined;
        planId = undefined;
        version = undefined;
      }
    }
  }
  return view;
}

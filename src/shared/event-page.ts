// Chat history in pages. Long chats (tens of thousands of events, hundreds of MB of tool output) are
// opened from their newest events; older pages load on demand, and large payloads are shortened until the
// reader asks for the full event. Shared by the core (db.ts), the desktop window and remote web.
//
// Size guarantee: every event in a page is at most EVENT_MAX_CHARS of JSON, the page events (with
// anchors) at most EVENT_PAGE_LIMITS.chars, the context at most CONTEXT_MAX_CHARS. Strings are UTF-16 at
// worst in the core frame, so a first page stays under PAGE_MAX_BYTES (16MB), far below the 128MB frame.
import type { AgentEvent, AgentExpression, ApprovalRequest, ChatGoal, NodeId, PlanState, PlanStep, Role, TimelineEvent } from "./types";

/** One page: stop at whichever limit is reached first (counted from the newest event backwards). */
export const EVENT_PAGE_LIMITS = {
  /** Events that show up as their own item in the main view (tool logs and usage records do not count). */
  visible: 300,
  /** All events, so a page of only tool logs stays bounded. */
  events: 4000,
  /** JSON characters of the page as sent (after shortening, anchors included). */
  chars: 4_000_000,
} as const;
/** JSON characters of the first page's context (see reduceContext). */
export const CONTEXT_MAX_CHARS = 1_500_000;
/** No single event in a page is larger than this many JSON characters. */
export const EVENT_MAX_CHARS = 64_000;
/** Upper bound of one serialized page (checked by tests): (chars + context) × 2 bytes plus overhead. */
export const PAGE_MAX_BYTES = 16 * 1024 * 1024;

/** Tool input/output longer than this is shortened in history pages (full text: one event on demand). */
export const CLIP_AT = 6000;

const clipText = (text: string, keep = CLIP_AT) => {
  const head = Math.ceil(keep * 0.7);
  const tail = Math.floor(keep * 0.25);
  return `${text.slice(0, head)}\n\n… (${(text.length - head - tail).toLocaleString("ko-KR")}자 생략) …\n\n${text.slice(text.length - tail)}`;
};

/** Strings longer than `text` and arrays longer than `items` are shortened, at any depth. */
function shrink(value: unknown, text: number, items: number): unknown {
  if (typeof value === "string") return value.length > text ? clipText(value, text) : value;
  if (Array.isArray(value)) return (value.length > items ? value.slice(0, items) : value).map(v => shrink(v, text, items));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, text, items)]));
  return value;
}
const STEPS: [text: number, items: number][] = [[48_000, 1000], [12_000, 200], [3000, 50], [500, 10], [100, 3]];

/**
 * The event as sent in a history page. Tool input/output over CLIP_AT is shortened (with its original
 * length in `clipped`); anything still larger than EVENT_MAX_CHARS (file diffs, long approvals, huge
 * messages) is shortened field by field until it fits. `clipped: true` on the result = fetch the full event.
 */
export function pageEvent(e: TimelineEvent): TimelineEvent {
  let event: AgentEvent = e.event;
  let clipped = false;
  if (event.type === "plan_update") {
    // A checklist keeps its first steps whole (titles shortened) and says how many there are, instead of
    // the generic shrink cutting the list to a few entries without notice.
    const summary = planSummary(event);
    if (summary !== event) { event = summary; clipped = true; }
  } else if (event.type === "tool_call" && event.input.length > CLIP_AT) { event = { ...event, input: clipText(event.input), clipped: event.input.length }; clipped = true; }
  else if (event.type === "tool_result" && event.output.length > CLIP_AT) { event = { ...event, output: clipText(event.output), clipped: event.output.length }; clipped = true; }
  for (const [text, items] of STEPS) {
    if (event.type === "plan_update" || JSON.stringify(event).length <= EVENT_MAX_CHARS) break;
    event = { ...(shrink(event, text, items) as AgentEvent), type: event.type } as AgentEvent;
    clipped = true;
  }
  return clipped ? { ...e, event, clipped: true } : e;
}

/** Longest step title in a plan summary; with SNAPSHOT_LIMITS.planSteps steps a summary stays near EVENT_MAX_CHARS. */
export const PLAN_TITLE_MAX = 250;

/**
 * A checklist as sent in pages and snapshots: the first SNAPSHOT_LIMITS.planSteps steps with titles up to
 * PLAN_TITLE_MAX and the explanation up to 1000 characters; stepsTotal = the real step count when cut.
 * Returns the event itself when nothing had to be cut.
 */
export function planSummary(event: Extract<AgentEvent, { type: "plan_update" }>): Extract<AgentEvent, { type: "plan_update" }> {
  const total = event.stepsTotal ?? event.steps.length;
  const tooMany = event.steps.length > SNAPSHOT_LIMITS.planSteps;
  const longTitle = event.steps.some(s => s.title.length > PLAN_TITLE_MAX);
  const longText = (event.explanation?.length ?? 0) > 1000;
  if (!tooMany && !longTitle && !longText) return event;
  return {
    ...event,
    steps: event.steps.slice(0, SNAPSHOT_LIMITS.planSteps).map(s => (s.title.length > PLAN_TITLE_MAX ? { ...s, title: `${s.title.slice(0, PLAN_TITLE_MAX)}…` } : s)),
    explanation: short(event.explanation, 1000),
    ...(total > SNAPSHOT_LIMITS.planSteps ? { stepsTotal: total } : {}),
  };
}

/** JSON characters of an event as sent. */
export const eventChars = (e: TimelineEvent) => JSON.stringify(e).length;

/**
 * Event types whose older history feeds pinned state: plan panel and history, review totals, expressions,
 * elapsed time, worker state and token usage totals. reduceContext keeps only what those need.
 */
export const CONTEXT_EVENT_TYPES = ["user", "plan_update", "plan_state", "review_result", "expression", "turn_end", "goal_update", "agent_usage", "approval_request", "approval_resolved"] as const;
/** Types that do not count toward EVENT_PAGE_LIMITS.visible (hidden in the main view or folded into a card). */
export const QUIET_EVENT_TYPES = new Set(["tool_call", "tool_result", "agent_usage", "expression", "text_delta", "approval_auto", "dispatch", "peer_message"]);

const short = (text: string | undefined, n: number) => (text && text.length > n ? `${text.slice(0, n)}…` : text);

/** Minimal form of a context event (what the state readers use), or null when it is never needed. */
export function minimalContextEvent(e: TimelineEvent): TimelineEvent | null {
  const ev = e.event;
  let event: AgentEvent | null = null;
  switch (ev.type) {
    case "user": event = { type: "user", text: short(ev.text, 300) ?? "", attachments: [], ...(ev.queued ? { queued: true } : {}), ...(ev.delivery ? { delivery: ev.delivery } : {}) }; break;
    // The plan summary keeps the first steps and the real count (the generic shrink would cut it silently).
    case "plan_update": return { ...e, event: planSummary(ev) };
    case "plan_state": event = { ...ev, reason: short(ev.reason, 500) }; break;
    case "approval_request": event = { type: "approval_request", request: { ...ev.request, title: short(ev.request.title, 300) ?? "", detail: "", diffs: undefined } }; break;
    case "approval_resolved": case "review_result": case "expression": case "turn_end": case "agent_usage": case "goal_update": event = ev; break;
    default: return null;
  }
  return pageEvent({ ...e, event });
}

const isPlanCommandText = (text: string) => /^\/plan(?:\s|$)/.test(text);

/** Oldest-first list → newest entries that fit `budget` characters, in id order. */
function newestWithin(events: TimelineEvent[], budget: number): TimelineEvent[] {
  let start = events.length;
  for (let chars = 0; start > 0; start--) {
    const size = eventChars(events[start - 1]);
    if (chars + size > budget) break;
    chars += size;
  }
  return events.slice(start);
}

/** Caps of the state snapshot; together they keep it far below CONTEXT_MAX_CHARS. */
export const SNAPSHOT_LIMITS = { planSteps: 200, approvals: 50, conversations: 50 } as const;

/** An unanswered approval request, without its detail or diffs. */
export interface PendingApproval { eventId: number; at: number; id: string; role: Role; title: string; risk: ApprovalRequest["risk"] }

/**
 * The current state where the first page begins, computed in the core from the whole older history and
 * bounded by SNAPSHOT_LIMITS (what goes beyond a cap is counted, not sent):
 * - plan: the plan fold as it stands (shown checklist, its state and reason); steps over the cap are
 *   dropped from the end and counted in stepsOmitted;
 * - approvals: the newest unanswered requests and the total (the rest via the pending-approvals lookup);
 * - goal: the latest goal update; conversations: the latest expression and turn end of the most recently
 *   active conversations; lastUserAt: when the latest instruction was sent.
 */
export interface StateSnapshot {
  plan: { view: { planId?: number; steps: PlanStep[]; explanation?: string } | null; state: PlanState | "live"; reason?: string; planId?: number; stepsOmitted: number };
  approvals: { pending: PendingApproval[]; total: number };
  goal: ChatGoal | null;
  conversations: { node: NodeId; role: Role | null; expression?: AgentExpression; turnEnd?: { ok: boolean; interrupted?: boolean; at: number } }[];
  lastUserAt?: number;
}

/** Plan fold (same rules as currentPlanView) that also returns the state carried when no plan is shown. */
function foldPlan(events: readonly TimelineEvent[]): StateSnapshot["plan"] {
  let view = null as (NonNullable<StateSnapshot["plan"]["view"]> & { stepsTotal?: number }) | null;
  let state: PlanState | "live" = "live";
  let reason: string | undefined;
  let planId: number | undefined;
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "plan_update" && e.role === "orch") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId) { state = "live"; reason = undefined; }
      if (ev.planId !== undefined) planId = ev.planId;
      view = { planId, steps: ev.steps, explanation: ev.explanation, stepsTotal: ev.stepsTotal };
    } else if (ev.type === "plan_state") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId && ev.state !== "running") continue;
      state = ev.state;
      reason = ev.reason;
      if (ev.planId !== undefined) planId = ev.planId;
      if (view) view = { ...view, planId };
    } else if (ev.type === "user" && !ev.queued && ev.text !== "계획 실행" && !/^\/plan-(?:run|cancel)\b/.test(ev.text) && (isPlanCommandText(ev.text) || state !== "running")) {
      view = null;
      state = "live";
      reason = undefined;
      planId = undefined;
    }
  }
  const summary = view && planSummary({ type: "plan_update", steps: view.steps, explanation: view.explanation, stepsTotal: view.stepsTotal });
  return {
    view: view && summary && { planId: view.planId, steps: summary.steps, explanation: summary.explanation },
    state, reason: short(reason, 500), planId,
    stepsOmitted: summary ? (summary.stepsTotal ?? summary.steps.length) - summary.steps.length : 0,
  };
}

/**
 * Snapshot and past history from the minimal context events older than the first page (id order).
 * `context` holds only past history for history views (ended plans, reviews, usage totals), newest first
 * within what the snapshot leaves of CONTEXT_MAX_CHARS. The snapshot is always complete within its caps.
 */
export function reduceContext(events: readonly TimelineEvent[]): { context: TimelineEvent[]; snapshot: StateSnapshot } {
  const resolved = new Set<string>();
  for (const e of events) if (e.event.type === "approval_resolved") resolved.add(e.event.id);
  const pending: PendingApproval[] = [];
  const conversations = new Map<string, StateSnapshot["conversations"][number] & { last: number }>();
  const latest = new Map<string, number>();
  let goal = null as ChatGoal | null;
  let lastUserAt: number | undefined;
  events.forEach((e, i) => {
    const ev = e.event;
    if (ev.type === "approval_request" && !resolved.has(ev.request.id)) pending.push({ eventId: e.id, at: e.at, id: ev.request.id, role: ev.request.role, title: short(ev.request.title, 300) ?? "", risk: ev.request.risk });
    else if (ev.type === "goal_update") goal = ev.goal && { ...ev.goal, objective: short(ev.goal.objective, 1000) ?? "", progress: short(ev.goal.progress, 1000) ?? "" };
    else if (ev.type === "user") lastUserAt = e.at;
    else if (ev.type === "expression" || ev.type === "turn_end") {
      const key = `${e.node}|${e.role ?? ""}`;
      const c = conversations.get(key) ?? { node: e.node, role: e.role, last: 0 };
      if (ev.type === "expression") c.expression = ev.expression;
      else c.turnEnd = { ok: ev.ok, ...(ev.interrupted ? { interrupted: true } : {}), at: e.at };
      c.last = e.id;
      conversations.delete(key);
      conversations.set(key, c);
    }
    const key = ev.type === "review_result" ? `r${ev.consultId}` : ev.type === "agent_usage" ? `u|${e.role ?? ""}|${ev.metrics.turnId}` : null;
    if (key) latest.set(key, i);
  });
  const snapshot: StateSnapshot = {
    plan: foldPlan(events),
    approvals: { pending: pending.slice(-SNAPSHOT_LIMITS.approvals).reverse(), total: pending.length },
    goal,
    conversations: [...conversations.values()].sort((a, b) => b.last - a.last).slice(0, SNAPSHOT_LIMITS.conversations).map(({ last: _, ...c }) => c),
    ...(lastUserAt !== undefined ? { lastUserAt } : {}),
  };
  const past = events.filter((e, i) => {
    const ev = e.event;
    if (ev.type === "user" || ev.type === "plan_update" || ev.type === "plan_state") return true;
    if (ev.type === "review_result") return latest.get(`r${ev.consultId}`) === i;
    if (ev.type === "agent_usage") return latest.get(`u|${e.role ?? ""}|${ev.metrics.turnId}`) === i;
    return false;
  });
  return { context: newestWithin(past, CONTEXT_MAX_CHARS - JSON.stringify(snapshot).length), snapshot };
}

/**
 * The snapshot as events for the state readers (plan fold, worker state, expressions, instruction time).
 * It starts with a reset so it reproduces the snapshot whatever was folded before it. Never rendered.
 */
export function snapshotEvents(snapshot: StateSnapshot, chatId: number): TimelineEvent[] {
  let id = -1;
  const at = (event: AgentEvent, time: number, node: NodeId = "orch", role: Role | null = "orch"): TimelineEvent => ({ id: id--, chatId, node, role, at: time, event });
  const out: TimelineEvent[] = [at({ type: "user", text: "/plan", attachments: [] }, snapshot.lastUserAt ?? 0, "orch", null)];
  const { plan } = snapshot;
  if (plan.view) out.push(at({ type: "plan_update", steps: plan.view.steps, explanation: plan.view.explanation, planId: plan.view.planId, ...(plan.stepsOmitted ? { stepsTotal: plan.view.steps.length + plan.stepsOmitted } : {}) }, 0));
  if (plan.state !== "live") out.push(at({ type: "plan_state", state: plan.state, reason: plan.reason, planId: plan.planId }, 0));
  for (const c of [...snapshot.conversations].reverse()) {
    if (c.expression) out.push(at({ type: "expression", expression: c.expression }, 0, c.node, c.role));
    if (c.turnEnd) out.push(at({ type: "turn_end", ok: c.turnEnd.ok, ...(c.turnEnd.interrupted ? { interrupted: true } : {}) }, c.turnEnd.at, c.node, c.role));
  }
  for (const a of [...snapshot.approvals.pending].reverse()) out.push(at({ type: "approval_request", request: { id: a.id, role: a.role, title: a.title, detail: "", risk: a.risk } }, a.at, a.role, a.role));
  return out;
}

/** Event types whose original text remote web may read (text messages only), and the field holding it. */
export const REMOTE_TEXT_FIELDS = {
  user: "text", text: "text", room_message: "text", peer_message: "text", notice: "text",
  ask_user: "question", consult_start: "request", consult_end: "summary",
} as const satisfies Partial<Record<AgentEvent["type"], string>>;
/** Largest original text remote web returns (UTF-8 bytes); larger ones answer 413. */
export const REMOTE_TEXT_MAX_BYTES = 2_000_000;

/** One event's original text for remote web: allowed types only, only {id, type, text}. */
export type RemoteEventText =
  | { ok: true; id: number; type: keyof typeof REMOTE_TEXT_FIELDS; text: string }
  | { ok: false; reason: "missing" | "type" | "size"; length?: number };

export interface EventPage {
  /**
   * The page in id order. Besides the page itself it may start with the consult_start events of consults
   * that were still open where the page begins, so their worker events have a card to fold into.
   */
  events: TimelineEvent[];
  /** First event id of the page proper (anchors may be older). */
  start: number;
  /** Events older than `start` exist. */
  hasMore: boolean;
  /** Only on the first (newest) page: past history for history views (bounded, see reduceContext). Never rendered. */
  context?: TimelineEvent[];
  /** Only on the first page: the current state where it begins (bounded aggregate). */
  snapshot?: StateSnapshot;
}

/** What the window holds for a chat whose history is loaded in pages. */
export interface LoadedHistory {
  /** Events in id order (live events are appended; their id may be 0 while streaming). */
  events: TimelineEvent[];
  /** Past-history context events older than `start` (see EventPage.context). */
  context: TimelineEvent[];
  start: number;
  hasMore: boolean;
  /** The first page's state snapshot and where it applies (that page's start). */
  snapshot?: StateSnapshot;
  snapshotAt?: number;
}

export const historyFromPage = (page: EventPage): LoadedHistory => ({
  events: page.events, context: page.context ?? [], start: page.start, hasMore: page.hasMore,
  ...(page.snapshot && page.hasMore ? { snapshot: page.snapshot, snapshotAt: page.start } : {}),
});

/**
 * Put an older page in front of what is loaded. Anchors already loaded are not duplicated, and context
 * events now covered by real events are dropped. A page that does not end before the loaded start is
 * ignored (a stale request). The snapshot stays: it describes the state at its own point.
 */
export function prependPage(history: LoadedHistory, page: EventPage): LoadedHistory {
  if (page.start >= history.start && history.hasMore) return history;
  const loaded = new Set<number>();
  for (const e of history.events) if (e.id) loaded.add(e.id);
  const older = page.events.filter(e => !loaded.has(e.id));
  const merged = [...older, ...history.events];
  // Keep id order for persisted events; anchors (< start) sorted in, live id-0 events stay at the end.
  const persisted = merged.filter(e => e.id).sort((a, b) => a.id - b.id);
  const live = merged.filter(e => !e.id);
  return {
    ...history,
    events: [...persisted, ...live],
    context: history.context.filter(e => e.id < page.start),
    start: page.start,
    hasMore: page.hasMore,
  };
}

/**
 * Events for state that depends on the whole history: past context, loaded events older than the
 * snapshot point, the snapshot (which sets the current state there), then the rest. Never rendered.
 */
export function stateEvents(history: Pick<LoadedHistory, "events" | "context" | "snapshot" | "snapshotAt">): TimelineEvent[] {
  if (!history.snapshot || history.snapshotAt === undefined) return history.context.length ? [...history.context, ...history.events] : history.events;
  const at = history.snapshotAt;
  const split = history.events.findIndex(e => !e.id || e.id >= at);
  const before = split < 0 ? history.events : history.events.slice(0, split);
  const after = split < 0 ? [] : history.events.slice(split);
  return [...history.context, ...before, ...snapshotEvents(history.snapshot, history.events[0]?.chatId ?? 0), ...after];
}

/**
 * Live events that arrived while a snapshot (first page) was read, replayed on top of it.
 * - Persisted events at or before the snapshot's last id are already in it and are skipped.
 * - Streaming previews (text_delta, id 0) are replayed; when the final text or turn end of that stream is
 *   already in the snapshot, the preview is removed again so no stale copy remains.
 */
export function replayLive(snapshot: TimelineEvent[], buffered: readonly TimelineEvent[], append: (list: TimelineEvent[], e: TimelineEvent) => TimelineEvent[]): TimelineEvent[] {
  const lastId = snapshot.findLast(e => e.id)?.id ?? 0;
  let events = snapshot;
  for (const e of buffered) {
    if (e.id && e.id <= lastId) {
      if (e.event.type === "text" || e.event.type === "turn_end") {
        const i = events.findLastIndex(x => !x.id && x.event.type === "text_delta" && x.node === e.node && x.role === e.role);
        if (i >= 0) events = [...events.slice(0, i), ...events.slice(i + 1)];
      }
      continue;
    }
    events = append(events, e);
  }
  return events;
}

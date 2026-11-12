// Chat history in pages. Long chats (tens of thousands of events, hundreds of MB of tool output) are
// opened from their newest events; older pages load on demand, and large payloads are shortened until the
// reader asks for the full event. Shared by the core (db.ts), the desktop window and remote web.
//
// Size guarantee: every event in a page is at most EVENT_MAX_CHARS of JSON, the page events (with
// anchors) at most EVENT_PAGE_LIMITS.chars, the context at most CONTEXT_MAX_CHARS. Strings are UTF-16 at
// worst in the core frame, so a first page stays under PAGE_MAX_BYTES (16MB), far below the 128MB frame.
import type { AgentEvent, TimelineEvent } from "./types";

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
  if (event.type === "tool_call" && event.input.length > CLIP_AT) { event = { ...event, input: clipText(event.input), clipped: event.input.length }; clipped = true; }
  else if (event.type === "tool_result" && event.output.length > CLIP_AT) { event = { ...event, output: clipText(event.output), clipped: event.output.length }; clipped = true; }
  for (const [text, items] of STEPS) {
    if (JSON.stringify(event).length <= EVENT_MAX_CHARS) break;
    event = { ...(shrink(event, text, items) as AgentEvent), type: event.type } as AgentEvent;
    clipped = true;
  }
  return clipped ? { ...e, event, clipped: true } : e;
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
    case "plan_update": event = { ...ev, steps: ev.steps.slice(0, 100).map(s => ({ ...s, title: short(s.title, 300) ?? "" })), explanation: short(ev.explanation, 1000) }; break;
    case "plan_state": event = { ...ev, reason: short(ev.reason, 500) }; break;
    case "approval_request": event = { type: "approval_request", request: { ...ev.request, title: short(ev.request.title, 300) ?? "", detail: "", diffs: undefined } }; break;
    case "approval_resolved": case "review_result": case "expression": case "turn_end": case "agent_usage": case "goal_update": event = ev; break;
    default: return null;
  }
  return pageEvent({ ...e, event });
}

const isPlanCommandText = (text: string) => /^\/plan(?:\s|$)/.test(text);
/** A user event that ends the shown plan, given the plan state at that point (same rule as currentPlanView). */
const resetsPlan = (ev: AgentEvent, running: boolean) =>
  ev.type === "user" && !ev.queued && ev.text !== "계획 실행" && !/^\/plan-(?:run|cancel)\b/.test(ev.text) && (isPlanCommandText(ev.text) || !running);

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

/**
 * Bounded state snapshot of the history older than the first page, from minimal context events in id
 * order (minimalContextEvent). It has two parts:
 * - current state, always kept: the plan as it stands (events from its last reset on, without the user
 *   messages that did not change it, plus the latest user and /plan messages), unanswered approvals, the
 *   latest goal, and the latest expression and turn end of each conversation;
 * - past history, kept newest first within what is left of CONTEXT_MAX_CHARS: earlier instructions and
 *   plans (ended plans), the latest review of each consult, the latest usage of each role and turn.
 * The result is the past part followed by the current part, each in id order; folding it gives the same
 * plan, worker state and approvals as the whole history.
 */
export function reduceContext(events: readonly TimelineEvent[]): TimelineEvent[] {
  // Plan: find the last reset; the plan state depends only on what follows it.
  let running = false;
  let planId: number | undefined;
  let lastReset = -1;
  events.forEach((e, i) => {
    const ev = e.event;
    if (ev.type === "plan_update" && e.role === "orch") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId) running = false;
      if (ev.planId !== undefined) planId = ev.planId;
    } else if (ev.type === "plan_state") {
      if (ev.planId !== undefined && planId !== undefined && ev.planId !== planId && ev.state !== "running") return;
      running = ev.state === "running";
      if (ev.planId !== undefined) planId = ev.planId;
    } else if (resetsPlan(ev, running)) {
      running = false;
      planId = undefined;
      lastReset = i;
    }
  });
  const lastUser = events.findLastIndex(e => e.event.type === "user");
  const lastPlanCommand = events.findLastIndex(e => e.event.type === "user" && !e.event.queued && isPlanCommandText(e.event.text));
  const resolved = new Set<string>();
  for (const e of events) if (e.event.type === "approval_resolved") resolved.add(e.event.id);
  const latest = new Map<string, number>();
  const keyOf = (e: TimelineEvent) => {
    const ev = e.event;
    return ev.type === "review_result" ? `r${ev.consultId}`
      : ev.type === "expression" || ev.type === "turn_end" ? `${ev.type}|${e.node}|${e.role ?? ""}`
        : ev.type === "agent_usage" ? `u|${e.role ?? ""}|${ev.metrics.turnId}`
          : ev.type === "goal_update" ? "goal" : null;
  };
  events.forEach((e, i) => { const key = keyOf(e); if (key) latest.set(key, i); });

  const current: TimelineEvent[] = [];
  const past: TimelineEvent[] = [];
  events.forEach((e, i) => {
    const ev = e.event;
    const isLatest = () => latest.get(keyOf(e)!) === i;
    switch (ev.type) {
      case "user":
        // From the last reset on only the reset itself, the latest user message and the latest /plan matter.
        if (i < lastReset) past.push(e);
        else if (i === lastReset || i === lastUser || i === lastPlanCommand) current.push(e);
        break;
      case "plan_update": case "plan_state": (i < lastReset ? past : current).push(e); break;
      case "approval_request": if (!resolved.has(ev.request.id)) current.push(e); break;
      case "goal_update": case "expression": case "turn_end": if (isLatest()) current.push(e); break;
      case "review_result": case "agent_usage": if (isLatest()) past.push(e); break;
      default: break;
    }
  });
  // Only the newest of a long run of checklist updates for the same plan changes what folds out of it.
  const compact = current.filter((e, i) => {
    const next = current[i + 1];
    return !(e.event.type === "plan_update" && next?.event.type === "plan_update" && e.event.planId === next.event.planId && next.role === e.role);
  });
  // Unanswered approvals far beyond what anyone can act on are capped to the newest.
  const approvals = compact.filter(e => e.event.type === "approval_request");
  const kept = approvals.length > 500 ? compact.filter(e => e.event.type !== "approval_request" || approvals.indexOf(e) >= approvals.length - 500) : compact;
  const currentChars = kept.reduce((n, e) => n + eventChars(e), 0);
  return [...newestWithin(past, Math.max(0, CONTEXT_MAX_CHARS - currentChars)), ...kept];
}

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
  /**
   * Only on the first (newest) page: the reduced, bounded state snapshot of older history (reduceContext).
   * Never rendered as timeline items.
   */
  context?: TimelineEvent[];
}

/** What the window holds for a chat whose history is loaded in pages. */
export interface LoadedHistory {
  /** Events in id order (live events are appended; their id may be 0 while streaming). */
  events: TimelineEvent[];
  /** Context events older than `start` (see EventPage.context). */
  context: TimelineEvent[];
  start: number;
  hasMore: boolean;
}

export const historyFromPage = (page: EventPage): LoadedHistory => ({ events: page.events, context: page.context ?? [], start: page.start, hasMore: page.hasMore });

/**
 * Put an older page in front of what is loaded. Anchors already loaded are not duplicated, and context
 * events now covered by real events are dropped. A page that does not end before the loaded start is
 * ignored (a stale request).
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
    events: [...persisted, ...live],
    context: history.context.filter(e => e.id < page.start),
    start: page.start,
    hasMore: page.hasMore,
  };
}

/** Events for state that depends on the whole history (plan, reviews, expressions): context, then the loaded events. */
export const stateEvents = (history: Pick<LoadedHistory, "events" | "context">): TimelineEvent[] =>
  history.context.length ? [...history.context, ...history.events] : history.events;

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

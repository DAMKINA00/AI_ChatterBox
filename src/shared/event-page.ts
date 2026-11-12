// Chat history in pages. Long chats (tens of thousands of events, hundreds of MB of tool output) are
// opened from their newest events; older pages load on demand, and large tool payloads are shortened
// until the reader asks for the full text. Shared by the core (db.ts), the desktop window and remote web.
import type { AgentEvent, TimelineEvent } from "./types";

/** One page: stop at whichever limit is reached first (counted from the newest event backwards). */
export const EVENT_PAGE_LIMITS = {
  /** Events that show up as their own item in the main view (tool logs and usage records do not count). */
  visible: 300,
  /** All events, so a page of only tool logs stays bounded. */
  events: 4000,
  /** Characters of stored payload before shortening; keeps one page well under the core frame limit. */
  chars: 4_000_000,
} as const;

/** Tool input/output longer than this is shortened in history pages (full text: one event on demand). */
export const CLIP_AT = 6000;
const HEAD = 4000;
const TAIL = 1500;

const clipText = (text: string) => `${text.slice(0, HEAD)}\n\n… (${(text.length - HEAD - TAIL).toLocaleString("ko-KR")}자 생략) …\n\n${text.slice(-TAIL)}`;

/** The event as sent in a history page: long tool input/output and auto-approval details shortened. */
export function lightEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "tool_call":
      return event.input.length > CLIP_AT ? { ...event, input: clipText(event.input), clipped: event.input.length } : event;
    case "tool_result":
      return event.output.length > CLIP_AT ? { ...event, output: clipText(event.output), clipped: event.output.length } : event;
    case "approval_auto":
      // Shown as a one-line notice; the full request stays in the database.
      return event.request.detail.length > CLIP_AT ? { ...event, request: { ...event.request, detail: clipText(event.request.detail) } } : event;
    default:
      return event;
  }
}

/**
 * Event types whose whole history drives pinned state: plan panel and history, review totals, expressions,
 * elapsed time, worker state and token usage totals. All are small.
 */
export const CONTEXT_EVENT_TYPES = ["user", "plan_update", "plan_state", "review_result", "expression", "turn_end", "goal_update", "agent_usage", "approval_request", "approval_resolved"] as const;
/** Types that do not count toward EVENT_PAGE_LIMITS.visible (hidden in the main view or folded into a card). */
export const QUIET_EVENT_TYPES = new Set(["tool_call", "tool_result", "agent_usage", "expression", "text_delta", "approval_auto", "dispatch", "peer_message"]);

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
   * Only on the first (newest) page: CONTEXT_EVENT_TYPES events older than `start`, for state that depends
   * on the whole history. They are never rendered as timeline items.
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
  // Anchors of the newer page with ids inside the new page range are now real events in order.
  const newer = history.events.filter(e => !(e.id && e.id < history.start && e.id >= page.start && older.some(o => o.id === e.id)));
  const merged = [...older, ...newer];
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

/** Run statistics only need timing and ids; this is every event of a chat in that minimal form. */
export function statsEvent(e: TimelineEvent): TimelineEvent {
  const ev = e.event;
  switch (ev.type) {
    case "tool_call": return { ...e, event: { type: "tool_call", id: ev.id, name: ev.name, input: "" } };
    case "tool_result": return { ...e, event: { type: "tool_result", id: ev.id, ok: ev.ok, output: "" } };
    case "approval_request": return { ...e, event: { type: "approval_request", request: { ...ev.request, detail: "", diffs: undefined } } };
    case "approval_auto": return { ...e, event: { ...ev, request: { ...ev.request, detail: "", diffs: undefined } } };
    case "turn_end": case "approval_resolved": return e;
    default: return { ...e, event: { type: "notice", text: "" } };
  }
}

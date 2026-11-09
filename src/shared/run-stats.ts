// Technical execution statistics for one timeline node: how long the recorded run spans and how
// much of it was spent waiting for approvals or inside tool calls. Observation only — model
// reasoning time, tokens and cost are not inferred here, and an empty history is not a success.
//
// `elapsedMs` is the span of the *recorded* events (first to last timestamp, or to `now` while
// the node is still running). It is not active execution time: it can include the user being
// idle, an idle chat, or a long wait between two instructions of the same worker.
// Approval waits and tool runs can overlap each other and can nest, so each total is the union of
// its own intervals. Never add toolMs + approvalMs and call that elapsed; report only that the
// parts may overlap.
// Approvals answered by the app itself (approval_auto) never open a wait interval: the app emits
// that event instead of an approval_request, so only a user-facing request can be pending.
import type { AgentEvent, NodeId, Role, TimelineEvent } from "./types";

export interface RunStats {
  /** Span of the recorded events, first to last (or to `now` while running). Not model time. */
  elapsedMs: number;
  /** Union of tool_call → tool_result intervals, including calls that never returned. */
  toolMs: number;
  /** Union of approval_request → approval_resolved intervals, including unanswered ones. */
  approvalMs: number;
  /** Calls with no result before their turn ended; they run to that end, never to 0 ms. */
  pendingTools: number;
  /** Approval requests with no decision yet in this scope. */
  pendingApprovals: number;
  /** tool_result events reporting failure; a replayed event counts once. */
  failedTools: number;
  /** turn_end with ok=false that was not an interruption (a user stop is not a failure). */
  failedTurns: number;
  /** Events considered after the node/role filter and replay de-duplication. */
  eventCount: number;
}

type Interval = { start: number; end: number };

const SEP = "\u0000";

/**
 * The node+role pair that owns a call. Ids are per node/role, so the same tool id under another
 * worker never pairs, and a turn_end only closes the calls of its own conversation.
 */
function scopeOf(event: TimelineEvent): string {
  return `${event.node}${SEP}${event.role ?? ""}`;
}

/**
 * Live preview events carry id 0 and stay distinct; a stored event replayed with the same id is
 * the same observation and must not be counted twice.
 */
function dedupe(events: TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<number>();
  const kept: TimelineEvent[] = [];
  for (const event of events) {
    if (event.id > 0) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    kept.push(event);
  }
  return kept;
}

/** Clamps to the window and never returns a negative duration. */
function clamp(start: number, end: number, windowStart: number, windowEnd: number): Interval {
  const clampedStart = Math.max(start, windowStart);
  return { start: clampedStart, end: Math.min(Math.max(end, clampedStart), windowEnd) };
}

/** Total of merged intervals: two tools running at the same time count once. */
function unionMs(intervals: Interval[]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      if (interval.end > end) end = interval.end;
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return total + (end - start);
}

interface Tracked {
  intervals: Interval[];
  pending: number;
  failures: number;
}

interface TrackOptions {
  /**
   * Tools belong to a turn: drivers re-emit tool_call for the same id while the call is still
   * running (Codex item updates), so a repeated start folds into the open call, and an open call
   * of the same node/role is pending at that conversation's turn_end. Approvals can be answered
   * after the turn ended, so they are not turn-scoped.
   */
  turnScoped: boolean;
  windowStart: number;
  windowEnd: number;
}

function track(events: TimelineEvent[], kind: "tool" | "approval", options: TrackOptions): Tracked {
  // scope → id → start. Calls are kept per node/role so one conversation's turn end, stop or
  // result never closes another conversation's call in a whole-chat summary.
  const open = new Map<string, Map<string, number>>();
  const intervals: Interval[] = [];
  const { turnScoped, windowStart, windowEnd } = options;
  let pending = 0;
  let failures = 0;

  const openCall = (event: TimelineEvent, id: string) => {
    const scope = scopeOf(event);
    const calls = open.get(scope);
    if (!calls) open.set(scope, new Map([[id, event.at]]));
    else if (!calls.has(id)) calls.set(id, event.at); // a repeated update folds into the open call
  };

  const closeCall = (event: TimelineEvent, id: string) => {
    const scope = scopeOf(event);
    const calls = open.get(scope);
    const start = calls?.get(id);
    if (!calls || start === undefined) return false; // a result without an open call adds no time
    calls.delete(id);
    if (!calls.size) open.delete(scope);
    intervals.push(clamp(start, event.at, windowStart, windowEnd));
    return true;
  };

  const closeScope = (scope: string, end: number) => {
    const calls = open.get(scope);
    if (!calls) return;
    for (const start of calls.values()) {
      pending++;
      intervals.push(clamp(start, end, windowStart, windowEnd));
    }
    open.delete(scope);
  };

  for (const event of events) {
    const payload: AgentEvent = event.event;
    if (kind === "tool" && payload.type === "tool_call") {
      openCall(event, payload.id);
      continue;
    }
    if (kind === "tool" && payload.type === "tool_result") {
      // A failure counts only when it closes a call of this conversation. An orphan result
      // (no open call, e.g. after a turn end already finalised it) is ignored entirely.
      if (closeCall(event, payload.id) && !payload.ok) failures++;
      continue;
    }
    if (kind === "approval" && payload.type === "approval_request") {
      openCall(event, payload.request.id);
      continue;
    }
    if (kind === "approval" && payload.type === "approval_resolved") {
      closeCall(event, payload.id);
      continue;
    }
    if (turnScoped && payload.type === "turn_end") closeScope(scopeOf(event), event.at);
  }

  for (const [scope, calls] of open) {
    for (const start of calls.values()) {
      pending++;
      intervals.push(clamp(start, windowEnd, windowStart, windowEnd));
    }
    open.delete(scope);
  }
  return { intervals, pending, failures };
}

function span(events: TimelineEvent[]): { min: number; max: number } {
  let min = events[0].at;
  let max = events[0].at;
  for (const event of events) {
    if (event.at < min) min = event.at;
    if (event.at > max) max = event.at;
  }
  return { min, max };
}

/**
 * @param events one chat's timeline events, in stored (event id) order — that order is the only
 *   causal order we have, so it is never re-sorted by timestamp; a pair whose end is stamped
 *   earlier than its start is measured as 0 ms instead of inventing a duration.
 * @param options node/role narrow the scope; `now` is for a still-running node, where the last
 *   event is not the end of the run. Without `now` the run is measured up to its last event.
 */
export function summarizeRunStats(
  events: readonly TimelineEvent[],
  options: { node?: NodeId; role?: Role; now?: number } = {},
): RunStats {
  const scopedEvents = dedupe(
    events.filter((e) => (options.node === undefined || e.node === options.node) && (options.role === undefined || e.role === options.role)),
  );
  const stats: RunStats = {
    elapsedMs: 0,
    toolMs: 0,
    approvalMs: 0,
    pendingTools: 0,
    pendingApprovals: 0,
    failedTools: 0,
    failedTurns: 0,
    eventCount: scopedEvents.length,
  };
  if (!scopedEvents.length) return stats;

  const { min, max } = span(scopedEvents);
  // A stale `now` never shrinks a run that already has later events recorded.
  const windowEnd = Math.max(options.now ?? max, max);
  stats.elapsedMs = windowEnd - min;

  const tools = track(scopedEvents, "tool", { turnScoped: true, windowStart: min, windowEnd });
  const approvals = track(scopedEvents, "approval", { turnScoped: false, windowStart: min, windowEnd });

  stats.toolMs = unionMs(tools.intervals);
  stats.approvalMs = unionMs(approvals.intervals);
  stats.pendingTools = tools.pending;
  stats.pendingApprovals = approvals.pending;
  stats.failedTools = tools.failures;

  for (const event of scopedEvents) {
    if (event.event.type !== "turn_end") continue;
    if (event.event.ok !== false || event.event.interrupted === true) continue;
    stats.failedTurns++;
  }
  return stats;
}

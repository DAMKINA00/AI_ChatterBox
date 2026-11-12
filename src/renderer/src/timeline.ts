// Folds TimelineEvents into display items for one view of a chat:
//  - unified (default): user + orchestrator, with each consult as a card holding the worker's events.
//    It reads as the group chat: the app's consult-result copies, 1:1 messages and top-level tool cards are
//    left to the master/worker/consult views (stored events and team delivery are unchanged).
//  - "orch" / "claude" / "gpt": one conversation, flat
//  - "consult:N": one consult
import { isAgentExpression, isWorkerKey } from "../../shared/types";
import { currentPlanView, type PlanView } from "../../shared/plan-lifecycle";
import { roomProvenance, systemBrief, type ConsultFacts, type RoomProvenance } from "../../shared/room-message";
import type { AgentExpression, AgentEvent, ApprovalDecision, ApprovalRequest, AttachmentRef, ConsultKind, ConsultStatus, FileDiff, NodeId, ReviewResult, Role, TimelineEvent } from "../../shared/types";

export type Item =
  | { kind: "artifacts"; key: string; paths: string[] }
  /** eventId: the persisted event (fork point); absent for live previews. */
  | { kind: "user"; key: string; text: string; attachments: AttachmentRef[]; at: number; queued?: boolean; delivery?: "now" | "next"; eventId?: number }
  /**
   * room: a group chat line (send_message to=all or an app copy). origin "result": the app's copy of a finished
   * consult, not something the worker said.
   */
  | { kind: "message"; key: string; role: Role; node: NodeId; text: string; streaming: boolean; expression: AgentExpression; at: number; eventId?: number; room?: true; origin?: "result" }
  /** Read-only transcript a forked chat started from. */
  | { kind: "fork"; key: string; text: string; attachments: AttachmentRef[]; at: number }
  /** inputClipped/result.clipped: a history page shortened the text; callEventId/eventId fetch the full event. */
  | { kind: "tool"; key: string; role: Role; id: string; name: string; input: string; diffs?: FileDiff[]; callEventId?: number; inputClipped?: number; result?: { ok: boolean; output: string; eventId?: number; clipped?: number } }
  | { kind: "files"; key: string; role: Role; files: FileDiff[]; ok: boolean }
  | { kind: "approval"; key: string; request: ApprovalRequest; decision?: ApprovalDecision | "auto" | "expired" }
  | { kind: "auto"; key: string; request: ApprovalRequest; decision: "allow" | "deny"; reason: string; reused?: boolean }
  | {
      kind: "consult";
      key: string;
      consultId: number;
      from: Role;
      to: Role;
      consultKind: ConsultKind;
      request: string;
      attachments: AttachmentRef[];
      status: ConsultStatus;
      scope?: string[];
      reason?: string;
      summary?: string;
      files?: string[];
      /** Structured report_review result; absent = none submitted (never treated as a pass). */
      review?: ReviewResult;
      children: Item[];
      at: number;
    }
  | { kind: "image"; key: string; role: Role; node: NodeId; id: string; status: "running" | "done" | "error"; prompt?: string; attachment?: AttachmentRef; error?: string }
  | { kind: "ask"; key: string; id: string; question: string; options: string[]; answer?: string }
  | { kind: "peer"; key: string; from: Role; to: Role; text: string }
  /** origin "system": an app status line from the group chat; detail keeps its full original text. */
  | { kind: "notice"; key: string; tone: "error" | "auth" | "info"; text: string; detail?: string; origin?: "system" };

type View = NodeId | undefined;

function consultOf(node: NodeId): number | null {
  return node.startsWith("consult:") ? Number(node.slice(8)) : null;
}

/** Should this event appear in the view, and where. */
function belongs(e: TimelineEvent, view: View, consultTargets: Map<number, Role>): "top" | "child" | false {
  const ev = e.event;
  if (ev.type === "room_message") return "top";
  const cId = consultOf(e.node);
  if (view === undefined) {
    if (ev.type === "approval_request" || ev.type === "approval_resolved") return "top";
    // A nested consult and its completion belong inside the parent consult card.
    if (cId !== null) return "child";
    return "top";
  }
  if (ev.type === "peer_message" && (ev.from === view || ev.to === view)) return "top";
  if (view === "orch") return ev.type === "approval_request" || ev.type === "approval_resolved" || e.role === "orch" || e.role === null ? "top" : false;
  if (isWorkerKey(view)) {
    if ((ev.type === "consult_start" || ev.type === "consult_end") && consultTarget(e, consultTargets) === view) return "top";
    return e.role === view ? "top" : false;
  }
  const want = consultOf(view);
  if ((ev.type === "consult_start" || ev.type === "consult_end") && ev.consultId === want) return "top";
  return cId === want ? "top" : false;
}

function consultTarget(e: TimelineEvent, consultTargets: Map<number, Role>): Role | undefined {
  const ev = e.event;
  if (ev.type === "consult_start") {
    consultTargets.set(ev.consultId, ev.to);
    return ev.to;
  }
  if (ev.type === "consult_end") return consultTargets.get(ev.consultId);
  return undefined;
}

/** Normalize persisted or live expression metadata at the renderer boundary. */
export function currentExpression(value: unknown, fallback: AgentExpression = "neutral"): AgentExpression {
  return isAgentExpression(value) ? value : fallback;
}

/** Current role-level expression used by compact team chips; turn completion resets it. */
export function latestExpression(events: TimelineEvent[], role: Role): AgentExpression {
  let expression: AgentExpression = "neutral";
  let explicit = false;
  for (const e of events) {
    if (e.role !== role) continue;
    switch (e.event.type) {
      case "expression":
        expression = currentExpression(e.event.expression);
        explicit = true;
        break;
      case "text_delta":
        if (!explicit) expression = "speaking";
        break;
      case "turn_end":
        expression = "neutral";
        explicit = false;
        break;
    }
  }
  return expression;
}

type ExpressionKey = `${NodeId}\u0000${Role}`;
type ExpressionState = Map<ExpressionKey, AgentExpression>;

function expressionKey(node: NodeId, role: Role): ExpressionKey {
  return `${node}\u0000${role}`;
}

function hasStreamingMessage(items: Item[], node: NodeId, role: Role): boolean {
  return items.some(
    (x) =>
      (x.kind === "message" && x.streaming && x.role === role && x.node === node) ||
      (x.kind === "consult" && hasStreamingMessage(x.children, node, role)),
  );
}

function messageExpression(items: Item[], node: NodeId, role: Role, state: ExpressionState, fallback: AgentExpression): AgentExpression {
  // An expression arriving while a stream is already open must not rewrite that message.
  if (hasStreamingMessage(items, node, role)) {
    const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role && x.node === node);
    if (i >= 0) return (items[i] as Extract<Item, { kind: "message" }>).expression;
    // The active stream may live inside a nested consult card; its expression is preserved by apply().
    return fallback;
  }
  const key = expressionKey(node, role);
  const expression = state.get(key) ?? fallback;
  state.delete(key);
  return expression;
}

function itemsAtPath(items: Item[], path: number[]): Item[] | undefined {
  for (const index of path) {
    const item = items[index];
    if (item?.kind !== "consult") return undefined;
    items = item.children;
  }
  return items;
}

function applyAtPath(items: Item[], path: number[], e: TimelineEvent, expression?: AgentExpression, depth = 0): Item[] {
  if (depth === path.length) return apply(items, e, expression);
  const index = path[depth];
  const item = items[index] as Extract<Item, { kind: "consult" }>;
  const children = applyAtPath(item.children, path, e, expression, depth + 1);
  if (children === item.children) return items;
  const next = items.slice();
  next[index] = { ...item, children };
  return next;
}

function applyInConsult(items: Item[], consultId: number, e: TimelineEvent, expression?: AgentExpression): Item[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "consult") return item;
    if (item.consultId === consultId) {
      changed = true;
      return { ...item, children: apply(item.children, e, expression) };
    }
    const children = applyInConsult(item.children, consultId, e, expression);
    if (children !== item.children) {
      changed = true;
      return { ...item, children };
    }
    return item;
  });
  return changed ? next : items;
}

function attachReview(items: Item[], consultId: number, review: ReviewResult): Item[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== "consult") return item;
    if (item.consultId === consultId) {
      changed = true;
      return { ...item, review };
    }
    const children = attachReview(item.children, consultId, review);
    if (children === item.children) return item;
    changed = true;
    return { ...item, children };
  });
  return changed ? next : items;
}

interface FoldState {
  top: Item[];
  consultTargets: Map<number, Role>;
  expressions: ExpressionState;
  consultPaths: Map<number, number[] | null>;
  /** Recorded end status per consult, to recognize the app's legacy result copies exactly. */
  consultEnds: Map<number, { status: ConsultStatus; summary: string }>;
}

const emptyFold = (): FoldState => ({ top: [], consultTargets: new Map(), expressions: new Map(), consultPaths: new Map(), consultEnds: new Map() });
const copyFold = (state: FoldState): FoldState => ({ top: state.top, consultTargets: new Map(state.consultTargets), expressions: new Map(state.expressions), consultPaths: new Map(state.consultPaths), consultEnds: new Map(state.consultEnds) });

/** Group chat line as a display item; the main view drops result copies before this. */
function roomItem(e: TimelineEvent, ev: Extract<AgentEvent, { type: "room_message" }>, provenance: RoomProvenance): Item {
  const key = e.id ? `e${e.id}` : `live-${e.node}-${e.role ?? "orch"}`;
  if (provenance.kind === "system") return { kind: "notice", key, tone: "info", text: systemBrief(ev.text), detail: ev.text, origin: "system" };
  // No eventId: a group message is not a fork point, even when the master wrote it.
  return { kind: "message", key, role: ev.from, node: "orch", text: ev.text, streaming: false, expression: "neutral", at: e.at, room: true, ...(provenance.kind === "result" ? { origin: "result" as const } : {}) };
}

function foldEvents(events: TimelineEvent[], view: View, state: FoldState, start = 0, beforeEvent?: (index: number, state: FoldState) => void) {
  let { top } = state;
  const { consultTargets, expressions, consultPaths, consultEnds } = state;
  const facts: ConsultFacts = { target: (id) => consultTargets.get(id), ended: (id) => consultEnds.get(id) };
  for (let index = start; index < events.length; index++) {
    if (beforeEvent) beforeEvent(index, { top, consultTargets, expressions, consultPaths, consultEnds });
    const e = events[index];
    if (e.event.type === "review_result") {
      // Reported from inside the consult; the result belongs on the consult card itself in every view.
      top = attachReview(top, e.event.consultId, e.event.review);
      continue;
    }
    if (e.event.type === "consult_start") consultTarget(e, consultTargets);
    if (e.event.type === "consult_end") consultEnds.set(e.event.consultId, { status: e.event.status, summary: e.event.summary });
    if (e.event.type === "room_message") {
      const provenance = roomProvenance(e.event, facts);
      // The consult card already shows this result's state in the main view; its full text is in the detail views.
      if (view === undefined && provenance.kind === "result") continue;
      top = [...top, roomItem(e, e.event, provenance)];
      continue;
    }
    if (view === undefined) {
      // 1:1 traffic (including check_agent prompts) belongs to the sender/recipient views.
      if (e.event.type === "peer_message") continue;
      if (consultOf(e.node) === null) {
        // Top-level tool logs stay in the master/worker views; a hidden call still ends the open stream.
        if (e.event.type === "tool_call") {
          top = closeStream(top, (e.role ?? "orch") as Role, e.node);
          continue;
        }
        if (e.event.type === "tool_result") continue;
      }
    }
    const where = belongs(e, view, consultTargets);
    if (!where) continue;
    const role = (e.role ?? "orch") as Role;
    const node = e.node;
    const ev = e.event;
    const path = where === "child" ? consultPaths.get(consultOf(node)!) : [];
    const target = path ? itemsAtPath(top, path) : undefined;
    // apply() only appends or replaces items, so these paths survive subsequent events.
    // Duplicate/malformed consult ids retain the recursive fallback used by older histories.
    if (ev.type === "consult_start") consultPaths.set(ev.consultId, target && !consultPaths.has(ev.consultId) ? [...path!, target.length] : null);
    if (ev.type === "expression") {
      expressions.set(expressionKey(node, role), currentExpression(ev.expression));
      continue;
    }
    const expression = ev.type === "text_delta" ? messageExpression(target ?? top, node, role, expressions, "speaking") : ev.type === "text" ? messageExpression(target ?? top, node, role, expressions, "neutral") : undefined;
    if (where === "child") {
      const id = consultOf(e.node);
      if (id !== null) {
        const next = target && path ? applyAtPath(top, path, e, expression) : applyInConsult(top, id, e, expression);
        if (next !== top) {
          top = next;
          if (ev.type === "turn_end") expressions.delete(expressionKey(node, role));
          continue;
        }
      }
      // Keep the stream boundary deterministic when a malformed history has no parent card.
      if (ev.type === "turn_end") expressions.delete(expressionKey(node, role));
      continue;
    }
    top = apply(top, e, expression);
    if (ev.type === "turn_end") expressions.delete(expressionKey(node, role));
  }
  state.top = top;
  return state;
}

export function buildItems(events: TimelineEvent[], view: View, live: boolean): Item[] {
  const state = foldEvents(events, view, emptyFold());
  return live ? state.top : closeHistory(state.top);
}

/** Reuse the immutable prefix instead of folding hours of history for every streamed token. */
export function createTimelineBuilder(): typeof buildItems {
  const checkpoints = new Map<number, FoldState>([[0, emptyFold()]]);
  let previous: TimelineEvent[] = [];
  let previousView: View;
  let previousLive: boolean | undefined;
  let previousState = emptyFold();
  let beforeLast: FoldState | undefined;
  let result: Item[] = [];
  return (events, view, live) => {
    if (events === previous && view === previousView && live === previousLive) return result;
    let common = 0;
    if (view === previousView) {
      while (common < events.length && common < previous.length && events[common] === previous[common]) common++;
    }
    for (const index of checkpoints.keys()) if (index > common) checkpoints.delete(index);
    let start = 0;
    let base = checkpoints.get(0)!;
    for (const [index, state] of checkpoints) {
      if (index <= common && index >= start) { start = index; base = state; }
    }
    if (view === previousView && previous.length <= common) {
      start = previous.length;
      base = previousState;
    } else if (view === previousView && beforeLast && previous.length - 1 <= common && previous.length - 1 >= start) {
      start = previous.length - 1;
      base = beforeLast;
    }
    if (events !== previous) beforeLast = undefined;
    const state = foldEvents(events, view, copyFold(base), start, (index, current) => {
      if (index > 0 && index % 128 === 0) {
        checkpoints.set(index, copyFold(current));
        // Bound retained snapshots even when a chat runs for days; history itself stays intact.
        if (checkpoints.size > 65) {
          for (const oldest of checkpoints.keys()) if (oldest !== 0) { checkpoints.delete(oldest); break; }
        }
      }
      if (index === events.length - 1) beforeLast = copyFold(current);
    });
    previous = events;
    previousView = view;
    previousLive = live;
    previousState = state;
    result = live ? state.top : closeHistory(state.top);
    return result;
  };
}

/** Keep recent chat/view folds alive when React unmounts a chat, without retaining every view. */
export function createTimelineCache(limit = 6) {
  const entries = new Map<string, { chatId: number; build: typeof buildItems }>();
  return {
    build(chatId: number, events: TimelineEvent[], view: View, live: boolean) {
      const key = `${chatId}:${view ?? "all"}`;
      const entry = entries.get(key) ?? { chatId, build: createTimelineBuilder() };
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
      return entry.build(events, view, live);
    },
    delete(chatId: number) {
      for (const [key, entry] of entries) if (entry.chatId === chatId) entries.delete(key);
    },
  };
}

export const chatTimelines = createTimelineCache();

function closeHistory(items: Item[]): Item[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind === "consult") {
      const children = closeHistory(item.children);
      if (children !== item.children) {
        changed = true;
        return { ...item, children };
      }
      return item;
    }
    if (item.kind === "approval" && !item.decision) {
      changed = true;
      return { ...item, decision: "expired" as const };
    }
    if (item.kind === "message" && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : items;
}

function closeStream(items: Item[], role: Role | null, node?: NodeId): Item[] {
  const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role && (node === undefined || x.node === node));
  if (i < 0) return items;
  const copy = items.slice();
  copy[i] = { ...(copy[i] as Extract<Item, { kind: "message" }>), streaming: false };
  return copy;
}

function nextLiveMessageKey(items: Item[], role: Role, node: NodeId): string {
  const prefix = `live-${node}-${role}-`;
  const count = items.reduce((n, item) => (item.kind === "message" && item.role === role && item.node === node && item.key.startsWith(prefix) ? n + 1 : n), 0);
  return `${prefix}${count}`;
}

export function apply(items: Item[], e: TimelineEvent, expression?: AgentExpression): Item[] {
  const ev: AgentEvent = e.event;
  const role = (e.role ?? "orch") as Role;
  const node = e.node;
  // Stable keys keep React state (open cards) across rebuilds; live deltas have no id yet.
  const key = e.id ? `e${e.id}` : `live-${e.node}-${role}`;
  switch (ev.type) {
    case "room_message":
      // Without consult facts only an explicit kind or the status-check wrapper is recognized.
      return [...items, roomItem(e, ev, roomProvenance(ev))];
    case "peer_message":
      return [...items, { kind: "peer", key, from: ev.from, to: ev.to, text: ev.text }];
    case "agent_usage":
      return items;
    case "expression":
      return items;
    case "user":
      return [...items, { kind: "user", key: key, text: ev.text, attachments: ev.attachments, at: e.at, queued: ev.queued, delivery: ev.delivery, eventId: e.id || undefined }];
    case "fork_context":
      return [...items, { kind: "fork", key, text: ev.text, attachments: ev.attachments ?? [], at: e.at }];
    case "review_result":
      // Folded onto the consult card by foldEvents; apply() alone has no card to attach it to.
      return attachReview(items, ev.consultId, ev.review);
    case "artifacts":
      return [...items, { kind: "artifacts", key, paths: ev.paths }];
    case "text_delta": {
      const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role && x.node === node);
      if (i >= 0) {
        const m = items[i] as Extract<Item, { kind: "message" }>;
        return [...items.slice(0, i), { ...m, text: m.text + ev.text }, ...items.slice(i + 1)];
      }
      return [...closeStream(items, role, node), { kind: "message", key: e.id ? key : nextLiveMessageKey(items, role, node), role, node, text: ev.text, streaming: true, expression: expression ?? "speaking", at: e.at }];
    }
    case "text": {
      const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role && x.node === node);
      if (i >= 0) {
        const message = items[i] as Extract<Item, { kind: "message" }>;
        return [...items.slice(0, i), { ...message, text: ev.text, streaming: false, eventId: e.id || undefined }, ...items.slice(i + 1)];
      }
      return [...closeStream(items, role, node), { kind: "message", key: e.id ? key : nextLiveMessageKey(items, role, node), role, node, text: ev.text, streaming: false, expression: expression ?? "neutral", at: e.at, eventId: e.id || undefined }];
    }
    case "tool_call":
      // The orchestrator's consult/ask tools and expression helper are not shown as timeline cards.
      if (ev.name.includes("chatterbox_bridge") || ev.name === "set_expression" || ev.name === "mcp__chatterbox_bridge__set_expression") return closeStream(items, role, node);
      return [...closeStream(items, role, node), { kind: "tool", key: key, role, id: ev.id, name: ev.name, input: ev.input, diffs: ev.diffs, ...(ev.clipped ? { callEventId: e.id, inputClipped: ev.clipped } : {}) }];
    case "tool_result": {
      const i = items.findLastIndex((x) => x.kind === "tool" && x.id === ev.id);
      if (i < 0) return items;
      const copy = items.slice();
      copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), result: { ok: ev.ok, output: ev.output, ...(ev.clipped ? { eventId: e.id, clipped: ev.clipped } : {}) } };
      return copy;
    }
    case "file_change":
      return [...closeStream(items, role, node), { kind: "files", key: key, role, files: ev.files, ok: ev.ok }];
    case "approval_request":
      return [...closeStream(items, role, node), { kind: "approval", key: key, request: ev.request }];
    case "approval_auto":
      return [...closeStream(items, role, node), { kind: "auto", key: key, request: ev.request, decision: ev.decision, reason: ev.reason, reused: ev.reused }];
    case "approval_resolved":
      return items.map((x) => (x.kind === "approval" && x.request.id === ev.id ? { ...x, decision: ev.decision } : x));
    case "consult_start":
      return [
        ...closeStream(items, role, node),
        {
          kind: "consult",
          key: key,
          consultId: ev.consultId,
          from: ev.from,
          to: ev.to,
          consultKind: ev.kind,
          request: ev.request,
          attachments: ev.attachments ?? [],
          scope: ev.scope,
          reason: ev.reason,
          status: "running",
          children: [],
          at: e.at,
        },
      ];
    case "consult_end":
      return items.map((x) =>
        x.kind === "consult" && x.consultId === ev.consultId ? { ...x, status: ev.status, summary: ev.summary, files: ev.files } : x,
      );
    case "dispatch":
      return [
        ...closeStream(items, role, node),
        { kind: "notice", key, tone: "info", text: `${ev.dualInvestigation ? "중요 오류 · 클로드와 지피티가 각각 조사합니다" : ev.mode === "direct" ? "마스터가 직접 처리합니다" : "마스터가 작업을 나눕니다"} · ${ev.reason}` },
      ];
    case "image_generation": {
      const existingIndex = items.findIndex((x) => x.kind === "image" && x.role === role && x.node === node && x.id === ev.id);
      if (existingIndex >= 0) {
        const existing = items[existingIndex] as Extract<Item, { kind: "image" }>;
        const copy = items.slice();
        copy[existingIndex] = { ...existing, status: ev.status, prompt: ev.prompt ?? existing.prompt, attachment: ev.attachment ?? existing.attachment, error: ev.error };
        return copy;
      }
      return [
        ...closeStream(items, role, node),
        { kind: "image", key: e.id ? key : `live-image-${node}-${role}-${ev.id}`, role, node, id: ev.id, status: ev.status, prompt: ev.prompt, attachment: ev.attachment, error: ev.error },
      ];
    }
    case "ask_user":
      return [...closeStream(items, role, node), { kind: "ask", key: key, id: ev.id, question: ev.question, options: ev.options }];
    case "ask_user_answer":
      return items.map((x) => (x.kind === "ask" && x.id === ev.id ? { ...x, answer: ev.answer } : x));
    case "notice":
      return [...items, { kind: "notice", key: key, tone: "info", text: ev.text }];
    // Shown in the pinned plan panel / goal bar, not as timeline items.
    case "plan_update":
    case "plan_state":
    case "goal_update":
      return items;
    case "error":
      return [...closeStream(items, role, node), { kind: "notice", key: key, tone: ev.kind === "auth" ? "auth" : "error", text: ev.message }];
    case "turn_end": {
      const closed = closeStream(items, role, node);
      if (ev.interrupted) return [...closed, { kind: "notice", key: key, tone: "info", text: "중지됨" }];
      if (!ev.ok && ev.error && !closed.some((x) => x.kind === "notice" && x.text.includes(ev.error!)))
        return [...closed, { kind: "notice", key: key, tone: "error", text: ev.error }];
      return closed;
    }
  }
}

/** Appends a live event, coalescing streaming deltas so the list stays small. */
export function appendEvent(list: TimelineEvent[], e: TimelineEvent): TimelineEvent[] {
  const last = list[list.length - 1];
  const sameStream = (x: TimelineEvent | undefined) => x && x.event.type === "text_delta" && x.node === e.node && x.role === e.role;
  if (e.event.type === "text_delta" && sameStream(last)) {
    const merged = { ...last!, event: { type: "text_delta" as const, text: (last!.event as { text: string }).text + e.event.text } };
    return [...list.slice(0, -1), merged];
  }
  if (e.event.type === "text") {
    // The final text replaces the streamed preview of the same conversation.
    const i = list.findLastIndex((x) => sameStream(x));
    if (i >= 0) return [...list.slice(0, i), ...list.slice(i + 1), e];
  }
  if (e.event.type === "turn_end") {
    // Drop a dangling preview (interrupted stream).
    const i = list.findLastIndex((x) => sameStream(x));
    if (i >= 0) {
      const d = list[i];
      return [...list.slice(0, i), { ...d, event: { type: "text", text: (d.event as { text: string }).text } }, ...list.slice(i + 1), e];
    }
  }
  return [...list, e];
}

/** Normalize only legacy Gemini worker prefixes at the start of a plan step title. */
export function normalizePlanStepTitle(title: string): string {
  return title.replace(/^\[(?:Antigravity|Gemini) (\d+호)\](?=\s|$)/, "[제미나이 $1]");
}

/**
 * Latest plan checklist and its lifecycle state, for the pinned plan panel (desktop and remote). The fold
 * is the shared one the main process uses, so a new instruction or a new /plan never mixes with an older
 * plan, and cancelled/incomplete/failed/stopped plans stay visible with their reason.
 */
export function planOf(events: readonly TimelineEvent[]): PlanView | null {
  return currentPlanView(events);
}

// Folds TimelineEvents into display items for one view of a chat:
//  - unified (default): user + orchestrator, with each consult as a card holding the worker's events
//  - "orch" / "claude" / "gpt": one conversation, flat
//  - "consult:N": one consult
import { isAgentExpression, isWorkerKey } from "../../shared/types";
import type { AgentExpression, PlanStep, AgentEvent, ApprovalDecision, ApprovalRequest, AttachmentRef, ConsultKind, ConsultStatus, FileDiff, NodeId, Role, TimelineEvent } from "../../shared/types";

export type Item =
  | { kind: "user"; key: string; text: string; attachments: AttachmentRef[]; at: number; queued?: boolean }
  | { kind: "message"; key: string; role: Role; node: NodeId; text: string; streaming: boolean; expression: AgentExpression; at: number }
  | { kind: "tool"; key: string; role: Role; id: string; name: string; input: string; diffs?: FileDiff[]; result?: { ok: boolean; output: string } }
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
      summary?: string;
      files?: string[];
      children: Item[];
      at: number;
    }
  | { kind: "ask"; key: string; id: string; question: string; options: string[]; answer?: string }
  | { kind: "notice"; key: string; tone: "error" | "auth" | "info"; text: string };

type View = NodeId | undefined;

function consultOf(node: NodeId): number | null {
  return node.startsWith("consult:") ? Number(node.slice(8)) : null;
}

/** Should this event appear in the view, and where. */
function belongs(e: TimelineEvent, view: View, consultTargets: Map<number, Role>): "top" | "child" | false {
  const ev = e.event;
  const cId = consultOf(e.node);
  if (view === undefined) {
    if (ev.type === "approval_request" || ev.type === "approval_resolved") return "top";
    // A nested consult and its completion belong inside the parent consult card.
    if (cId !== null) return "child";
    return "top";
  }
  if (view === "orch") return e.role === "orch" || e.role === null ? "top" : false;
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

export function buildItems(events: TimelineEvent[], view: View, live: boolean): Item[] {
  let top: Item[] = [];
  const consultTargets = new Map<number, Role>();
  const expressions: ExpressionState = new Map();
  for (const e of events) {
    if (e.event.type === "consult_start") consultTarget(e, consultTargets);
    const where = belongs(e, view, consultTargets);
    if (!where) continue;
    const role = (e.role ?? "orch") as Role;
    const node = e.node;
    const ev = e.event;
    if (ev.type === "expression") {
      expressions.set(expressionKey(node, role), currentExpression(ev.expression));
      continue;
    }
    const expression = ev.type === "text_delta" ? messageExpression(top, node, role, expressions, "speaking") : ev.type === "text" ? messageExpression(top, node, role, expressions, "neutral") : undefined;
    if (where === "child") {
      const id = consultOf(e.node);
      if (id !== null) {
        const next = applyInConsult(top, id, e, expression);
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
  if (!live) {
    // History from a previous run: unanswered prompts can't be answered any more.
    top = closeHistory(top);
  }
  return top;
}

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
    case "expression":
      return items;
    case "user":
      return [...items, { kind: "user", key: key, text: ev.text, attachments: ev.attachments, at: e.at, queued: ev.queued }];
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
        return [...items.slice(0, i), { ...message, text: ev.text, streaming: false }, ...items.slice(i + 1)];
      }
      return [...closeStream(items, role, node), { kind: "message", key: e.id ? key : nextLiveMessageKey(items, role, node), role, node, text: ev.text, streaming: false, expression: expression ?? "neutral", at: e.at }];
    }
    case "tool_call":
      // The orchestrator's consult/ask tools and expression helper are not shown as timeline cards.
      if (ev.name.includes("chatterbox_bridge") || ev.name === "set_expression" || ev.name === "mcp__chatterbox_bridge__set_expression") return closeStream(items, role, node);
      return [...closeStream(items, role, node), { kind: "tool", key: key, role, id: ev.id, name: ev.name, input: ev.input, diffs: ev.diffs }];
    case "tool_result": {
      const i = items.findLastIndex((x) => x.kind === "tool" && x.id === ev.id);
      if (i < 0) return items;
      const copy = items.slice();
      copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), result: { ok: ev.ok, output: ev.output } };
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
          status: "running",
          children: [],
          at: e.at,
        },
      ];
    case "consult_end":
      return items.map((x) =>
        x.kind === "consult" && x.consultId === ev.consultId ? { ...x, status: ev.status, summary: ev.summary, files: ev.files } : x,
      );
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

/** Latest plan checklist and its /plan state, for the pinned plan panel. */
export function planOf(events: TimelineEvent[]): { steps: PlanStep[]; explanation?: string; state: "proposed" | "running" | "done" | "cancelled" | "live" } | null {
  let steps: PlanStep[] | null = null;
  let explanation: string | undefined;
  let state: "proposed" | "running" | "done" | "cancelled" | "live" = "live";
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "plan_update" && e.role === "orch") {
      steps = ev.steps;
      explanation = ev.explanation;
    } else if (ev.type === "plan_state") state = ev.state;
    else if (ev.type === "user" && !ev.queued && !ev.text.startsWith("/plan") && ev.text !== "계획 실행" && state !== "running") {
      // A new ordinary instruction starts fresh (its own checklist, if any, will follow).
      steps = null;
      state = "live";
    }
  }
  return steps ? { steps, explanation, state } : null;
}

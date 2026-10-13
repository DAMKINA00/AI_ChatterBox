// Folds TimelineEvents into display items for one view of a chat:
//  - unified (default): user + orchestrator, with each consult as a card holding the worker's events
//  - "orch" / "claude" / "gpt": one conversation, flat
//  - "consult:N": one consult
import type { AgentEvent, ApprovalDecision, ApprovalRequest, AttachmentRef, ConsultKind, ConsultStatus, FileDiff, NodeId, Role, TimelineEvent } from "../../shared/types";

export type Item =
  | { kind: "user"; key: string; text: string; attachments: AttachmentRef[]; at: number; queued?: boolean }
  | { kind: "message"; key: string; role: Role; text: string; streaming: boolean; at: number }
  | { kind: "tool"; key: string; role: Role; id: string; name: string; input: string; diffs?: FileDiff[]; result?: { ok: boolean; output: string } }
  | { kind: "files"; key: string; role: Role; files: FileDiff[]; ok: boolean }
  | { kind: "approval"; key: string; request: ApprovalRequest; decision?: ApprovalDecision | "auto" | "expired" }
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
function belongs(e: TimelineEvent, view: View): "top" | "child" | false {
  const ev = e.event;
  const cId = consultOf(e.node);
  if (view === undefined) {
    if (ev.type === "approval_request" || ev.type === "approval_resolved") return "top";
    if (cId !== null && ev.type !== "consult_start" && ev.type !== "consult_end") return "child";
    return "top";
  }
  if (view === "orch") return e.role === "orch" || e.role === null ? "top" : false;
  if (view === "claude" || view === "gpt") {
    if ((ev.type === "consult_start" || ev.type === "consult_end") && consultTarget(e) === view) return "top";
    return e.role === view ? "top" : false;
  }
  const want = consultOf(view);
  if ((ev.type === "consult_start" || ev.type === "consult_end") && ev.consultId === want) return "top";
  return cId === want ? "top" : false;
}

const consultTargets = new Map<number, Role>();
function consultTarget(e: TimelineEvent): Role | undefined {
  const ev = e.event;
  if (ev.type === "consult_start") {
    consultTargets.set(ev.consultId, ev.to);
    return ev.to;
  }
  if (ev.type === "consult_end") return consultTargets.get(ev.consultId);
  return undefined;
}

export function buildItems(events: TimelineEvent[], view: View, live: boolean): Item[] {
  let top: Item[] = [];
  for (const e of events) {
    if (e.event.type === "consult_start") consultTarget(e);
    const where = belongs(e, view);
    if (!where) continue;
    if (where === "child") {
      const id = consultOf(e.node);
      const i = top.findLastIndex((x) => x.kind === "consult" && x.consultId === id);
      if (i >= 0) {
        const c = top[i] as Extract<Item, { kind: "consult" }>;
        top = [...top.slice(0, i), { ...c, children: apply(c.children, e) }, ...top.slice(i + 1)];
        continue;
      }
    }
    top = apply(top, e);
  }
  if (!live) {
    // History from a previous run: unanswered prompts can't be answered any more.
    top = top.map((x) =>
      x.kind === "approval" && !x.decision ? { ...x, decision: "expired" as const } : x.kind === "message" && x.streaming ? { ...x, streaming: false } : x,
    );
  }
  return top;
}




function closeStream(items: Item[], role: Role | null): Item[] {
  const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role);
  if (i < 0) return items;
  const copy = items.slice();
  copy[i] = { ...(copy[i] as Extract<Item, { kind: "message" }>), streaming: false };
  return copy;
}

export function apply(items: Item[], e: TimelineEvent): Item[] {
  const ev: AgentEvent = e.event;
  const role = (e.role ?? "orch") as Role;
  // Stable keys keep React state (open cards) across rebuilds; live deltas have no id yet.
  const key = e.id ? `e${e.id}` : `live-${e.node}-${role}`;
  switch (ev.type) {
    case "user":
      return [...items, { kind: "user", key: key, text: ev.text, attachments: ev.attachments, at: e.at, queued: ev.queued }];
    case "text_delta": {
      const i = items.findLastIndex((x) => x.kind === "message" && x.streaming && x.role === role);
      if (i >= 0 && i === items.length - 1) {
        const m = items[i] as Extract<Item, { kind: "message" }>;
        return [...items.slice(0, i), { ...m, text: m.text + ev.text }];
      }
      return [...closeStream(items, role), { kind: "message", key: key, role, text: ev.text, streaming: true, at: e.at }];
    }
    case "text": {
      const last = items[items.length - 1];
      if (last?.kind === "message" && last.streaming && last.role === role)
        return [...items.slice(0, -1), { ...last, text: ev.text, streaming: false }];
      return [...closeStream(items, role), { kind: "message", key: key, role, text: ev.text, streaming: false, at: e.at }];
    }
    case "tool_call":
      // The orchestrator's consult/ask tools are shown as consult and question cards instead.
      if (ev.name.includes("chatterbox_bridge")) return items;
      return [...closeStream(items, role), { kind: "tool", key: key, role, id: ev.id, name: ev.name, input: ev.input, diffs: ev.diffs }];
    case "tool_result": {
      const i = items.findLastIndex((x) => x.kind === "tool" && x.id === ev.id);
      if (i < 0) return items;
      const copy = items.slice();
      copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), result: { ok: ev.ok, output: ev.output } };
      return copy;
    }
    case "file_change":
      return [...closeStream(items, role), { kind: "files", key: key, role, files: ev.files, ok: ev.ok }];
    case "approval_request":
      return [...closeStream(items, role), { kind: "approval", key: key, request: ev.request }];
    case "approval_resolved":
      return items.map((x) => (x.kind === "approval" && x.request.id === ev.id ? { ...x, decision: ev.decision } : x));
    case "consult_start":
      return [
        ...closeStream(items, role),
        {
          kind: "consult",
          key: key,
          consultId: ev.consultId,
          from: ev.from,
          to: ev.to,
          consultKind: ev.kind,
          request: ev.request,
          attachments: ev.attachments ?? [],
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
      return [...closeStream(items, role), { kind: "ask", key: key, id: ev.id, question: ev.question, options: ev.options }];
    case "ask_user_answer":
      return items.map((x) => (x.kind === "ask" && x.id === ev.id ? { ...x, answer: ev.answer } : x));
    case "notice":
      return [...items, { kind: "notice", key: key, tone: "info", text: ev.text }];
    case "error":
      return [...closeStream(items, role), { kind: "notice", key: key, tone: ev.kind === "auth" ? "auth" : "error", text: ev.message }];
    case "turn_end": {
      const closed = closeStream(items, role);
      if (ev.interrupted) return [...closed, { kind: "notice", key: key, tone: "info", text: "중지됨" }];
      if (!ev.ok && ev.error && !closed.some((x) => x.kind === "notice" && x.text.includes(ev.error!)))
        return [...closed, { kind: "notice", key: key, tone: "error", text: ev.error }];
      return closed;
    }
  }
}

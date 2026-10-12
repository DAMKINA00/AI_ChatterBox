// Folds the normalized AgentEvent stream into display items for the chat panel.
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from "../../shared/types";

export type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "tool"; key: string; id: string; name: string; input: string; result?: { ok: boolean; output: string } }
  | { kind: "file"; key: string; summary: string; ok: boolean }
  | { kind: "approval"; key: string; request: ApprovalRequest; decision?: ApprovalDecision; expired?: boolean }
  | { kind: "notice"; key: string; tone: "error" | "auth" | "info"; text: string };

let seq = 0;
const k = () => `i${++seq}`;

export function apply(items: Item[], ev: AgentEvent): Item[] {
  const last = items[items.length - 1];
  switch (ev.type) {
    case "user":
      return [...items, { kind: "user", key: k(), text: ev.text }];
    case "text_delta":
      if (last?.kind === "assistant" && last.streaming)
        return [...items.slice(0, -1), { ...last, text: last.text + ev.text }];
      return [...items, { kind: "assistant", key: k(), text: ev.text, streaming: true }];
    case "text":
      // The final text replaces whatever was streamed for it.
      if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, text: ev.text, streaming: false }];
      return [...items, { kind: "assistant", key: k(), text: ev.text, streaming: false }];
    case "tool_call":
      return [...closeStream(items), { kind: "tool", key: k(), id: ev.id, name: ev.name, input: ev.input }];
    case "tool_result": {
      const i = items.findLastIndex((x) => x.kind === "tool" && x.id === ev.id);
      if (i < 0) return items;
      const copy = items.slice();
      copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), result: { ok: ev.ok, output: ev.output } };
      return copy;
    }
    case "file_change":
      return [...closeStream(items), { kind: "file", key: k(), summary: ev.summary, ok: ev.ok }];
    case "approval_request":
      return [...closeStream(items), { kind: "approval", key: k(), request: ev.request }];
    case "approval_resolved":
      return items.map((x) => (x.kind === "approval" && x.request.id === ev.id ? { ...x, decision: ev.decision } : x));
    case "error":
      return [...closeStream(items), { kind: "notice", key: k(), tone: ev.kind === "auth" ? "auth" : "error", text: ev.message }];
    case "turn_end": {
      const closed = closeStream(items);
      if (ev.interrupted) return [...closed, { kind: "notice", key: k(), tone: "info", text: "중지됨" }];
      if (!ev.ok && ev.error && !closed.some((x) => x.kind === "notice" && x.text.includes(ev.error!)))
        return [...closed, { kind: "notice", key: k(), tone: "error", text: ev.error }];
      return closed;
    }
  }
}

function closeStream(items: Item[]): Item[] {
  const last = items[items.length - 1];
  if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }];
  return items;
}

/** History loaded from disk: approvals that were never answered can't be answered any more. */
export function fromHistory(events: AgentEvent[], live: boolean): Item[] {
  const items = events.reduce(apply, [] as Item[]);
  return live ? items : items.map((x) => (x.kind === "approval" && !x.decision ? { ...x, expired: true } : x));
}

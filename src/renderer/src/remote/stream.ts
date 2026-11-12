// Live stream ↔ snapshot reconciliation for the remote web page. Every SSE message carries a sequence
// number (its SSE id); a snapshot carries the number reached before it was read. Messages that arrive
// while the snapshot loads are buffered and replayed on top of it.
import type { Chat, ChatAgent, Consult, TimelineEvent } from "../../../shared/types";
import { prependPage, type EventPage } from "../../../shared/event-page";
import { appendEvent } from "../timeline";

/**
 * Open chat: the loaded history pages (newest first load, older ones on demand) and its team.
 * context/start/hasMore follow shared/event-page.ts; context only feeds pinned state (plan, worker state).
 */
export interface Detail { events: TimelineEvent[]; agents: ChatAgent[]; consults: Consult[]; context?: TimelineEvent[]; start?: number; hasMore?: boolean }
export interface StreamMessage { seq: number; channel: string; args: unknown[] }

/** Apply one stream message for the open chat. */
export function applyMessage(detail: Detail, chatId: number, { channel, args }: StreamMessage): Detail {
  if (channel === "chat:event") {
    const ev = args[0] as TimelineEvent;
    if (ev.chatId !== chatId || (ev.id && detail.events.some(x => x.id === ev.id))) return detail;
    return { ...detail, events: appendEvent(detail.events, ev) };
  }
  if (channel === "agents:updated") return args[0] === chatId ? { ...detail, agents: args[1] as ChatAgent[] } : detail;
  if (channel === "consult:updated") {
    const consult = args[0] as Consult;
    if (consult.chatId !== chatId) return detail;
    const consults = detail.consults.some(c => c.id === consult.id) ? detail.consults.map(c => (c.id === consult.id ? consult : c)) : [...detail.consults, consult];
    return { ...detail, consults };
  }
  return detail;
}

const closesStream = (ev: TimelineEvent) => ev.event.type === "text" || ev.event.type === "turn_end";

/**
 * Snapshot plus the messages buffered while it loaded.
 * - Persisted events (with id) at or before the snapshot's seq, or already in it, are skipped.
 * - Streaming previews (text_delta, never persisted) are always replayed, so the start of a reply that
 *   is still being written is not lost. When the final text / turn end of that stream is skipped because
 *   the snapshot already has it, the preview is removed so no stale copy remains.
 * - Worker/consult updates newer than the snapshot are replayed in order.
 */
export function mergeSnapshot(snapshot: Detail & { seq: number }, buffered: StreamMessage[], chatId: number): Detail {
  let detail: Detail = { events: snapshot.events, agents: snapshot.agents, consults: snapshot.consults, context: snapshot.context ?? [], start: snapshot.start ?? 0, hasMore: !!snapshot.hasMore };
  for (const message of buffered) {
    if (message.channel === "chat:event") {
      const ev = message.args[0] as TimelineEvent;
      if (ev.chatId !== chatId) continue;
      const known = !!ev.id && (message.seq <= snapshot.seq || detail.events.some(x => x.id === ev.id));
      if (known) {
        if (closesStream(ev)) {
          const i = detail.events.findLastIndex(x => x.event.type === "text_delta" && x.node === ev.node && x.role === ev.role);
          if (i >= 0) detail = { ...detail, events: [...detail.events.slice(0, i), ...detail.events.slice(i + 1)] };
        }
        continue;
      }
    } else if (message.seq <= snapshot.seq) continue;
    detail = applyMessage(detail, chatId, message);
  }
  return detail;
}

/**
 * Chat objects come from both snapshots and chat:updated messages. `versions` remembers the seq each
 * held chat came from, so a snapshot that was read earlier never undoes a newer update (e.g. an idle
 * snapshot arriving after the chat moved to "approval"). `partial` = the snapshot holds only some chats.
 */
export function mergeChats(current: Chat[], versions: Map<number, number>, snapshot: Chat[], seq: number, partial = false): Chat[] {
  const newer = (id: number) => (versions.get(id) ?? -1) > seq;
  const merged = snapshot.map(chat => {
    if (newer(chat.id)) return current.find(c => c.id === chat.id) ?? chat;
    versions.set(chat.id, seq);
    return chat;
  });
  const extra = current.filter(c => !snapshot.some(s => s.id === c.id) && (partial || newer(c.id)));
  return partial ? current.map(c => merged.find(m => m.id === c.id) ?? c).concat(merged.filter(m => !current.some(c => c.id === m.id))) : [...extra, ...merged];
}

/** A chat:updated message (always the newest state of that chat at its seq). */
export function applyChatUpdate(current: Chat[], versions: Map<number, number>, chat: Chat, seq: number): Chat[] {
  if ((versions.get(chat.id) ?? -1) > seq) return current;
  versions.set(chat.id, seq);
  return current.some(c => c.id === chat.id) ? current.map(c => (c.id === chat.id ? chat : c)) : [chat, ...current];
}

/** An older history page (immutable events, so no stream sequence is involved) put in front of the loaded ones. */
export function prependOlder(detail: Detail, page: EventPage): Detail {
  if (!detail.hasMore || detail.start === undefined) return detail;
  const merged = prependPage({ events: detail.events, context: detail.context ?? [], start: detail.start, hasMore: true }, page);
  return { ...detail, events: merged.events, context: merged.context, start: merged.start, hasMore: merged.hasMore };
}

/** Context plus loaded events, for state that depends on the whole history. */
export const detailStateEvents = (detail: Detail | undefined): TimelineEvent[] =>
  !detail ? [] : detail.context?.length ? [...detail.context, ...detail.events] : detail.events;

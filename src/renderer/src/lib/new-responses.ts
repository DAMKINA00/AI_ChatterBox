import type { ChatStatus } from "../../../shared/types";
import type { Item } from "../timeline";

/** Replies as last seen at the bottom: reply identity -> text length. */
export type SeenReplies = ReadonlyMap<string, number>;

type Reply = Extract<Item, { kind: "message" }>;

/**
 * Every reply on screen, including workers' replies inside consult cards, with an identity that
 * survives the live preview being replaced by the saved message (the key changes from live-… to e…,
 * the position in that conversation does not). The same saved event received twice counts once.
 */
function replies(items: readonly Item[]): Map<string, Reply> {
  const out = new Map<string, Reply>();
  const keys = new Set<string>();
  const ordinal = new Map<string, number>();
  const walk = (list: readonly Item[]) => {
    for (const item of list) {
      if (item.kind === "consult") walk(item.children);
      if (item.kind !== "message" || keys.has(item.key)) continue;
      keys.add(item.key);
      const stream = `${item.node}|${item.role}`;
      const n = ordinal.get(stream) ?? 0;
      ordinal.set(stream, n + 1);
      out.set(`${stream}|${n}`, item);
    }
  };
  walk(items);
  return out;
}

export function seenReplies(items: readonly Item[]): SeenReplies {
  return new Map([...replies(items)].map(([id, reply]) => [id, reply.text.length]));
}

/**
 * What arrived since the reader left the bottom: replies not seen then (once each, however many
 * tokens they stream), and whether a reply already seen has kept growing.
 */
export function unseenReplies(items: readonly Item[], seen: SeenReplies): { count: number; growing: boolean } {
  let count = 0;
  let growing = false;
  for (const [id, reply] of replies(items)) {
    const length = seen.get(id);
    if (length === undefined) count++;
    else if (reply.text.length > length) growing = true;
  }
  return { count, growing };
}

export function unseenLabel({ count, growing }: { count: number; growing: boolean }): string | null {
  return count ? `새 응답 ${count}` : growing ? "새 응답" : null;
}

/** How the master's last turn ended, from its turn_end event. */
export type TurnEnd = { ok: boolean; interrupted?: boolean } | undefined;

/**
 * A short line for screen readers when the chat on screen changes state. Only a change seen while
 * the chat stays open is announced: the first status after opening (or a replayed one) says nothing.
 * "idle" after work is not a success: a stopped run also ends there, so the turn_end decides.
 */
export function statusAnnouncement(previous: ChatStatus | undefined, next: ChatStatus, lastTurn?: TurnEnd): string | null {
  if (previous === undefined || previous === next) return null;
  const wasRunning = previous === "working" || previous === "approval" || previous === "pausing";
  switch (next) {
    case "approval": return "승인 대기 중인 요청이 있습니다.";
    case "done": return wasRunning ? "작업이 완료되었습니다." : null;
    case "idle": return wasRunning ? (lastTurn?.interrupted ? "작업이 중단되었습니다." : "작업이 종료되었습니다.") : null;
    case "error": return "작업이 오류로 끝났습니다.";
    case "interrupted": return "작업이 중단되었습니다.";
    case "paused": return "작업이 일시 정지되었습니다.";
    default: return null;
  }
}

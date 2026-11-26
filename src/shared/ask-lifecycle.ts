import type { TimelineEvent } from "./types";

export const EXPIRED_ASK_ANSWER = "(응답 대기 종료: 이미 종료되었거나 만료된 질문입니다.)";

/** A question belongs to its master turn; plan approval alone may outlive a successful turn. */
export function closesAsk(event: TimelineEvent, planConfirm = false): boolean {
  const e = event.event;
  if (e.type === "user") return !e.queued || planConfirm;
  if (e.type === "turn_end" && event.role === "orch" && event.node === "orch")
    return !planConfirm || !e.ok || !!e.interrupted;
  if (e.type === "plan_state" && planConfirm) return e.state !== "proposed";
  return e.type === "ask_user" && !!e.planConfirm && planConfirm;
}

/** Also understands legacy histories that have no explicit answer/expiry event. */
export function pendingAsks(events: readonly TimelineEvent[]): TimelineEvent[] {
  const pending = new Map<string, TimelineEvent>();
  for (const event of events) {
    for (const [id, ask] of pending) {
      if (ask.event.type === "ask_user" && closesAsk(event, ask.event.planConfirm)) pending.delete(id);
    }
    const e = event.event;
    if (e.type === "ask_user") pending.set(e.id, event);
    else if (e.type === "ask_user_answer") pending.delete(e.id);
  }
  return [...pending.values()];
}

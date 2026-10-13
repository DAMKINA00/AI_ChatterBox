import type { Chat } from "../shared/types";

export const APPROVAL_REMINDER_MS = 60_000;
export type ChatNotice = "approval" | "reminder" | "done" | "error";

/** One initial notice and one reminder per continuous approval wait. */
export class ChatNotifications {
  private latest = new Map<number, Chat>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private notify: (chat: Chat, notice: ChatNotice) => void, initial: Chat[] = []) {
    for (const chat of initial) this.latest.set(chat.id, chat);
  }

  chatChanged(chat: Chat) {
    if (this.disposed) return;
    const previous = this.latest.get(chat.id)?.status;
    this.latest.set(chat.id, chat);
    if (previous === chat.status) return;
    this.cancel(chat.id);
    if (chat.status === "approval") {
      this.notify(chat, "approval");
      this.timers.set(chat.id, setTimeout(() => {
        this.timers.delete(chat.id);
        const current = this.latest.get(chat.id);
        if (current?.status === "approval") this.notify(current, "reminder");
      }, APPROVAL_REMINDER_MS));
    } else if (previous === "working" || previous === "approval") {
      if (chat.status === "done") {
        // Queued instructions and /goal continuation briefly pass through done.
        this.timers.set(chat.id, setTimeout(() => {
          this.timers.delete(chat.id);
          const current = this.latest.get(chat.id);
          if (current?.status === "done" && (!current.goal || current.goal.status === "complete")) this.notify(current, "done");
        }, 500));
      } else if (chat.status === "error") this.notify(chat, "error");
    }
  }

  private cancel(chatId: number) {
    clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
  }

  destroy() {
    this.disposed = true;
    for (const id of this.timers.keys()) this.cancel(id);
    this.latest.clear();
  }
}

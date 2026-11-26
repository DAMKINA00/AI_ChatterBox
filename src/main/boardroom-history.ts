import { MAX_MEETING_HISTORY, type MeetingMessage, type MeetingSnapshot } from "../shared/character-meeting";
import { isMonitorCharacter, MAX_CHARACTER_ANSWER } from "../shared/usage-companion";

type History = Pick<MeetingSnapshot, "seq" | "status" | "messages">;
type Settings = { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void };
const KEY = "boardroomHistory";

export class BoardroomHistory {
  constructor(private readonly store: Settings) {}

  load(): History {
    try {
      const saved = JSON.parse(this.store.getSetting(KEY) ?? "null") as Partial<History> | null;
      if (saved && Array.isArray(saved.messages) && Number.isSafeInteger(saved.seq) && saved.seq! >= 0) {
        const messages = saved.messages.slice(-MAX_MEETING_HISTORY).filter((message: MeetingMessage) =>
          message && typeof message.id === "string" && message.id.length <= 64 && Number.isSafeInteger(message.at) &&
          (message.sender === "user" || message.sender === "system" || isMonitorCharacter(message.sender)) &&
          typeof message.text === "string" && message.text.length <= MAX_CHARACTER_ANSWER,
        );
        return { seq: saved.seq!, status: typeof saved.status === "string" ? saved.status.slice(0, 300) : "", messages };
      }
    } catch { /* A damaged local transcript must not stop the room from opening. */ }
    return { seq: 0, status: "", messages: [] };
  }

  save(history: History) {
    this.store.setSetting(KEY, JSON.stringify(history));
  }
}

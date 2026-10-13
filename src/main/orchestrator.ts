// Collaboration engine. V1 stage: the orchestrator conversation only (consults come in V2).
import type { ChatManager } from "./chats";

export class Orchestrator {
  constructor(private chats: ChatManager) {}

  async stop(chatId: number) {
    await this.chats.stop(chatId);
  }

  answerAsk(_chatId: number, _askId: string, _answer: string) {
    // ask_user arrives in V2
  }
}

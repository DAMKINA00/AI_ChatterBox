import { create } from "zustand";
import type { AttachmentRef } from "../../../shared/types";
import { api, errorMessage } from "./utils";

type OutgoingMessage = { id: string; text: string; attachments: AttachmentRef[]; at: number; failure?: string };
const empty: OutgoingMessage[] = [];
const outgoing = create<Record<number, OutgoingMessage[]>>(() => ({}));
export const useOutgoing = (chatId: number) => outgoing(state => state[chatId] ?? empty);
let sequence = 0;
const session = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join("-");

export function forgetOutgoing(chatId: number, ids: ReadonlySet<string>) {
  outgoing.setState(state => {
    const current = state[chatId] ?? empty;
    const next = current.filter(message => !ids.has(message.id));
    return next.length === current.length ? state : { [chatId]: next };
  });
}

export async function sendOutgoing(chatId: number, text: string, attachments: AttachmentRef[], delivery: "now" | "next") {
  const id = `${session}-${++sequence}`;
  outgoing.setState(state => ({ [chatId]: [...(state[chatId] ?? empty), { id, text, attachments, at: Date.now() }] }));
  try {
    const accepted = await api.send(chatId, text, attachments.map(a => a.id), delivery, id);
    if (accepted == null) forgetOutgoing(chatId, new Set([id]));
  } catch (error) {
    outgoing.setState(state => ({ [chatId]: (state[chatId] ?? empty).map(message =>
      message.id === id ? { ...message, failure: errorMessage(error) } : message) }));
    throw error;
  }
}

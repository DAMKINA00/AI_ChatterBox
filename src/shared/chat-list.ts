import type { Chat } from "./types";

/** Drafts stay addressable by the composer but are not conversations in the sidebar yet. */
export function listedChats(chats: Chat[]): Chat[] {
  return chats.filter(c => !c.draft).sort((a, b) =>
    (b.sidebarOrder ?? b.lastActiveAt) - (a.sidebarOrder ?? a.lastActiveAt) || b.id - a.id);
}

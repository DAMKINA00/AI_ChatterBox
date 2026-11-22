import type { Chat, ChatDeleteTarget } from "./types";

export function matchesDeleteTarget(chat: ChatDeleteTarget | undefined, target: ChatDeleteTarget): boolean {
  return chat?.id === target.id && chat.title === target.title && chat.createdAt === target.createdAt && chat.projectId === target.projectId;
}

/** Drafts stay addressable by the composer but are not conversations in the sidebar yet. */
export function listedChats(chats: Chat[]): Chat[] {
  return chats.filter(c => !c.draft).sort((a, b) =>
    (b.sidebarOrder ?? b.lastActiveAt) - (a.sidebarOrder ?? a.lastActiveAt) || b.id - a.id);
}

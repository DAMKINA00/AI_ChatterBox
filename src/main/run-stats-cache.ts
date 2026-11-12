// Run statistics are aggregated in the core: a long chat's events (tens of thousands) never cross the
// RPC, only the rows. Recently asked chats keep their minimal events, so a live dialog that refreshes
// reads only what was added since.
import type { ChatAgent, Consult, TimelineEvent } from "../shared/types";
import { runStatsRows } from "../renderer/src/lib/run-stats-view";

export interface RunStatsSource {
  statsEventsAfter(chatId: number, afterId?: number): TimelineEvent[];
  listAgents(chatId: number): ChatAgent[];
  listConsults(chatId: number): Consult[];
}

export class RunStatsCache {
  private entries = new Map<number, { lastId: number; events: TimelineEvent[] }>();
  constructor(private source: RunStatsSource, private limit = 3) {}

  rows(chatId: number, now?: number): ReturnType<typeof runStatsRows> {
    const entry = this.entries.get(chatId) ?? { lastId: 0, events: [] };
    const added = this.source.statsEventsAfter(chatId, entry.lastId);
    if (added.length) {
      entry.events = entry.events.concat(added);
      entry.lastId = added[added.length - 1].id;
    }
    // Most recently used last; the oldest chat's events are dropped beyond the limit.
    this.entries.delete(chatId);
    this.entries.set(chatId, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return runStatsRows(entry.events, this.source.listAgents(chatId), this.source.listConsults(chatId), now);
  }

  forget(chatId: number) { this.entries.delete(chatId); }
}

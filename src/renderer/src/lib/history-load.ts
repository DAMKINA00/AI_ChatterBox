// Team state that changed while a chat's first page was loading. The list answers were read before
// (or while) those updates were sent, so the updates win over them.
import type { ChatAgent, Consult } from "../../../shared/types";

export interface TeamUpdates {
  /** The latest worker list sent while loading (agents:updated carries the whole list). */
  agents?: ChatAgent[];
  /** Consults updated while loading, by id (consult:updated carries one consult). */
  consults: Map<number, Consult>;
}

export const emptyTeamUpdates = (): TeamUpdates => ({ consults: new Map() });

export function mergeTeamUpdates(fetchedAgents: ChatAgent[], fetchedConsults: Consult[], updates: TeamUpdates | undefined): { agents: ChatAgent[]; consults: Consult[] } {
  if (!updates) return { agents: fetchedAgents, consults: fetchedConsults };
  const consults = fetchedConsults.map(c => updates.consults.get(c.id) ?? c);
  for (const c of updates.consults.values()) if (!fetchedConsults.some(x => x.id === c.id)) consults.push(c);
  return { agents: updates.agents ?? fetchedAgents, consults };
}

/**
 * Older unanswered approvals as last loaded, minus those answered since (approval_resolved events seen in
 * the window); the total drops by the ones removed. A refresh from the core gives the exact total.
 */
export function withoutAnswered<T extends { id: string }>(list: { items: T[]; total: number }, answered: ReadonlySet<string>): { items: T[]; total: number } {
  if (!answered.size) return list;
  const items = list.items.filter(a => !answered.has(a.id));
  return items.length === list.items.length ? list : { items, total: Math.max(0, list.total - (list.items.length - items.length)) };
}

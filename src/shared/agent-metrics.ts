import type { AgentMetrics, Role, TimelineEvent } from "./types";

export interface AgentMetricsSummary {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  elapsedMs: number;
  outputTokensPerSecond: number | null;
  model?: string;
  approximate: boolean;
}

/** Fold per-turn snapshots for one role; resume totals are baselines, not usage. */
export function summarizeAgentMetrics(events: readonly TimelineEvent[], role: Role): AgentMetricsSummary | null {
  const turns = new Map<string, AgentMetrics>();
  let latest: AgentMetrics | undefined;
  for (const event of events) {
    if (event.role !== role || event.event.type !== "agent_usage") continue;
    latest = event.event.metrics;
    turns.set(latest.turnId, latest);
  }
  if (!latest) return null;

  const snapshots = [...turns.values()];
  const elapsedMs = snapshots.reduce((sum, metrics) => sum + metrics.elapsedMs, 0);
  return {
    turnCount: snapshots.length,
    inputTokens: snapshots.reduce((sum, metrics) => sum + metrics.inputTokens, 0),
    outputTokens: snapshots.reduce((sum, metrics) => sum + metrics.outputTokens, 0),
    cachedInputTokens: snapshots.reduce((sum, metrics) => sum + metrics.cachedInputTokens, 0),
    cacheWriteInputTokens: snapshots.reduce((sum, metrics) => sum + metrics.cacheWriteInputTokens, 0),
    elapsedMs,
    outputTokensPerSecond: latest.elapsedMs > 0 ? latest.outputTokens / (latest.elapsedMs / 1000) : null,
    model: latest.model,
    approximate: snapshots.some((metrics) => metrics.approximate === true),
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMetrics, TimelineEvent } from "./types";
import { summarizeAgentMetrics } from "./agent-metrics.ts";

function usage(role: "orch" | `w${number}`, metrics: AgentMetrics, id: number): TimelineEvent {
  return { id, chatId: 1, node: role, role, at: id, event: { type: "agent_usage", metrics } };
}

function metrics(turnId: string, inputTokens: number, outputTokens: number, elapsedMs: number, extra: Partial<AgentMetrics> = {}): AgentMetrics {
  return { turnId, inputTokens, outputTokens, elapsedMs, cachedInputTokens: 0, cacheWriteInputTokens: 0, ...extra };
}

test("usage snapshots replace their turn on replay and aggregate without resume totals", () => {
  const events = [
    usage("w1", metrics("turn-a", 10, 4, 2_000, { total: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 50, cacheWriteInputTokens: 25 } }), 1),
    usage("w1", metrics("turn-b", 20, 6, 3_000, { approximate: true }), 2),
    usage("w1", metrics("turn-a", 12, 5, 2_500), 3),
  ];

  assert.deepEqual(summarizeAgentMetrics(events, "w1"), {
    turnCount: 2,
    inputTokens: 32,
    outputTokens: 11,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    elapsedMs: 5_500,
    outputTokensPerSecond: 2,
    model: undefined,
    approximate: true,
  });
});

test("a role with no usage history has no zero-valued summary", () => {
  assert.equal(summarizeAgentMetrics([], "orch"), null);
  assert.equal(summarizeAgentMetrics([usage("w1", metrics("one", 3, 2, 1000), 1)], "orch"), null);
});

test("the same turn id stays isolated between roles and the latest snapshot sets speed", () => {
  const events = [
    usage("w1", metrics("shared-turn", 20, 4, 1_000), 1),
    usage("orch", metrics("shared-turn", 100, 10, 10_000), 2),
    usage("w1", metrics("shared-turn", 30, 9, 3_000), 3),
  ];

  assert.deepEqual(
    [summarizeAgentMetrics(events, "w1")?.inputTokens, summarizeAgentMetrics(events, "w1")?.outputTokensPerSecond],
    [30, 3],
  );
  assert.deepEqual(
    [summarizeAgentMetrics(events, "orch")?.inputTokens, summarizeAgentMetrics(events, "orch")?.outputTokensPerSecond],
    [100, 1],
  );
});

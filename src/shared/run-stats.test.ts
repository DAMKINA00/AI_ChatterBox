import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, NodeId, Role, TimelineEvent } from "./types";
import { summarizeRunStats } from "./run-stats.ts";

let nextId = 1;
function withId(id: number, node: NodeId, role: Role | null, at: number, payload: AgentEvent): TimelineEvent {
  return { id, chatId: 1, node, role, at, event: payload };
}
function event(node: NodeId, role: Role | null, at: number, payload: AgentEvent): TimelineEvent {
  return withId(nextId++, node, role, at, payload);
}

function call(id: string): AgentEvent {
  return { type: "tool_call", id, name: "Read", input: "{}" };
}
function result(id: string, ok = true): AgentEvent {
  return { type: "tool_result", id, ok, output: "" };
}
function asked(id: string, role: Role = "w1"): AgentEvent {
  return { type: "approval_request", request: { id, role, title: "Write", detail: "a.txt", risk: "low" } };
}
function decided(id: string): AgentEvent {
  return { type: "approval_resolved", id, decision: "once" };
}
function autoApproved(id: string): AgentEvent {
  return { type: "approval_auto", request: { id, role: "w1", title: "Write", detail: "a.txt", risk: "low" }, decision: "allow", reason: "설정" };
}
function note(text: string): AgentEvent {
  return { type: "notice", text };
}
function turnEnd(ok: boolean, interrupted?: boolean): AgentEvent {
  return interrupted ? { type: "turn_end", ok, interrupted } : { type: "turn_end", ok };
}
function usage(turnId: string, elapsedMs: number): AgentEvent {
  return {
    type: "agent_usage",
    metrics: { turnId, elapsedMs, inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
  };
}

test("an empty history reports zeros, not a successful run", () => {
  assert.deepEqual(summarizeRunStats([]), {
    elapsedMs: 0,
    toolMs: 0,
    approvalMs: 0,
    pendingTools: 0,
    pendingApprovals: 0,
    failedTools: 0,
    failedTurns: 0,
    eventCount: 0,
  });
});

test("a call with no result stays pending and still occupies the window", () => {
  const stats = summarizeRunStats([event("w1", "w1", 100, call("t1")), event("w1", "w1", 400, note("still working"))]);
  assert.equal(stats.elapsedMs, 300);
  assert.equal(stats.toolMs, 300);
  assert.equal(stats.pendingTools, 1);
  assert.equal(stats.pendingApprovals, 0);
  assert.equal(stats.eventCount, 2);
});

test("completed and failed tools are measured separately from pending ones", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, call("ok")),
    event("w1", "w1", 250, result("ok")),
    event("w1", "w1", 300, call("bad")),
    event("w1", "w1", 500, result("bad", false)),
    event("w1", "w1", 600, note("done")),
  ]);
  assert.equal(stats.toolMs, 350);
  assert.equal(stats.failedTools, 1);
  assert.equal(stats.pendingTools, 0);
  assert.equal(stats.elapsedMs, 500);
});

test("overlapping tool runs count once instead of summing", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, call("a")),
    event("w1", "w1", 150, call("b")),
    event("w1", "w1", 300, result("a")),
    event("w1", "w1", 400, result("b")),
  ]);
  // a = 100..300 (200), b = 150..400 (250), union = 100..400.
  assert.equal(stats.toolMs, 300);
  assert.equal(stats.pendingTools, 0);
});

test("approval waits and tool runs are separate totals that may overlap", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, asked("ap1")),
    event("w1", "w1", 200, call("t1")),
    event("w1", "w1", 300, result("t1")),
    event("w1", "w1", 500, decided("ap1")),
  ]);
  assert.equal(stats.elapsedMs, 400);
  assert.equal(stats.approvalMs, 400);
  assert.equal(stats.toolMs, 100);
  // The categories overlap the same elapsed span; they are not a partition of it.
  assert.ok(stats.toolMs + stats.approvalMs > stats.elapsedMs);
});

test("an approval answered by the app opens no wait interval", () => {
  const stats = summarizeRunStats([event("w1", "w1", 100, autoApproved("ap1")), event("w1", "w1", 200, note("ran"))]);
  assert.equal(stats.approvalMs, 0);
  assert.equal(stats.pendingApprovals, 0);
  assert.equal(stats.elapsedMs, 100);
});

test("an approval stays open across a turn end and is not counted as pending once decided", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, asked("ap1")),
    event("w1", "w1", 200, turnEnd(true)),
    event("w1", "w1", 300, decided("ap1")),
  ]);
  assert.equal(stats.approvalMs, 200);
  assert.equal(stats.pendingApprovals, 0);
});

test("the same tool id never pairs across workers or nodes", () => {
  const events = [
    event("w1", "w1", 100, call("shared")),
    event("w2", "w2", 200, result("shared")),
    event("consult:7", "w2", 300, call("shared")),
    event("consult:7", "w2", 350, result("shared")),
  ];
  // w1's call never gets a result, so run 100..350 is pending time, not a 200 ms success.
  const all = summarizeRunStats(events);
  assert.equal(all.pendingTools, 1);
  assert.equal(all.toolMs, 250);

  const onlyW1 = summarizeRunStats(events, { role: "w1" });
  assert.deepEqual([onlyW1.eventCount, onlyW1.toolMs, onlyW1.pendingTools], [1, 0, 1]);

  const onlyConsult = summarizeRunStats(events, { node: "consult:7" });
  assert.deepEqual([onlyConsult.eventCount, onlyConsult.toolMs, onlyConsult.pendingTools], [2, 50, 0]);
});

test("a result without an open call is ignored rather than inventing a zero-length success", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, result("missing")),
    event("w1", "w1", 200, note("x")),
    event("w1", "w1", 300, call("missing")),
    event("w1", "w1", 400, note("y")),
  ]);
  assert.equal(stats.toolMs, 100);
  assert.equal(stats.pendingTools, 1);
  assert.equal(stats.failedTools, 0);
});

test("an orphan failing result is not counted as a tool failure", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, result("missing", false)),
    event("w1", "w1", 200, note("x")),
  ]);
  assert.equal(stats.failedTools, 0);
  assert.equal(stats.toolMs, 0);
  assert.equal(stats.pendingTools, 0);
});

test("a failing result that arrives after its turn ended stays pending-only", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, call("t1")),
    event("w1", "w1", 200, turnEnd(true)),
    event("w1", "w1", 300, result("t1", false)),
  ]);
  // The call was already finalised as pending at its turn end; the late result cannot retroactively
  // close it, and it must not turn into a failure count either.
  assert.equal(stats.pendingTools, 1);
  assert.equal(stats.failedTools, 0);
  assert.equal(stats.toolMs, 100);
});

test("repeated tool_call updates for one running call fold into a single call", () => {
  // Codex re-emits tool_call with the same id on every in-progress item update.
  const stats = summarizeRunStats([
    event("w1", "w1", 100, call("t1")),
    event("w1", "w1", 150, call("t1")),
    event("w1", "w1", 200, result("t1")),
    event("w1", "w1", 400, note("x")),
  ]);
  assert.equal(stats.toolMs, 100);
  assert.equal(stats.pendingTools, 0);
});

test("an open call is pending at its turn end, and the same id after it is a new call", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, call("t1")),
    event("w1", "w1", 200, turnEnd(false, true)),
    event("w1", "w1", 300, call("t1")),
    event("w1", "w1", 400, result("t1")),
    event("w1", "w1", 500, note("x")),
  ]);
  // First call: 100..200 pending. Second call: 300..400 completed.
  assert.equal(stats.toolMs, 100 + 100);
  assert.equal(stats.pendingTools, 1);
});

test("a replayed stored event with the same id is counted once", () => {
  const first = withId(41, "w1", "w1", 100, turnEnd(false));
  const replayed = withId(41, "w1", "w1", 100, turnEnd(false));
  const stats = summarizeRunStats([first, replayed]);
  assert.equal(stats.failedTurns, 1);
  assert.equal(stats.eventCount, 1);
});

test("causality follows stored order, and an inverted end stamp clamps to zero", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 200, call("t1")),
    event("w1", "w1", 100, result("t1")),
    event("w1", "w1", 300, note("x")),
  ]);
  // The pair is closed by the result; its span is clamped instead of going negative.
  assert.equal(stats.toolMs, 0);
  assert.equal(stats.pendingTools, 0);
  assert.equal(stats.failedTools, 0);
  assert.equal(stats.elapsedMs, 200);
});

test("a turn end only closes the calls of its own node and role", () => {
  // Whole-chat summary: w1's turn end must not cut w2's still-running call short.
  const stats = summarizeRunStats([
    event("w1", "w1", 0, call("t1")),
    event("w2", "w2", 10, call("t2")),
    event("w1", "w1", 20, turnEnd(true)),
    event("w2", "w2", 100, result("t2")),
  ]);
  assert.equal(stats.pendingTools, 1); // only w1's call has no result
  assert.equal(stats.toolMs, 100); // w1 pending 0..20 + w2 completed 10..100
  assert.equal(stats.elapsedMs, 100);
});

test("a user stop closes only its own worker's calls", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 0, call("t1")),
    event("w2", "w2", 10, call("t2")),
    event("w1", "w1", 20, turnEnd(false, true)),
    event("w2", "w2", 100, result("t2")),
  ]);
  assert.equal(stats.pendingTools, 1);
  assert.equal(stats.toolMs, 100);
  assert.equal(stats.failedTurns, 0); // an interruption is not a failure
});

test("a turn end does not close a call of the same role in another node", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 0, call("t1")),
    event("consult:1", "w1", 20, turnEnd(true)),
    event("w1", "w1", 50, result("t1")),
  ]);
  assert.equal(stats.pendingTools, 0);
  assert.equal(stats.toolMs, 50);
});

test("a turn end does not close a call of another role in the same node", () => {
  const stats = summarizeRunStats([
    event("consult:1", "w1", 0, call("t1")),
    event("consult:1", "w2", 20, turnEnd(true)),
    event("consult:1", "w1", 50, result("t1")),
  ]);
  assert.equal(stats.pendingTools, 0);
  assert.equal(stats.toolMs, 50);
});

test("a turn end still closes every open call of its own conversation", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 0, call("a")),
    event("w1", "w1", 10, call("b")),
    event("w1", "w1", 20, turnEnd(true)),
    event("w1", "w1", 60, note("next instruction")),
  ]);
  assert.equal(stats.pendingTools, 2);
  assert.equal(stats.toolMs, 20); // union 0..20
});

test("a running node measures up to now, a finished one up to its last event", () => {
  const events = [event("w1", "w1", 100, call("t1")), event("w1", "w1", 400, note("working"))];
  assert.equal(summarizeRunStats(events).elapsedMs, 300);
  const running = summarizeRunStats(events, { now: 1_000 });
  assert.equal(running.elapsedMs, 900);
  assert.equal(running.toolMs, 900);
  assert.equal(running.pendingTools, 1);
  // A stale now never shrinks a finished run.
  assert.equal(summarizeRunStats(events, { now: 200 }).elapsedMs, 300);
});

test("interrupted turns are not failures and role filters change the scope", () => {
  const events = [
    event("w1", "w1", 100, turnEnd(false)),
    event("w1", "w1", 200, turnEnd(false, true)),
    event("w1", "w1", 300, turnEnd(true)),
    event("w1", "w1", 400, turnEnd(false)),
  ];
  assert.equal(summarizeRunStats(events).failedTurns, 2);
  assert.equal(summarizeRunStats(events, { role: "w1" }).eventCount, 4);
  assert.equal(summarizeRunStats(events, { role: "orch" }).eventCount, 0);
  assert.equal(summarizeRunStats(events, { node: "consult:1" }).failedTurns, 0);
});

test("model usage events give no time breakdown", () => {
  const stats = summarizeRunStats([
    event("w1", "w1", 100, usage("turn-a", 9_000)),
    event("w1", "w1", 400, call("t1")),
    event("w1", "w1", 500, result("t1")),
    event("w1", "w1", 600, usage("turn-b", 9_000)),
  ]);
  assert.equal(stats.elapsedMs, 500);
  assert.equal(stats.toolMs, 100);
  assert.equal(stats.approvalMs, 0);
});

test("each category never exceeds the measured elapsed span", () => {
  const events = [
    event("w1", "w1", 100, asked("ap1")),
    event("w1", "w1", 120, call("a")),
    event("w1", "w1", 130, call("b")),
    event("w1", "w1", 700, decided("ap1")),
    event("w1", "w1", 800, result("a")),
    event("w1", "w1", 900, result("b")),
    event("w1", "w1", 950, asked("ap2")),
    event("w1", "w1", 1_000, decided("ap2")),
  ];
  const stats = summarizeRunStats(events);
  assert.ok(stats.toolMs <= stats.elapsedMs);
  assert.ok(stats.approvalMs <= stats.elapsedMs);
  // tools: a 120..800, b 130..900 → union 120..900. approvals: 100..700 + 950..1000.
  assert.deepEqual([stats.elapsedMs, stats.toolMs, stats.approvalMs], [900, 780, 650]);
  assert.equal(stats.pendingApprovals, 0);
});

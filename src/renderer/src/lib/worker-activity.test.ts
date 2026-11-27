import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, Consult, NodeId, Role, TimelineEvent } from "../../../shared/types";
import { replayLive } from "../../../shared/event-page";
import { appendEvent, buildItems } from "../timeline";
import { pendingWorkerApprovals, runningAssignments, workerActivity } from "./worker-activity";

const run = (id: number, toRole: Role, status: Consult["status"] = "running"): Consult => ({
  id, chatId: 1, seq: id, fromRole: "orch", toRole, kind: "implement", request: "자료 확인", scope: [],
  responseSummary: null, filesChanged: [], status, startedAt: 1, endedAt: null,
});
const row = (id: number, event: AgentEvent, node: NodeId = "consult:1", role: Role = "w1"): TimelineEvent =>
  ({ id, at: id || 50, node, role, chatId: 1, event });

test("only running assignments are shown and an approval hides only its own worker", () => {
  const runs = [run(1, "w1"), run(2, "w2"), run(3, "w3", "done")];
  const approval = row(3, { type: "approval_request", request: { id: "ask", role: "w1", title: "파일 변경", detail: "", risk: "medium" } });
  const allowed = row(4, { type: "approval_resolved", id: "ask", decision: "once" });
  assert.deepEqual([...runningAssignments("working", runs, pendingWorkerApprovals([])).keys()], ["w1", "w2"]);
  assert.deepEqual([...runningAssignments("approval", runs, pendingWorkerApprovals([approval])).keys()], ["w2"]);
  assert.deepEqual([...runningAssignments("working", runs, pendingWorkerApprovals([approval, allowed])).keys()], ["w1", "w2"]);
  assert.equal(runningAssignments("paused", runs, new Set()).size, 0);
});

test("an app receipt surfaces only in the main chat, and tool output tracks only the selected assignment", () => {
  const consult = run(1, "w1");
  const accepted = row(2, { type: "consult_ack", consultId: 1 });
  assert.deepEqual(buildItems([accepted], undefined, true), [{ kind: "worker-acceptance", key: "accepted-1", role: "w1", at: 2 }]);
  assert.deepEqual(buildItems([accepted], "w1", true), []);
  const preparing = row(0, { type: "tool_progress", id: "read", name: "Read" });
  const call = row(3, { type: "tool_call", id: "read", name: "Read", input: "example.txt" });
  assert.equal(workerActivity([preparing], consult)?.label, "Read 준비 중");
  const first = row(0, { type: "tool_progress", id: "read", delta: "first\n" });
  const next = row(0, { type: "tool_progress", id: "read", delta: "second" });
  const other = row(4, { type: "tool_call", id: "read", name: "Other", input: "other.txt" }, "consult:2", "w2");
  const working = [preparing, call, first, other, next].reduce(appendEvent, []);
  assert.equal(working.filter(e => e.event.type === "tool_progress").length, 1);
  assert.deepEqual(workerActivity(working, consult), { at: 50, label: "Read 실행 중", detail: "example.txt", output: "first\nsecond" });
  const result = row(5, { type: "tool_result", id: "read", ok: true, output: "verified" });
  const settled = appendEvent(working, result);
  assert.ok(settled.every(e => e.event.type !== "tool_progress"));
  assert.equal(workerActivity(settled, consult)?.label, "Read 완료");
  assert.equal(workerActivity(appendEvent(settled, row(6, { type: "turn_end", ok: true })), consult), undefined);
  assert.deepEqual(replayLive([call, result], [first, result], appendEvent), [call, result]);
});

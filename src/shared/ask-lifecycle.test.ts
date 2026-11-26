import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, NodeId, PlanState, Role, TimelineEvent } from "./types";
import { pendingAsks } from "./ask-lifecycle";

let nextId = 1;
const event = (payload: AgentEvent, node: NodeId = "orch", role: Role | null = "orch"): TimelineEvent => {
  const id = nextId++;
  return { id, chatId: 1, node, role, at: id, event: payload };
};
const ask = (id: string, planConfirm = false) => event({ type: "ask_user", id, question: id, options: [], ...(planConfirm ? { planConfirm: true as const } : {}) });
const user = (text: string, queued = false) => event({ type: "user", text, attachments: [], ...(queued ? { queued: true as const } : {}) }, "orch", null);
const masterEnd = (ok = true, interrupted = false) => event({ type: "turn_end", ok, ...(interrupted ? { interrupted: true as const } : {}) });
const workerEnd = () => event({ type: "turn_end", ok: true }, "w1", "w1");
const planState = (state: PlanState) => event({ type: "plan_state", state });
const ids = (events: readonly TimelineEvent[]) => pendingAsks(events).map((x) => x.event.type === "ask_user" ? x.event.id : "");

test("ordinary questions close at the master boundary, but not on worker or queued events", () => {
  const q = ask("ordinary");
  assert.deepEqual(ids([q, workerEnd()]), ["ordinary"]);
  assert.deepEqual(ids([q, user("추가 지시", true)]), ["ordinary"]);
  assert.deepEqual(ids([q, workerEnd(), user("추가 지시", true)]), ["ordinary"]);
  assert.deepEqual(ids([q, masterEnd()]), []);
  assert.deepEqual(ids([q, user("새 작업")]), []);
});

test("an answered question is no longer pending", () => {
  const q = ask("answered");
  const answer = event({ type: "ask_user_answer", id: "answered", answer: "예" });
  assert.deepEqual(ids([q, answer]), []);
});

test("plan confirmations survive a successful master turn only", () => {
  assert.deepEqual(ids([ask("success", true), masterEnd()]), ["success"]);

  for (const [label, ok, interrupted] of [["failed", false, false], ["interrupted", true, true]] as const) {
    assert.deepEqual(ids([ask(label, true), masterEnd(ok, interrupted)]), [], label);
  }

  assert.deepEqual(ids([ask("queued-revision", true), user("수정", true)]), []);
  assert.deepEqual(ids([ask("new-message", true), user("새 작업")]), []);
  assert.deepEqual(ids([ask("proposal", true), planState("proposed")]), ["proposal"]);
  for (const state of ["running", "done", "cancelled", "incomplete", "failed", "stopped"] as const) {
    assert.deepEqual(ids([ask(state, true), planState(state)]), [], state);
  }
});

test("only a follow-up question remains, and a newer plan card supersedes an older one", () => {
  const old = ask("old");
  const fresh = ask("fresh");
  assert.deepEqual(ids([old, user("새 질문"), fresh]), ["fresh"]);

  const oldPlan = ask("old-plan", true);
  const newPlan = ask("new-plan", true);
  assert.deepEqual(ids([oldPlan, newPlan]), ["new-plan"]);
});

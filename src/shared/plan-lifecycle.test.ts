import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, TimelineEvent } from "./types";
import { currentPlanView, droppedSteps, keepDroppedSteps, latestPlanState, pendingProposal, planStepsFor } from "./plan-lifecycle";
import { validatePlanSteps } from "./plan-steps";

let seq = 0;
const ev = (event: AgentEvent, role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id: ++seq, chatId: 1, node: "orch", role, at: seq, event });
const user = (text: string) => ev({ type: "user", text, attachments: [] }, null);
const steps = (status: "pending" | "completed" | "cancelled", title = "A") => [{ title, status }] as const;

test("validator: cancelled is kept with a reason (default when missing); unknown statuses stay pending", () => {
  const out = validatePlanSteps([{ title: "A", status: "cancelled" }, { title: "B", status: "cancelled", cancelReason: "  범위 밖 " }, { title: "C", status: "skipped" }]);
  assert.deepEqual(out.map((s) => [s.status, s.cancelReason]), [["cancelled", "사유가 기록되지 않았습니다."], ["cancelled", "범위 밖"], ["pending", undefined]]);
  assert.equal(validatePlanSteps([{ title: "D", status: "completed", cancelReason: "x" }])[0].cancelReason, undefined, "a reason only on cancelled steps");
});

test("droppedSteps: unfinished and cancelled steps must stay; a completed one may be left out", () => {
  const prev = validatePlanSteps([{ id: "a", title: "A", status: "pending" }, { title: "B", status: "inProgress" }, { title: "C", status: "completed" }, { title: "D", status: "cancelled", cancelReason: "범위 밖" }]);
  assert.deepEqual(droppedSteps(prev, []).map((s) => s.title), ["A", "B", "D"]);
  assert.deepEqual(droppedSteps(prev, [{ id: "a", title: "A 수정", status: "pending" }, { title: "B", status: "cancelled" }, { title: "D", status: "cancelled" }]), [], "matched by id, otherwise by title");
  assert.deepEqual(droppedSteps(prev, [{ id: "a", title: "A", status: "completed" }, { title: "B", status: "completed" }, { title: "D 다른 이름", status: "cancelled" }]).map((s) => s.title), ["D"], "a cancellation cannot be renamed away");
});

test("keepDroppedSteps puts steps that must stay back after their previous neighbour, unchanged", () => {
  const prev = validatePlanSteps([{ title: "A", status: "cancelled", cancelReason: "중복" }, { title: "B", status: "pending" }, { title: "C", status: "pending" }]);
  const kept = keepDroppedSteps(prev, [{ title: "C", status: "completed" }]);
  assert.deepEqual(kept.map((s) => [s.title, s.status, s.cancelReason]), [["A", "cancelled", "중복"], ["B", "pending", undefined], ["C", "completed", undefined]]);
  assert.deepEqual(keepDroppedSteps(prev, prev), prev);
});

test("pendingProposal: only the proposal that is still the latest request", () => {
  seq = 0;
  const a = user("/plan A");
  const events = [a, ev({ type: "plan_update", steps: [...steps("pending")], planId: a.id }), ev({ type: "plan_state", state: "proposed", planId: a.id })];
  assert.equal(pendingProposal(events), a.id);
  assert.equal(pendingProposal([...events, user("다른 지시")]), undefined, "superseded by a later instruction");
  assert.equal(pendingProposal([...events, ev({ type: "user", text: "대기 지시", attachments: [], queued: true }, null)]), undefined, "a queued one counts too");
  assert.equal(pendingProposal([...events, ev({ type: "plan_state", state: "cancelled", planId: a.id })]), undefined);
  seq = 0;
  const legacy = [user("/plan 예전"), ev({ type: "plan_state", state: "proposed" })];
  assert.equal(pendingProposal(legacy), 1, "an older proposal without planId resolves to its /plan message");
});

test("planStepsFor and latestPlanState read only the plan asked for", () => {
  seq = 0;
  const events = [
    ev({ type: "plan_update", steps: [...steps("pending")], planId: 1, instructionId: 1 }),
    ev({ type: "plan_update", steps: [...steps("completed", "native")] }), // native tool: no planId
    ev({ type: "plan_update", steps: [...steps("pending", "worker")], planId: 1 }, "w1"),
    ev({ type: "plan_state", state: "proposed", planId: 1 }),
  ];
  assert.equal(planStepsFor(events, 1)![0].title, "A");
  assert.equal(planStepsFor(events, 2), undefined);
  assert.deepEqual({ ...latestPlanState(events), eventId: 0 }, { state: "proposed", planId: 1, reason: undefined, eventId: 0 });
});

test("currentPlanView: a cancelled plan stays visible with its reason until replaced; plans never mix", () => {
  seq = 0;
  const a = user("/plan 첫 계획");
  const events = [
    a,
    ev({ type: "plan_update", steps: [...steps("pending", "A1")], planId: a.id, instructionId: a.id }),
    ev({ type: "plan_state", state: "proposed", planId: a.id }),
    ev({ type: "plan_state", state: "cancelled", planId: a.id, reason: "사용자가 제안을 취소했습니다." }),
  ];
  assert.deepEqual(currentPlanView(events), { planId: a.id, steps: [...steps("pending", "A1")], explanation: undefined, state: "cancelled", reason: "사용자가 제안을 취소했습니다." });

  const b = user("/plan 둘째 계획");
  const next = [...events, b];
  assert.equal(currentPlanView(next), null, "a new /plan starts fresh instead of showing the cancelled one");
  next.push(ev({ type: "plan_update", steps: [...steps("pending", "B1")], planId: b.id, instructionId: b.id }));
  const view = currentPlanView(next)!;
  assert.deepEqual([view.planId, view.state, view.steps[0].title, view.reason], [b.id, "live", "B1", undefined], "nothing from the cancelled plan");

  // A running plan keeps its checklist through a follow-up; a finished one is replaced by a new instruction.
  next.push(ev({ type: "plan_state", state: "proposed", planId: b.id }), user("계획 실행"), ev({ type: "plan_state", state: "running", planId: b.id }), user("진행 중 질문"));
  assert.equal(currentPlanView(next)!.state, "running");
  next.push(ev({ type: "plan_state", state: "incomplete", planId: b.id, reason: "끝나지 않은 단계 1개: B1" }));
  assert.deepEqual([currentPlanView(next)!.state, currentPlanView(next)!.reason], ["incomplete", "끝나지 않은 단계 1개: B1"]);
  next.push(user("다른 일"));
  assert.equal(currentPlanView(next), null);
});

test("alignNativeSteps: identity and links only from a unique same-titled recorded step", async () => {
  const { alignNativeSteps } = await import("./plan-lifecycle");
  const prev = validatePlanSteps([{ id: "a", title: "A", status: "pending", owner: "클로드 1호" }, { id: "b", title: "B", status: "pending", dependsOn: ["a"], consultIds: [7] }, { id: "c1", title: "C", status: "pending" }, { id: "c2", title: "C", status: "pending" }]);
  const out = alignNativeSteps(prev, [{ title: "A", status: "completed" }, { title: "B", status: "inProgress" }, { title: "C", status: "completed" }, { title: "D", status: "pending" }]);
  assert.deepEqual(out.map((s) => [s.id, s.owner, s.dependsOn, s.consultIds]), [["a", "클로드 1호", undefined, undefined], ["b", undefined, ["a"], [7]], [undefined, undefined, undefined, undefined], [undefined, undefined, undefined, undefined]]);
  assert.deepEqual(alignNativeSteps(prev, [{ title: "A", status: "completed" }, { title: "A", status: "pending" }]).map((s) => s.id), [undefined, undefined], "a title repeated in the update is not matched");
  assert.deepEqual(alignNativeSteps(prev, [{ id: "z", title: "A", status: "completed" }]).map((s) => s.id), ["z"], "a step with its own id keeps it");
});

test("validator with the previous list: a cancellation keeps its reason and stays cancelled", () => {
  const prev = validatePlanSteps([{ id: "a", title: "A", status: "cancelled", cancelReason: "범위 제외" }]);
  const notes: string[] = [];
  assert.deepEqual(validatePlanSteps([{ id: "a", title: "A", status: "cancelled" }], prev).map((s) => s.cancelReason), ["범위 제외"]);
  assert.deepEqual(validatePlanSteps([{ id: "a", title: "A", status: "inProgress" }], prev, notes).map((s) => [s.status, s.cancelReason]), [["cancelled", "범위 제외"]]);
  assert.equal(notes.length, 1);
  assert.equal(validatePlanSteps([{ id: "a", title: "A", status: "cancelled" }]).at(0)!.cancelReason, "사유가 기록되지 않았습니다.", "without a recorded reason the default applies");
});

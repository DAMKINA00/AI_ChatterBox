import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanStep, TimelineEvent } from "../../../shared/types";
import { isPlanChangedError, pendingAskId, planGroups, planReviewTarget, planRunArg, planStepTags, planStepViews, planVersion } from "./plan-view";

test("plan version: approval carries the version on screen; a replaced proposal is recognized", () => {
  const ev = (id: number, event: TimelineEvent["event"]) => ({ id, chatId: 1, role: "orch", node: "orch", ts: id, event }) as unknown as TimelineEvent;
  const v1 = ev(2, { type: "plan_state", state: "proposed", planId: 1 });
  const v2 = ev(4, { type: "plan_state", state: "proposed", planId: 1, version: 2 });
  assert.equal(planVersion([v1], 1), 1, "proposals before versions count as 1");
  assert.equal(planVersion([v1, v2], 1), 2);
  assert.equal(planVersion([v1, v2, ev(5, { type: "plan_state", state: "running", planId: 1, version: 2 })], 1), 2, "running keeps the approved version");
  assert.equal(planVersion([v2, ev(6, { type: "plan_state", state: "proposed", planId: 9, version: 7 })], 1), 2, "another plan's proposal is not this one");
  assert.equal(planVersion([], undefined), 1);
  assert.equal(planVersion([ev(0, { type: "plan_state", state: "running", planId: 1, version: 3 })], 1), 3, "a history snapshot replays the version on its running state");
  assert.equal(planRunArg(1234, 2), "1234:2", "plan id and version together");
  assert.match(planRunArg(7, 1), /^\d+:v?\d+$/, "the format the main process accepts");
  assert.equal(planRunArg(undefined, 1), "", "a legacy proposal without an id runs the latest");
  assert.equal(isPlanChangedError(new Error("계획이 바뀌었습니다(승인 화면: 계획 A vX → 현재: 계획 B vY). 최신 계획을 확인한 뒤 다시 승인하세요.")), true);
  assert.equal(isPlanChangedError(new Error("계획이 바뀌었습니다(v2 → v3). 최신 계획을 확인한 뒤 다시 승인하세요.")), true);
  assert.equal(isPlanChangedError(new Error("작업이 진행 중입니다.")), false);
  assert.equal(isPlanChangedError(undefined), false);
});
import { isPlanHotkey, planAskId, planToggleSettled } from "./plan-mode";

test("plan toggle: sends wait until the chat carries the requested value", () => {
  assert.equal(planToggleSettled(null, false), true, "no toggle in flight");
  assert.equal(planToggleSettled(true, false), false, "turned on, the chat still says off: block sends");
  assert.equal(planToggleSettled(true, true), true, "the chat update arrived");
  assert.equal(planToggleSettled(false, true), false);
});

test("plan hotkey: Alt+P by physical key only, never auto-repeat", () => {
  const k = (o: Partial<Parameters<typeof isPlanHotkey>[0]>) => ({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: "KeyP", repeat: false, ...o });
  assert.equal(isPlanHotkey(k({})), true);
  assert.equal(isPlanHotkey(k({ repeat: true })), false);
  assert.equal(isPlanHotkey(k({ ctrlKey: true })), false);
  assert.equal(isPlanHotkey(k({ shiftKey: true })), false);
  assert.equal(isPlanHotkey(k({ altKey: false })), false);
  assert.equal(isPlanHotkey(k({ code: "KeyO" })), false);
});

test("plan ask badge: first question in a plan-mode turn, before any proposal", () => {
  const ev = (id: number, event: TimelineEvent["event"]) => ({ id, chatId: 1, role: "orch", node: "orch", ts: id, event }) as unknown as TimelineEvent;
  const events = [ev(1, { type: "ask_user", id: "q1", question: "범위는?", options: [] })];
  assert.equal(planAskId(events, "working", true, false), "q1", "plan mode on, no plan yet");
  assert.equal(planAskId(events, "approval", false, true), "q1", "a shown plan");
  assert.equal(planAskId(events, "working", false, false), undefined, "an ordinary turn is not a plan question");
  assert.equal(planAskId(events, "idle", true, false), undefined, "the turn ended");
  assert.equal(planAskId([...events, ev(2, { type: "ask_user_answer", id: "q1", answer: "src" })], "working", true, false), undefined);
});

test("plan ask badge: ordinary questions follow master boundaries, not worker or queued events", () => {
  const ev = (id: number, event: TimelineEvent["event"], node: TimelineEvent["node"] = "orch", role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id, chatId: 1, node, role, at: id, event });
  const question = ev(1, { type: "ask_user", id: "ordinary", question: "범위는?", options: [] });
  const workerEnd = ev(2, { type: "turn_end", ok: true }, "w1", "w1");
  const queued = ev(3, { type: "user", text: "추가", attachments: [], queued: true }, "orch", null);
  assert.equal(planAskId([question, workerEnd, queued], "working", true, false), "ordinary");

  const ended = ev(10, { type: "turn_end", ok: true });
  assert.equal(planAskId([question, ended], "working", true, false), undefined, "a fresh working status does not revive an ended question");
  const newUser = ev(20, { type: "user", text: "새 작업", attachments: [] }, "orch", null);
  assert.equal(planAskId([question, newUser], "working", true, false), undefined);
});

test("plan ask badge: after a new question, only its card is selected", () => {
  const ev = (id: number, event: TimelineEvent["event"]): TimelineEvent => ({ id, chatId: 1, node: "orch", role: "orch", at: id, event });
  const old = ev(1, { type: "ask_user", id: "old", question: "이전", options: [] });
  const next = ev(2, { type: "user", text: "새 질문", attachments: [] });
  const fresh = ev(3, { type: "ask_user", id: "fresh", question: "새 질문의 확인", options: [] });
  assert.equal(pendingAskId([old, next, fresh]), "fresh");
  assert.equal(planAskId([old, next, fresh], "working", true, false), "fresh");

  const oldConfirm = ev(10, { type: "ask_user", id: "old-confirm", question: "이전 계획", options: [], planConfirm: true });
  const newConfirm = ev(11, { type: "ask_user", id: "new-confirm", question: "새 계획", options: [], planConfirm: true });
  assert.equal(pendingAskId([oldConfirm, newConfirm]), "new-confirm");
});

const step = (id: string, extra: Partial<PlanStep> = {}): PlanStep => ({ id, title: `t-${id}`, status: "pending", ...extra });
const ids = (steps: readonly PlanStep[]) => {
  const g = planGroups(planStepViews(steps));
  return g?.map(({ group, steps: list }) => [group, list.map((v) => v.step.id)]);
};

test("plan groups: plain checklists stay flat", () => {
  assert.equal(planGroups(planStepViews([{ title: "a", status: "pending" }, { title: "b", status: "completed" }])), null);
});

test("plan groups: explicit group numbers win and sort ascending", () => {
  assert.deepEqual(ids([step("c", { group: 2 }), step("a", { group: 1 }), step("b", { group: 1 })]), [[1, ["a", "b"]], [2, ["c"]]]);
});

test("plan groups: without groups, waves follow dependency depth", () => {
  const steps = [step("a"), step("b"), step("c", { dependsOn: ["a", "b"] }), step("d", { dependsOn: ["c"] }), step("e", { dependsOn: ["a"] })];
  assert.deepEqual(ids(steps), [[1, ["a", "b"]], [2, ["c", "e"]], [3, ["d"]]]);
});

const buckets = (steps: readonly PlanStep[]) =>
  planGroups(planStepViews(steps))?.map((g) => [g.undetermined ? "?" : g.group, g.steps.map((v) => v.step.id).sort()]);

test("plan groups: cycles and missing prerequisites are undetermined, whatever the input order", () => {
  const a = step("a", { dependsOn: ["b"] }), b = step("b", { dependsOn: ["a"] });
  const c = step("c", { dependsOn: ["missing"] }), d = step("d"), e = step("e", { dependsOn: ["a"] }), f = step("f", { dependsOn: ["d"] });
  const expected = [[1, ["d"]], [2, ["f"]], ["?", ["a", "b", "c", "e"]]];
  for (const order of [[a, b, c, d, e, f], [b, a, f, e, d, c], [e, f, c, b, d, a], [c, e, a, d, b, f]]) assert.deepEqual(buckets(order), expected);
});

test("plan step views: grouped plans start only the lowest open group (same rule as the main gate)", () => {
  const steps = [
    step("a", { group: 1, status: "completed" }),
    step("b", { group: 1, status: "inProgress" }),
    step("c", { group: 2 }),
    step("d", { group: 2, dependsOn: ["a"] }),
    step("x"),
  ];
  const v = Object.fromEntries(planStepViews(steps).map((x) => [x.step.id, x]));
  assert.equal(v.c.ready, false);
  assert.equal(v.c.groupWait, true);
  assert.equal(v.d.ready, false, "a later group waits even when its own prerequisite is done");
  assert.equal(v.x.ready, false, "a step without a group in a grouped plan is not startable");
  const next = planStepViews(steps.map((s) => (s.id === "b" ? { ...s, status: "completed" as const } : s)));
  assert.deepEqual(next.filter((x) => x.ready).map((x) => x.step.id), ["c", "d"]);
  assert.ok(next.every((x) => !x.groupWait));
});

test("plan step views: ungrouped checklists keep the dependency-only rule", () => {
  const v = planStepViews([step("a"), step("b", { dependsOn: ["a"] })]);
  assert.deepEqual(v.map((x) => [x.ready, x.groupWait]), [[true, false], [false, false]]);
});

test("plan review target: title with id, bare id when missing", () => {
  const steps = [step("impl"), step("rev", { reviewOf: "impl" }), step("lost", { reviewOf: "gone" })];
  assert.equal(planReviewTarget(steps[1], steps), "t-impl (impl)");
  assert.equal(planReviewTarget(steps[2], steps), "gone");
  assert.equal(planReviewTarget(steps[0], steps), undefined);
});

test("plan groups: a grouped step anchors the depth of its dependents", () => {
  assert.deepEqual(ids([step("a", { group: 2 }), step("b", { dependsOn: ["a"] })]), [[2, ["a"]], [3, ["b"]]]);
});

test("plan step tags: Korean labels for kind and model family", () => {
  assert.deepEqual(planStepTags(step("a", { kind: "implement", agentKind: "gpt" })), { kind: "구현", agentKind: "지피티" });
  assert.deepEqual(planStepTags(step("a")), {});
});

test("pending ask: latest unanswered question", () => {
  const ev = (id: number, event: TimelineEvent["event"]) => ({ id, chatId: 1, role: "orch", node: "orch", ts: id, event }) as unknown as TimelineEvent;
  const events = [
    ev(1, { type: "ask_user", id: "q1", question: "?", options: [] }),
    ev(2, { type: "ask_user_answer", id: "q1", answer: "yes" }),
  ];
  assert.equal(pendingAskId(events), undefined);
  assert.equal(pendingAskId([...events, ev(3, { type: "ask_user", id: "q2", question: "?", options: [] })]), "q2");
});

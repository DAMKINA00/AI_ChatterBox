// Plan lifecycle display: cancelled/incomplete/failed/stopped plans stay visible with their reason,
// cancelled steps never count as done, and a cancelled prerequisite still blocks. Desktop and remote.
import "./test-window-stub";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent, Chat, NodeId, PlanState, PlanStep, Role, TimelineEvent } from "../../../shared/types";
import { planHistory } from "./plan-history";
import { planOf } from "../timeline";
import { openPlanSteps, planActionsAvailable, planCounts, planCountsText, planEndedEarly, planStepViews } from "./plan-view";
import { PlanHistory, PlanPanel } from "../components/PlanGoal";
import { PlanHistoryList, PlanSteps, PlanSummary } from "../remote/Improvements";

let nextId = 1;
const ev = (node: NodeId, role: Role | null, event: AgentEvent): TimelineEvent => ({ id: nextId++, chatId: 1, node, role, at: nextId, event });
const steps: PlanStep[] = [
  { id: "a", title: "API", status: "completed" },
  { id: "b", title: "UI", status: "cancelled", cancelReason: "범위에서 제외" },
  { id: "c", title: "문서", status: "pending", dependsOn: ["b"] },
  { id: "d", title: "검증", status: "inProgress" },
];
const chat = { id: 1, title: "t", status: "idle" } as unknown as Chat;

test("counts keep cancelled apart from completed", () => {
  const c = planCounts(steps);
  assert.deepEqual(c, { total: 4, completed: 1, cancelled: 1, open: 2 });
  assert.equal(planCountsText(c), "완료 1 · 취소 1 · 남음 2");
  assert.equal(planCountsText(planCounts([{ title: "x", status: "completed" }])), "완료 1 · 남음 0");
  assert.deepEqual(openPlanSteps(steps).map((s) => s.id), ["c", "d"]);
});

test("a cancelled prerequisite still blocks; a cancelled step itself is not ready", () => {
  const views = planStepViews(steps);
  assert.deepEqual(views[2].blockers.map((s) => s.id), ["b"]);
  assert.equal(views[2].ready, false);
  assert.deepEqual(views[1].blockers, []);
  assert.equal(views[1].ready, false);
});

test("planOf keeps cancelled plans with their reason and never mixes plans", () => {
  const cancelled = [
    ev("orch", null, { type: "user", text: "/plan 기능", attachments: [] }),
    ev("orch", "orch", { type: "plan_update", steps, planId: 1 }),
    ev("orch", "orch", { type: "plan_state", state: "proposed", planId: 1 }),
    ev("orch", "orch", { type: "plan_state", state: "cancelled", planId: 1, reason: "사용자가 제안을 취소했습니다." }),
  ];
  const view = planOf(cancelled)!;
  assert.equal(view.state, "cancelled");
  assert.equal(view.reason, "사용자가 제안을 취소했습니다.");
  assert.equal(view.steps.length, 4);
  // A new /plan replaces the cancelled plan instead of inheriting its state.
  const next = [...cancelled, ev("orch", null, { type: "user", text: "/plan 다른 기능", attachments: [] }), ev("orch", "orch", { type: "plan_update", steps: [{ title: "새 단계", status: "pending" }], planId: 5 })];
  const fresh = planOf(next)!;
  assert.equal(fresh.state, "live");
  assert.equal(fresh.reason, undefined);
  assert.deepEqual(fresh.steps.map((s) => s.title), ["새 단계"]);
  assert.ok(["cancelled", "incomplete", "failed", "stopped"].every((s) => planEndedEarly(s as never)));
  assert.ok(!planEndedEarly("done") && !planEndedEarly("running") && !planEndedEarly("live"));
});

const plan = (state: NonNullable<ReturnType<typeof planOf>>["state"], reason?: string) => ({ steps, state, reason, planId: 1 });

test("desktop panel: cancelled plan is shown with state, reason, cancelled step and open steps", () => {
  const html = renderToStaticMarkup(createElement(PlanPanel, { chat, plan: plan("cancelled", "사용자가 제안을 취소했습니다."), onRevise: () => {} }));
  assert.match(html, /data-testid="plan-panel"[^>]*data-state="cancelled"/);
  assert.match(html, /data-testid="plan-state"[^>]*>취소됨</);
  assert.match(html, /완료 1 · 취소 1 · 남음 2/);
  assert.match(html, /data-testid="plan-reason"[^>]*>취소됨 · 사용자가 제안을 취소했습니다\./);
  assert.match(html, /data-testid="plan-step-cancelled"/);
  assert.match(html, /취소 사유: 범위에서 제외/);
  assert.match(html, /진행되지 않은 단계 2개/);
  assert.match(html, /선행 미완료: UI\(취소됨\)/);
  assert.doesNotMatch(html, /data-testid="plan-run"/, "a cancelled plan has no run button");
});

test("desktop panel: every ended state is labelled, and only a proposal offers run/cancel", () => {
  for (const [state, label] of [["incomplete", "미완료"], ["failed", "실패"], ["stopped", "중지됨"], ["done", "완료"], ["running", "실행 중"], ["proposed", "승인 대기"]] as const) {
    const html = renderToStaticMarkup(createElement(PlanPanel, { chat, plan: plan(state, state === "incomplete" ? "끝나지 않은 단계 2개: c, d" : undefined), onRevise: () => {} }));
    assert.match(html, new RegExp(`data-testid="plan-state"[^>]*>${label}<`), state);
    assert.equal(/data-testid="plan-run"/.test(html), state === "proposed", `${state} run button`);
    assert.equal(/<button[^>]*>.*?취소<\/button>/.test(html.replace(/plan-step-cancelled/g, "")), state === "proposed", `${state} cancel button`);
  }
  const missing = renderToStaticMarkup(createElement(PlanPanel, { chat, plan: plan("failed"), onRevise: () => {} }));
  assert.match(missing, /실패 · 사유가 기록되지 않았습니다\./);
});

test("remote: summary and steps show the same state, reason, counts and cancelled steps", () => {
  const summary = renderToStaticMarkup(createElement(PlanSummary, { plan: plan("incomplete", "끝나지 않은 단계 2개: c, d") }));
  assert.match(summary, /계획 미완료 · 완료 1 · 취소 1 · 남음 2/);
  assert.match(summary, /미완료 사유: 끝나지 않은 단계 2개: c, d/);
  const list = renderToStaticMarkup(createElement(PlanSteps, { plan: plan("cancelled", "x"), consults: [], items: [] }));
  assert.match(list, /진행되지 않은 단계 2개:/);
  assert.match(list, /취소됨/);
  assert.match(list, /취소 사유: 범위에서 제외/);
  assert.match(list, /선행 미완료: UI\(취소됨\)/);
  const live = renderToStaticMarkup(createElement(PlanSteps, { plan: plan("running"), consults: [], items: [] }));
  assert.doesNotMatch(live, /진행되지 않은 단계/, "a running plan lists open steps in place, not as left over");
});

// ---------- read-only history of ended plans (722)

const hist = (...list: TimelineEvent[]) => planHistory(list);
const user = (text: string) => ev("orch", null, { type: "user", text, attachments: [] });
const update = (s: PlanStep[], planId?: number) => ev("orch", "orch", { type: "plan_update", steps: s, ...(planId !== undefined ? { planId } : {}) });
const stateEv = (state: PlanState, planId?: number, reason?: string) => ev("orch", "orch", { type: "plan_state", state, ...(planId !== undefined ? { planId } : {}), ...(reason ? { reason } : {}) });

test("history: a cancelled proposal stays readable after the next ordinary instruction", () => {
  const events = [user("/plan A"), update(steps, 1), stateEv("proposed", 1), stateEv("cancelled", 1, "사용자가 제안을 취소했습니다."), user("다른 일")];
  assert.equal(planOf(events), null, "the pinned panel moves on");
  const h = planHistory(events);
  assert.equal(h.length, 1);
  assert.equal(h[0].state, "cancelled");
  assert.equal(h[0].reason, "사용자가 제안을 취소했습니다.");
  assert.equal(h[0].steps.find((s) => s.id === "b")?.cancelReason, "범위에서 제외");
});

test("history: an incomplete plan stays apart from the new /plan that replaced it", () => {
  const h = hist(user("/plan A"), update(steps, 1), stateEv("running", 1), stateEv("incomplete", 1, "끝나지 않은 단계 2개: c, d"),
    user("/plan B"), update([{ title: "B1", status: "pending" }], 9), stateEv("proposed", 9));
  assert.deepEqual(h.map((x) => [x.key, x.state, x.steps.length]), [["plan:1", "incomplete", 4]]);
});

test("history: plans with different ids never mix; the shown plan is not history", () => {
  const h = hist(update([{ title: "A1", status: "cancelled", cancelReason: "중복" }], 1), stateEv("cancelled", 1, "취소 A"),
    update([{ title: "B1", status: "pending" }], 2), stateEv("running", 2));
  assert.deepEqual(h.map((x) => [x.planId, x.state, x.steps.map((s) => s.title)]), [[1, "cancelled", ["A1"]]]);
  assert.equal(planOf([update([{ title: "B1", status: "pending" }], 2)])?.steps[0].title, "B1");
});

test("history: several end states of one plan keep only the latest; running again leaves the history", () => {
  const twice = hist(update(steps, 3), stateEv("stopped", 3, "중지"), stateEv("failed", 3, "오류"), user("다음"));
  assert.deepEqual(twice.map((x) => [x.state, x.reason]), [["failed", "오류"]]);
  const resumed = hist(update(steps, 3), stateEv("stopped", 3, "중지"), stateEv("running", 3));
  assert.equal(resumed.length, 0, "a plan back on the panel is not stale history");
});

test("history: legacy plans without ids are kept per segment, newest first", () => {
  const h = hist(user("/plan 옛 A"), update([{ title: "A", status: "pending" }]), stateEv("cancelled"), user("/plan 옛 B"), update([{ title: "B", status: "completed" }]), stateEv("done"), user("일반 지시"));
  assert.deepEqual(h.map((x) => [x.state, x.steps[0]?.title, x.reason]), [["done", "B", undefined], ["cancelled", "A", undefined]]);
});

test("history UI: desktop and remote show state, reason and step reasons, with no buttons", () => {
  const entries = hist(user("/plan A"), update(steps, 1), stateEv("cancelled", 1, "사용자가 제안을 취소했습니다."), user("다른 일"));
  for (const html of [renderToStaticMarkup(createElement(PlanHistory, { history: entries })), renderToStaticMarkup(createElement(PlanHistoryList, { history: entries }))]) {
    assert.match(html, /이전 계획 1개/);
    assert.match(html, /취소됨/);
    assert.match(html, /사유: 사용자가 제안을 취소했습니다\./);
    assert.match(html, /완료 1 · 취소 1 · 남음 2/);
    assert.match(html, /취소 사유: 범위에서 제외/);
    assert.match(html, /미진행/);
    assert.doesNotMatch(html, /<button/, "read-only: no run/cancel");
  }
  assert.equal(renderToStaticMarkup(createElement(PlanHistory, { history: [] })), "");
});

test("a proposal offers run/cancel only while the chat is idle (desktop and remote helper)", () => {
  for (const status of ["working", "approval", "pausing", "paused"]) {
    assert.equal(planActionsAvailable("proposed", status), false, status);
    const html = renderToStaticMarkup(createElement(PlanPanel, { chat: { ...chat, status } as Chat, plan: plan("proposed"), onRevise: () => {} }));
    assert.doesNotMatch(html, /data-testid="plan-run"|data-testid="plan-cancel"/, status);
    assert.match(html, /data-testid="plan-actions-wait"/, status);
  }
  for (const status of ["idle", "done", "error"]) assert.equal(planActionsAvailable("proposed", status), true, status);
  assert.equal(planActionsAvailable("cancelled", "idle"), false);
  const idle = renderToStaticMarkup(createElement(PlanPanel, { chat, plan: plan("proposed"), onRevise: () => {} }));
  assert.match(idle, /data-testid="plan-run"/);
  assert.match(idle, /data-testid="plan-cancel"/);
});

test("history: an ended plan still on the panel is not listed twice; a resumed plan replaced later leaves no stale end state", () => {
  assert.equal(hist(update(steps, 7), stateEv("cancelled", 7, "취소")).length, 0, "still pinned: shown once, on the panel");
  const replaced = hist(update(steps, 3), stateEv("stopped", 3, "중지"), stateEv("running", 3), update([{ title: "B1", status: "pending" }], 4));
  assert.equal(replaced.length, 0, "plan 3 ran again after the stop, so its old stop is not its end");
});

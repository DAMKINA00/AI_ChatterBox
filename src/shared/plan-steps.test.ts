import test from "node:test";
import assert from "node:assert/strict";
import { planStepBlockers, validatePlanSteps } from "./plan-steps";

test("older title/status checklists stay valid and are normalized", () => {
  assert.deepEqual(validatePlanSteps([{ title: " A ", status: "completed" }, { title: "B", status: "weird" }, { title: "   " }, null]), [
    { title: "A", status: "completed" },
    { title: "B", status: "pending" },
  ]);
});

test("structured fields are kept and deduplicated; empty links are omitted", () => {
  const [a, b] = validatePlanSteps([
    { id: "a", title: "A", status: "inProgress", owner: " 클로드 1호 ", consultIds: [7, 7] },
    { id: "b", title: "B", status: "pending", dependsOn: ["a", "a"], consultIds: [] },
  ]);
  assert.deepEqual(a, { id: "a", title: "A", status: "inProgress", owner: "클로드 1호", consultIds: [7] });
  assert.deepEqual(b, { id: "b", title: "B", status: "pending", dependsOn: ["a"] });
});

test("dependency mistakes are rejected instead of repaired", () => {
  const step = (id: string, ...dependsOn: string[]) => ({ id, title: id, status: "pending", dependsOn });
  assert.throws(() => validatePlanSteps([step("a"), step("a")]), /중복/);
  assert.throws(() => validatePlanSteps([step("a", "missing")]), /목록에 없습니다/);
  assert.throws(() => validatePlanSteps([step("a", "a")]), /자기 자신/);
  assert.throws(() => validatePlanSteps([step("a", "c"), step("b", "a"), step("c", "b")]), /순환/);
  assert.throws(() => validatePlanSteps("x"), /배열/);
  assert.throws(() => validatePlanSteps([{ title: "A", dependsOn: "b" }]), /dependsOn/);
  assert.throws(() => validatePlanSteps([{ title: "A", consultIds: ["1"] }]), /consultIds/);
  assert.throws(() => validatePlanSteps([{ title: "A", consultIds: [0] }]), /consultIds/);
});

test("a dependency on a step without an id is rejected", () => {
  assert.throws(() => validatePlanSteps([{ title: "A" }, { id: "b", title: "B", dependsOn: ["A"] }]), /목록에 없습니다/);
});

test("a long dependency chain does not overflow", () => {
  const steps = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, status: "pending", dependsOn: i ? [`s${i - 1}`] : [] }));
  assert.equal(validatePlanSteps(steps).length, 200);
});

test("blockers are the direct prerequisites not yet completed", () => {
  const steps = validatePlanSteps([
    { id: "a", title: "A", status: "completed" },
    { id: "b", title: "B", status: "inProgress" },
    { id: "c", title: "C", status: "pending", dependsOn: ["a", "b"] },
    { title: "D", status: "pending" },
  ]);
  assert.deepEqual(planStepBlockers(steps[2], steps).map(s => s.id), ["b"]);
  assert.deepEqual(planStepBlockers(steps[0], steps), []);
  assert.deepEqual(planStepBlockers(steps[3], steps), []);
});

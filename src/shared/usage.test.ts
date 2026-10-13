// Run: node --test src/shared/usage.test.ts   (Node 24 strips the types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWindow, pickUsage } from "./usage.ts";

test("weekly 60% left, 5h 50% left → weekly 60%", () => {
  const d = pickUsage({ weekly: { usedPercent: 40 }, fiveHour: { usedPercent: 50 } });
  assert.deepEqual([d?.window, d?.remaining, d?.warn], ["주간", 60, false]);
});

test("weekly 60% left, 5h 8% left → 5h 8% (warning)", () => {
  const d = pickUsage({ weekly: { usedPercent: 40 }, fiveHour: { usedPercent: 92 } });
  assert.deepEqual([d?.window, d?.remaining, d?.warn], ["5시간", 8, true]);
});

test("5h exactly 10% left switches", () => {
  assert.equal(pickUsage({ weekly: { usedPercent: 0 }, fiveHour: { usedPercent: 90 } })?.window, "5시간");
});

test("5h 11% left stays weekly", () => {
  assert.equal(pickUsage({ weekly: { usedPercent: 0 }, fiveHour: { usedPercent: 89 } })?.window, "주간");
});

test("weekly missing → 5h with a note", () => {
  const d = pickUsage({ fiveHour: { usedPercent: 37 } });
  assert.deepEqual([d?.window, d?.remaining, d?.note], ["5시간", 63, "주간 정보 없음"]);
});

test("nothing known → null", () => {
  assert.equal(pickUsage({}), null);
  assert.equal(pickUsage(undefined), null);
});

test("Codex window durations", () => {
  assert.equal(classifyWindow(300), "fiveHour");
  assert.equal(classifyWindow(10080), "weekly");
  assert.equal(classifyWindow(null), null);
});

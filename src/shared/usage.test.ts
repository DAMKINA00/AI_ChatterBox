// Run: node --test src/shared/usage.test.ts   (Node 24 strips the types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWindow, parseClaudeUsageText, parseResetTime, pickUsage } from "./usage.ts";

const USAGE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 8% used · resets Oct 13, 2:20pm (Asia/Seoul)
Current week (all models): 2% used · resets Oct 20, 5am (Asia/Seoul)
Current week (Fable): 0% used · resets Oct 20, 5am (Asia/Seoul)`;

test("Claude /usage text → 5h and weekly windows", () => {
  const now = new Date(2026, 9, 13, 12, 0);
  const u = parseClaudeUsageText(USAGE_TEXT, now)!;
  assert.equal(u.fiveHour?.usedPercent, 8);
  assert.equal(u.weekly?.usedPercent, 2);
  assert.equal(u.fiveHour?.resetsAt, Math.floor(new Date(2026, 9, 13, 14, 20).getTime() / 1000));
  assert.equal(u.weekly?.resetsAt, Math.floor(new Date(2026, 9, 20, 5, 0).getTime() / 1000));
  assert.deepEqual([pickUsage(u)?.window, pickUsage(u)?.remaining], ["주간", 98]);
});

test("reset time rolls over the year", () => {
  assert.equal(parseResetTime("Jan 2, 1am", new Date(2026, 11, 30)), Math.floor(new Date(2027, 0, 2, 1, 0).getTime() / 1000));
});

test("unrelated text → null", () => {
  assert.equal(parseClaudeUsageText("Not logged in · Please run /login"), null);
});

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

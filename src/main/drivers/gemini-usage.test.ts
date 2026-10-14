import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeminiUsage, readGeminiUsage } from "./gemini-usage.ts";

const GROUP = (buckets: unknown[]) => ({ name: "Gemini Models", buckets });
const payload = (groups: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  status: "SUCCESS",
  num_turns: 0,
  command: { name: "usage", data: { groups, ...extra } },
});

test("parses Gemini weekly and 5-hour buckets with reset timestamps", () => {
  const usage = parseGeminiUsage(payload([GROUP([
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.985168278, reset_time: "2026-10-21T01:22:12Z" },
    { id: "gemini-5h", window: "5h", remaining_fraction: 0.9566, reset_time: "2026-10-14T06:22:12Z" },
  ])]));

  assert.deepEqual(usage, {
    weekly: { usedPercent: (1 - 0.985168278) * 100, resetsAt: Math.floor(Date.parse("2026-10-21T01:22:12Z") / 1000) },
    fiveHour: { usedPercent: (1 - 0.9566) * 100, resetsAt: Math.floor(Date.parse("2026-10-14T06:22:12Z") / 1000) },
  });
});

test("ignores buckets from foreign groups and unknown windows", () => {
  assert.equal(parseGeminiUsage(payload([
    { name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.25 }] },
    GROUP([{ id: "gemini-monthly", window: "monthly", remaining_fraction: 0.5 }]),
  ])), null);
});

test("malformed, unsuccessful, and non-usage responses return null", () => {
  assert.equal(parseGeminiUsage("not json"), null);
  assert.equal(parseGeminiUsage(JSON.stringify({ status: "ERROR", command: { name: "usage", data: {} } })), null);
  assert.equal(parseGeminiUsage(JSON.stringify({ status: "SUCCESS", command: { name: "models", data: {} } })), null);
});

test("out-of-range fractions are rejected instead of becoming 100 percent", () => {
  assert.equal(parseGeminiUsage(payload([GROUP([
    { window: "weekly", remaining_fraction: -0.01 },
    { window: "5h", remaining_fraction: 1.01 },
  ])])), null);
  assert.deepEqual(parseGeminiUsage(payload([GROUP([
    { window: "weekly", remaining_fraction: 0.4 },
    { window: "5h", remaining_fraction: Number.NaN },
  ])])), {
    weekly: { usedPercent: 60, resetsAt: null },
  });
});

test("supports partial windows and exact zero/full remaining values", () => {
  assert.deepEqual(parseGeminiUsage(payload([GROUP([
    { window: "weekly", remaining_fraction: 0, reset_time: "invalid" },
    { window: "5h", remaining_fraction: 1 },
  ])])), {
    weekly: { usedPercent: 100, resetsAt: null },
    fiveHour: { usedPercent: 0, resetsAt: null },
  });

  assert.deepEqual(parseGeminiUsage(payload([GROUP([{ window: "weekly", remaining_fraction: 0.5 }])])), {
    weekly: { usedPercent: 50, resetsAt: null },
  });
});

test("collection errors use a Korean message without exposing command output", async () => {
  await assert.rejects(
    readGeminiUsage("C:\\does-not-exist\\agy.exe", process.cwd()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /사용량/);
      assert.doesNotMatch(error.message, /does-not-exist|agy\.exe/);
      return true;
    },
  );
});

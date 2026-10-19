import childProcess from "node:child_process";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { parseGeminiUsage, readGeminiUsage } from "./gemini-usage.ts";

const GROUP = (buckets: unknown[]) => ({ name: "Gemini Models", buckets });
const payload = (groups: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  status: "SUCCESS",
  num_turns: 0,
  command: { name: "usage", data: { groups, ...extra } },
});

const rootPayload = (groups: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  status: "SUCCESS",
  num_turns: 0,
  command: { name: "usage", data: { groups } },
  ...extra,
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

test("rejects usage-looking responses that contain conversation activity", () => {
  const groups = [GROUP([{ window: "weekly", remaining_fraction: 0.5 }])];
  for (const extra of [
    { conversation_id: "conversation-1" },
    { num_turns: 1 },
    { usage: { total_tokens: 1 } },
  ]) assert.equal(parseGeminiUsage(rootPayload(groups, extra)), null);
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

test("accepts a complete JSON snapshot even after exit or timeout and ends stdin", async () => {
  const stdout = payload([GROUP([{ window: "weekly", remaining_fraction: 0.5 }])]);
  for (const error of [
    Object.assign(new Error("process exit C:\\secret\\agy.exe"), { code: 1 }),
    Object.assign(new Error("timed out"), { killed: true }),
  ]) {
    let ended = false;
    let seen: { exe: string; args: string[]; options: any } | undefined;
    const patched = mock.method(childProcess, "execFile", ((exe: string, args: string[], options: any, callback: Function) => {
      seen = { exe, args, options };
      queueMicrotask(() => callback(error, stdout, ""));
      return { stdin: { end: () => { ended = true; } } };
    }) as any);
    try {
      assert.deepEqual(await readGeminiUsage("C:\\secret\\agy.exe", "C:\\secret\\cwd"), {
        weekly: { usedPercent: 50, resetsAt: null },
      });
    } finally { patched.mock.restore(); }
    assert.equal(ended, true);
    assert.deepEqual(seen?.args, ["-p", "/usage", "--output-format", "json"]);
    assert.equal(seen?.options.timeout, 45_000);
  }
});

test("distinguishes authentication, timeout and malformed Gemini usage errors", async () => {
  const cases = [
    { error: new Error("exit"), stdout: "", stderr: "Not logged in", expected: /로그인이 필요/ },
    { error: Object.assign(new Error("timed out"), { killed: true }), stdout: "not json", stderr: "", expected: /시간이 초과/ },
    { error: null, stdout: "not json", stderr: "", expected: /응답 형식/ },
  ];
  for (const current of cases) {
    let ended = false;
    const patched = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _options: any, callback: Function) => {
      queueMicrotask(() => callback(current.error, current.stdout, current.stderr));
      return { stdin: { end: () => { ended = true; } } };
    }) as any);
    try {
      await assert.rejects(readGeminiUsage("C:\\secret\\agy.exe", "C:\\secret\\cwd"), current.expected);
    } finally { patched.mock.restore(); }
    assert.equal(ended, true);
  }
});

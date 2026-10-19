import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { PassThrough } from "node:stream";
import { pickUsage } from "../../shared/usage";
import { parseGrokUsage } from "./grok-usage";
import { readGrokUsage } from "./grok";

const END = "2026-10-26T00:00:00Z";
const RESET = Math.floor(Date.parse(END) / 1000);

function billing(config: Record<string, unknown>) {
  return { config };
}

test("Grok usage maps weekly percent/reset and pickUsage keeps the weekly label", () => {
  const usage = parseGrokUsage(billing({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END },
    creditUsagePercent: 25,
  }));
  assert.deepEqual(usage, { weekly: { usedPercent: 25, resetsAt: RESET } });
  assert.deepEqual(pickUsage(usage!), { window: "주간", remaining: 75, resetsAt: RESET, warn: false });
});

test("Grok monthly and legacy cent balances are labeled monthly", () => {
  const monthly = parseGrokUsage(billing({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: END },
    creditUsagePercent: 40,
  }));
  assert.deepEqual(pickUsage(monthly!), { window: "월간", remaining: 60, resetsAt: RESET, warn: false });

  const legacy = parseGrokUsage(billing({
    monthlyLimit: { val: 10_000, unit: "cents" },
    used: { val: 2_500, unit: "cents" },
    billingPeriodEnd: END,
  }));
  assert.deepEqual(legacy, { monthly: { usedPercent: 25, resetsAt: RESET } });
  assert.deepEqual(pickUsage(legacy!), { window: "월간", remaining: 75, resetsAt: RESET, warn: false });
});

test("Grok accepts exact zero/full usage and only infers omitted percent for a valid period", () => {
  const zero = parseGrokUsage(billing({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END },
    creditUsagePercent: 0,
  }));
  const full = parseGrokUsage(billing({
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END },
    creditUsagePercent: 100,
  }));
  assert.equal(pickUsage(zero!)?.remaining, 100);
  assert.equal(pickUsage(full!)?.remaining, 0);

  assert.deepEqual(parseGrokUsage(billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END } })), {
    weekly: { usedPercent: 0, resetsAt: RESET },
  });
  assert.equal(parseGrokUsage(billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "invalid" } })), null);
  assert.equal(parseGrokUsage(billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_UNKNOWN", end: END } })), null);
  assert.equal(parseGrokUsage(billing({})), null);
});

test("Grok parser rejects malformed, null and out-of-range account usage", () => {
  for (const value of [
    null,
    undefined,
    {},
    { config: null },
    billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: -0.01 }),
    billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: 100.01 }),
    billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: Number.NaN }),
    billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: "25" }),
  ]) assert.equal(parseGrokUsage(value), null);
});

interface FakeRpcOptions {
  authMethod?: string | null;
  result?: unknown;
  error?: { code?: number; message: string };
}

function fakeRpc(options: FakeRpcOptions = {}) {
  const requests: any[] = [];
  const children: any[] = [];
  const patched = mock.method(childProcess, "spawn", (_exe: string, args: string[]) => {
    assert.ok(args.includes("--no-subagents"));
    const child: any = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, pid: 40_000 + children.length,
    });
    children.push(child);
    child.stdin.on("finish", () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.stdout.end();
      child.emit("exit", 0);
    });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.id === undefined) continue;
        if (request.method === "_x.ai/billing" && options.error) {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: options.error }) + "\n");
          continue;
        }
        const result = request.method === "initialize"
          ? { _meta: { defaultAuthMethodId: options.authMethod === undefined ? "cached_token" : options.authMethod } }
          : request.method === "_x.ai/billing" ? options.result : {};
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
      }
    });
    return child;
  });
  return { requests, children, restore: () => patched.mock.restore() };
}

test("Grok reader only initializes, authenticates and reads billing, then closes its owned child", async () => {
  const rpc = fakeRpc({ result: billing({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: 0 }) });
  try {
    const usage = await readGrokUsage("C:\\secret\\grok.exe", "C:\\secret\\cwd");
    assert.deepEqual(usage, { weekly: { usedPercent: 0, resetsAt: RESET } });
    assert.deepEqual(rpc.requests.map(request => request.method), ["initialize", "authenticate", "_x.ai/billing"]);
    assert.equal(rpc.requests.some(request => /session\/(?:new|load|prompt)/.test(request.method)), false);
    assert.equal(rpc.requests[1].params._meta.headless, true);
  } finally { rpc.restore(); }
  assert.ok(rpc.children.every(child => child.exitCode === 0));
});

test("Grok reader returns safe Korean errors without leaking RPC output or paths", async () => {
  const cases: FakeRpcOptions[] = [
    { authMethod: null },
    { error: { code: -32601, message: "method not found C:\\secret\\grok.exe token=sk-test" } },
    { result: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: 101 } } },
  ];
  for (const options of cases) {
    const rpc = fakeRpc(options);
    try {
      await assert.rejects(
        readGrokUsage("C:\\secret\\grok.exe", "C:\\secret\\cwd"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /[가-힣]/);
          assert.doesNotMatch(error.message, /secret|sk-test|grok\.exe/i);
          return true;
        },
      );
      assert.equal(rpc.requests.some(request => /session\/(?:new|load|prompt)/.test(request.method)), false);
    } finally { rpc.restore(); }
    assert.ok(rpc.children.every(child => child.exitCode === 0));
  }
});

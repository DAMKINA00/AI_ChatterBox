import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mock, test } from "node:test";
import { GeminiDriver } from "./gemini";
import type { AgentInput, DriverHost } from "./types";
import type { TokenCounts } from "../../shared/types";

const childProcess = createRequire(join(process.cwd(), "package.json"))("node:child_process") as typeof import("node:child_process");
const input: AgentInput = { text: "test prose", attachments: [], noWrites: true };
const modelOutput = "gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)\n";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    const end = this.stdin.end.bind(this.stdin);
    this.stdin.end = ((...args: any[]) => {
      const result = end(...args);
      queueMicrotask(() => this.finish());
      return result;
    }) as typeof this.stdin.end;
  }

  kill() {
    this.finish();
    return true;
  }

  finish(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  staleResult() {
    this.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "stale" } }) + "\n");
    this.emit("exit", 0, null);
  }
}

type ModelCallback = (error: Error | null, stdout: string, stderr: string) => void;

function harness(t: { mock: typeof mock }) {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-gemini-lifecycle-"));
  const hookScript = join(root, "hook.js");
  writeFileSync(hookScript, "// test hook\n");
  const callbacks = new Map<string, ModelCallback>();
  const children: FakeChild[] = [];
  const events: any[] = [];
  const nativeIds: string[] = [];
  let key = 0;
  const registrations = new Map<string, unknown>();
  const bridge = {
    register(definition: unknown) {
      const id = `hook-${++key}`;
      registrations.set(id, definition);
      return { key: id, url: `http://127.0.0.1/${id}` };
    },
    unregister(id: string) {
      registrations.delete(id);
    },
  };
  const host: DriverHost = {
    nativeId: (id) => nativeIds.push(id),
    emit: (event) => events.push(event),
    approve: async () => ({ verdict: "allow" }),
  };

  t.mock.method(childProcess, "execFile", ((exe: string, _args: string[], _options: unknown, callback: ModelCallback) => {
    callbacks.set(exe, callback);
    return undefined;
  }) as any);
  t.mock.method(childProcess, "spawn", (() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as any);

  let serial = 0;
  const make = (name: string, tokenBaseline?: TokenCounts) => {
    const exePath = join(root, `${name}-${++serial}.exe`);
    const driver = new GeminiDriver(
      { cwd: root, nativeId: null, exePath, tokenBaseline },
      { bridge, hookScript, tmpDir: root, sessionKey: name },
      host,
    );
    return { driver, exePath };
  };
  const completeModels = (exePath: string) => callbacks.get(exePath)?.(null, modelOutput, "");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { make, completeModels, children, events, nativeIds, cleanup };
}

test("a late exit or output from a disposed child cannot finish its replacement turn", async (t) => {
  const f = harness(t);
  const { driver, exePath } = f.make("mode-change");
  try {
    const first = driver.send(input);
    f.completeModels(exePath);
    await first;
    assert.equal(f.children.length, 1);
    await driver.hook("start", {});
    driver.onEvent({ event: "result", result: { status: "SUCCESS", usage: { output_tokens: 1 } } });
    assert.equal(driver.running, false);

    // Simulate an existing writable process from the older integration.
    (driver as any).noWrites = false;
    const second = driver.send(input);
    await second;
    assert.equal(f.children.length, 2);
    const oldChild = f.children[0];
    const beforeLateEvents = f.events.filter((event) => event.type === "turn_end").length;
    oldChild.staleResult();
    await flush();
    assert.equal(f.events.filter((event) => event.type === "turn_end").length, beforeLateEvents);
    assert.equal(driver.running, true);

    await assert.rejects(driver.send({ ...input, text: "duplicate" }), /이미 작업 중/);
    await driver.hook("start", {});
    f.children[1].stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "fresh", usage: { output_tokens: 2 } } }) + "\n");
    await flush();
    assert.equal(f.events.filter((event) => event.type === "turn_end").length, beforeLateEvents + 1);
  } finally {
    await driver.dispose();
    f.cleanup();
  }
});

test("stop and dispose invalidate a pending model lookup before it can spawn", async (t) => {
  const f = harness(t);
  try {
    for (const action of ["stop", "dispose"] as const) {
      const { driver, exePath } = f.make(`pending-${action}`);
      const pending = driver.send(input);
      await flush();
      assert.equal(f.children.length, 0);
      await driver[action]();
      f.completeModels(exePath);
      await assert.rejects(pending, /중지되었습니다/);
      assert.equal(f.children.length, 0);
      assert.equal(driver.running, false);
    }
  } finally {
    f.cleanup();
  }
});

test("a new driver's token baseline is used for its first usage delta", async (t) => {
  const f = harness(t);
  const baseline = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0 };
  const { driver, exePath } = f.make("token-baseline", baseline);
  try {
    const pending = driver.send(input);
    f.completeModels(exePath);
    await pending;
    driver.onEvent({ event: "init", conversation_id: "resumed-session" });
    await driver.hook("start", {});
    await assert.rejects(driver.send({ ...input, text: "duplicate" }), /이미 작업 중/);
    driver.onEvent({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 130, output_tokens: 20, thinking_tokens: 3, cache_read_tokens: 50 } } });
    const usage = f.events.findLast((event) => event.type === "agent_usage");
    assert.deepEqual(usage?.metrics, {
      inputTokens: 30,
      outputTokens: 13,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      turnId: usage.metrics.turnId,
      elapsedMs: usage.metrics.elapsedMs,
      model: "gemini-3.8-flash-medium",
      nativeId: "resumed-session",
      total: { inputTokens: 130, outputTokens: 23, cachedInputTokens: 50, cacheWriteInputTokens: 0 },
    });
  } finally {
    await driver.dispose();
    f.cleanup();
  }
});

test("stop during a mode transition prevents its replacement process", async (t) => {
  const f = harness(t);
  const { driver, exePath } = f.make("stop-transition");
  try {
    const first = driver.send(input);
    f.completeModels(exePath);
    await first;
    await driver.hook("start", {});
    driver.onEvent({ event: "result", result: { status: "SUCCESS" } });
    (driver as any).noWrites = false;
    const changing = driver.send(input);
    const duplicate = assert.rejects(driver.send(input), /이미 작업 중/);
    await driver.stop();
    await changing;
    await duplicate;
    assert.equal(f.children.length, 1);
    assert.equal(driver.running, false);
  } finally { await driver.dispose(); f.cleanup(); }
});

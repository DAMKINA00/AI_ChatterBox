import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeDriver } from "./drivers/claude";

function bridge() {
  let next = 0;
  return {
    bridge: {
      register: () => ({ key: `test-${++next}`, url: "http://127.0.0.1/test" }),
      unregister() {},
    } as any,
    hostEvents: [] as any[],
  };
}

function driver(exePath: string, env: ReturnType<typeof bridge>, tmpDir = process.cwd()) {
  return new ClaudeDriver({ cwd: tmpDir, nativeId: null, exePath }, { bridge: env.bridge, bridgeScript: "bridge-mcp.js", tmpDir }, {
    emit: event => env.hostEvents.push(event),
    nativeId() {},
    approve: async () => ({ verdict: "allow_chat" }),
  });
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(check(), true, "timed out waiting for Claude process event");
}

test("spawn error ends the turn exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-claude-process-error-"));
  try {
    const env = bridge();
    const instance = driver(join(root, "does-not-exist.exe"), env, root);
    await instance.send({ text: "hello", attachments: [] });
    await waitFor(() => env.hostEvents.some(event => event.type === "turn_end"));
    const ends = env.hostEvents.filter(event => event.type === "turn_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].ok, false);
    assert.equal(instance.running, false);
    await instance.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;

  constructor(exitCode: number | null) {
    super();
    this.exitCode = exitCode;
  }
}

test("an old child exit cannot end a newer child turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-claude-process-stale-"));
  const env = bridge();
  const first = new FakeChild(0);
  const second = new FakeChild(null);
  let spawned = 0;
  const spawnMock = mock.method(childProcess, "spawn", () => (++spawned === 1 ? first : second) as any);
  try {
    const instance = driver(join(root, "fake-claude.exe"), env, root);
    await instance.send({ text: "first", attachments: [] });
    (instance as any).onLine(JSON.stringify({ type: "result", user_message_uuid: "first" }));
    await instance.send({ text: "second", attachments: [], noWrites: true });
    assert.equal(spawned, 2);
    assert.equal(instance.running, true);
    const eventCount = env.hostEvents.length;

    first.emit("exit", 1);
    first.emit("error", new Error("stale child"));
    assert.equal(instance.running, true);
    assert.equal(env.hostEvents.length, eventCount);

    second.exitCode = 0;
    await instance.dispose();
  } finally {
    spawnMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

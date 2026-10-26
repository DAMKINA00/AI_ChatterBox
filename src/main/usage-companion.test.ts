import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { UsageCompanion, type UsageChild, type UsageCompanionOptions, type UsageSpawn } from "./usage-companion";
import type { UsageMonitorState, UsageNotification } from "../shared/usage-companion";

class FakeStream extends EventEmitter {
  writes: string[] = [];
  ended = false;
  write(data: string) { this.writes.push(data); return true; }
  end() { this.ended = true; this.emit("finish"); }
}

class FakeChild extends EventEmitter implements UsageChild {
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  emitState(state: UsageMonitorState) { this.stdout.emit("data", JSON.stringify({ type: "state", state }) + "\n"); }
  emitNotification(notification: UsageNotification) { this.stdout.emit("data", JSON.stringify({ type: "notification", ...notification }) + "\n"); }
  exit(code: number | null = 0) { this.emit("exit", code); this.emit("close"); }
}

function state(): UsageMonitorState {
  return { visible: false, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true, geminiBlocked: false, geminiPlan: "Google AI Pro" };
}

function fixture(saved?: Record<string, unknown>, allowed = true) {
  const root = mkdtempSync(join(tmpdir(), "cbx-usage-companion-"));
  const settingsFile = join(root, "desktop.json");
  if (saved) writeFileSync(settingsFile, JSON.stringify(saved), "utf8");
  const child = new FakeChild();
  const changes: ReturnType<UsageCompanion["snapshot"]>[] = [];
  const notifications: UsageNotification[] = [];
  const options: UsageCompanionOptions = { exe: join(root, "AIUsageMonitor.exe"), settingsFile, allowed, changed: snapshot => changes.push(snapshot), notification: notice => notifications.push(notice) };
  let spawns = 0;
  let spawnArgs: string[] = [];
  let spawnOptions: Parameters<UsageSpawn>[2] | undefined;
  const spawn: UsageSpawn = (_exe, args, spawnSettings) => { spawns++; spawnArgs = args; spawnOptions = spawnSettings; return child; };
  const companion = new UsageCompanion(options, spawn);
  return { root, settingsFile, child, changes, notifications, companion, get spawns() { return spawns; }, get spawnArgs() { return spawnArgs; }, get spawnOptions() { return spawnOptions; } };
}

test("starts one hosted child, waits for state, validates framing, and sends allowed commands", async () => {
  const f = fixture();
  const starting = f.companion.start();
  assert.equal(f.spawns, 1);
  assert.deepEqual(f.spawnArgs, ["--hosted"]);
  assert.equal(f.spawnOptions?.windowsHide, true);
  assert.deepEqual(f.spawnOptions?.stdio, ["pipe", "pipe", "ignore"]);
  assert.strictEqual(f.spawnOptions?.env, process.env);
  assert.equal(f.child.stdin.writes.length, 0);
  f.child.emitState(state());
  await starting;
  await f.companion.command("show");
  await f.companion.command("topmost", true);
  await f.companion.command("gemini-plan", null);
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [
    { command: "show" }, { command: "topmost", value: true }, { command: "gemini-plan", value: null },
  ]);
  const quitting = f.companion.command("quit");
  assert.equal(f.child.stdin.writes.at(-1), '{"command":"quit"}\n');
  f.child.exit();
  await quitting;
  await f.companion.stop();
  assert.equal(f.companion.snapshot().running, false);
  rmSync(f.root, { recursive: true, force: true });
});

test("a command while disabled enables and persists the companion", async () => {
  const f = fixture({ usageEnabled: false });
  const command = f.companion.command("show");
  f.child.emitState(state());
  await command;
  assert.equal(f.companion.snapshot().enabled, true);
  assert.equal(JSON.parse(readFileSync(f.settingsFile, "utf8")).usageEnabled, true);
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [{ command: "show" }]);
  const stopping = f.companion.stop();
  f.child.exit();
  await stopping;
  rmSync(f.root, { recursive: true, force: true });
});

test("preserves desktop settings and applies desired enabled state", async () => {
  const f = fixture({ theme: "dark", usageEnabled: false });
  assert.deepEqual(f.companion.snapshot(), { enabled: false, running: false });
  const starting = f.companion.setEnabled(true);
  f.child.emitState(state());
  await starting;
  assert.deepEqual(JSON.parse(readFileSync(f.settingsFile, "utf8")), { theme: "dark", usageEnabled: true });
  const stopping = f.companion.setEnabled(false);
  f.child.exit();
  await stopping;
  assert.equal(JSON.parse(readFileSync(f.settingsFile, "utf8")).usageEnabled, false);
  rmSync(f.root, { recursive: true, force: true });
});

test("disabled builds never spawn, write, or execute commands", async () => {
  const f = fixture({ theme: "dark" }, false);
  await f.companion.start();
  await f.companion.setEnabled(true);
  await f.companion.command("show");
  assert.equal(f.spawns, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.settingsFile, "utf8")), { theme: "dark" });
  rmSync(f.root, { recursive: true, force: true });
});

test("does not duplicate a child and reports hosted duplicate-instance exit", async () => {
  const f = fixture();
  const first = f.companion.start();
  const second = f.companion.start();
  assert.equal(f.spawns, 1);
  f.child.exit(2);
  await assert.rejects(first, /이미 실행 중/);
  await assert.rejects(second, /이미 실행 중/);
  assert.equal(f.notifications.at(-1)?.error, true);
  rmSync(f.root, { recursive: true, force: true });
});

test("stop sends quit, closes stdin, and waits for EOF without force-kill", async () => {
  const f = fixture();
  const starting = f.companion.start();
  f.child.emitState(state());
  await starting;
  const stopping = f.companion.stop();
  assert.deepEqual(JSON.parse(f.child.stdin.writes.at(-1)!), { command: "quit" });
  assert.equal(f.child.stdin.ended, true);
  f.child.exit();
  await stopping;
  assert.equal(f.companion.snapshot().running, false);
  rmSync(f.root, { recursive: true, force: true });
});

test("consumes asynchronous stdin errors without an unhandled error", async () => {
  const f = fixture();
  const starting = f.companion.start();
  f.child.emitState(state());
  await starting;
  f.child.stdin.emit("error", new Error("EPIPE"));
  assert.equal(f.companion.snapshot().error, "EPIPE");
  assert.equal(f.notifications.at(-1)?.error, true);
  const stopping = f.companion.stop();
  f.child.exit();
  await stopping;
  rmSync(f.root, { recursive: true, force: true });
});

test("reports child notifications and ignores malformed or oversized lines", async () => {
  const f = fixture();
  const starting = f.companion.start();
  f.child.emitNotification({ title: "알림", message: "완료", error: false });
  f.child.stdout.emit("data", "{" + "x".repeat(70_000) + "}\n");
  f.child.emitState(state());
  await starting;
  assert.equal(f.notifications.some(n => n.title === "알림" && n.error === false), true);
  assert.equal(f.companion.snapshot().state?.geminiPlan, "Google AI Pro");
  rmSync(f.root, { recursive: true, force: true });
});

test("times out without spawning a duplicate process", async () => {
  const f = fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const starting = f.companion.start();
    mock.timers.tick(20_000);
    await assert.rejects(starting, /20초/);
    assert.equal(f.child.stdin.ended, true);
    await assert.rejects(f.companion.start(), /20초/);
    assert.equal(f.spawns, 1);
  } finally {
    const stopping = f.companion.stop();
    f.child.exit();
    await stopping;
    mock.timers.reset();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("allows a stop retry after timeout without spawning another child", async () => {
  const f = fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const starting = f.companion.start();
    f.child.emitState(state());
    await starting;
    const first = f.companion.stop();
    mock.timers.tick(15_000);
    await assert.rejects(first, /15초/);
    const second = f.companion.stop();
    assert.notStrictEqual(first, second);
    assert.equal(f.spawns, 1);
    f.child.exit();
    await second;
  } finally {
    mock.timers.reset();
    rmSync(f.root, { recursive: true, force: true });
  }
});

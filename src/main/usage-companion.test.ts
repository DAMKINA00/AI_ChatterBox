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
  return { visible: false, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true };
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
  await assert.rejects(f.companion.command("gemini-plan" as any, null), /지원하지 않는/);
  await assert.rejects(f.companion.command("gemini-unblock" as any), /지원하지 않는/);
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [
    { command: "show" }, { command: "topmost", value: true },
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
  assert.equal(f.companion.snapshot().state?.claudeLoggedIn, true);
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

test("per-character selection: characterSet is normalized and 'character' commands are validated and sent", async () => {
  const f = fixture();
  const starting = f.companion.start();
  f.child.emitState({ ...state(), characterSet: ["grok", "orch", "grok", "admin"] as any });
  await starting;
  assert.deepEqual(f.companion.snapshot().state?.characterSet, ["orch", "grok"], "known ids, no duplicates, display order");
  await f.companion.command("character", { id: "gpt", on: true });
  await f.companion.command("character", { id: "orch", on: false });
  await assert.rejects(f.companion.command("character", { id: "deepseek", on: true }), /character/);
  await assert.rejects(f.companion.command("character", { id: "gpt" }), /character/);
  await assert.rejects(f.companion.command("character", true), /character/);
  await f.companion.command("characters", false);
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [
    { command: "character", value: { id: "gpt", on: true } },
    { command: "character", value: { id: "orch", on: false } },
    { command: "characters", value: false },
  ]);
  const quitting = f.companion.command("quit");
  f.child.exit();
  await quitting;
  rmSync(f.root, { recursive: true, force: true });
});

test("an older monitor without characterSet keeps the single toggle and is never sent 'character'", async () => {
  const f = fixture();
  const starting = f.companion.start();
  f.child.emitState({ ...state(), characterSet: "orch" as any });
  await starting;
  assert.equal(f.companion.snapshot().state?.characterSet, undefined, "a malformed set counts as an older monitor");
  await assert.rejects(f.companion.command("character", { id: "gpt", on: true }), /지원하지 않습니다/);
  await f.companion.command("characters", true);
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [{ command: "characters", value: true }]);
  const quitting = f.companion.command("quit");
  f.child.exit();
  await quitting;
  rmSync(f.root, { recursive: true, force: true });
});

test("[review 1078-2] a restart onto an older monitor clears the state and never sends it 'character'", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-usage-companion-"));
  const children = [new FakeChild(), new FakeChild()];
  let spawned = 0;
  const changes: ReturnType<UsageCompanion["snapshot"]>[] = [];
  const companion = new UsageCompanion({ exe: join(root, "m.exe"), settingsFile: join(root, "desktop.json"), allowed: true, changed: s => changes.push(s), notification: () => undefined },
    () => children[spawned++]);
  const first = companion.start();
  children[0].emitState({ ...state(), characterSet: ["orch"] });
  await first;
  children[0].exit(); // the new monitor goes away
  // Clicked while the older monitor is starting: passes the early check (old snapshot), must fail before writing.
  const pending = companion.command("character", { id: "gpt", on: true });
  assert.equal(spawned, 2);
  assert.equal(companion.snapshot().state, undefined, "no state until the new process reports one: monitor menu items are disabled");
  children[1].emitState(state()); // older monitor: no characterSet
  await assert.rejects(pending, /지원하지 않습니다/);
  assert.deepEqual(children[1].stdin.writes, [], "nothing was sent to the older monitor");
  await assert.rejects(companion.command("character", { id: "gpt", on: true }), /지원하지 않습니다/);
  const quitting = companion.command("quit");
  children[1].exit();
  await quitting;
  rmSync(root, { recursive: true, force: true });
});

test("[review 1081] a finished process's late stdout EOF flush never overwrites the new process's state", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-usage-companion-"));
  const children = [new FakeChild(), new FakeChild()];
  let spawned = 0;
  const companion = new UsageCompanion({ exe: join(root, "m.exe"), settingsFile: join(root, "desktop.json"), allowed: true, changed: () => undefined, notification: () => undefined },
    () => children[spawned++]);
  const first = companion.start();
  children[0].emitState({ ...state(), characterSet: ["orch"] });
  await first;
  // The old process leaves a state line without its newline in the buffer, then exits before stdout ends.
  children[0].stdout.emit("data", JSON.stringify({ type: "state", state: { ...state(), characterSet: ["grok"] } }));
  children[0].emit("exit", 0);
  const second = companion.start();
  children[1].emitState({ ...state(), characterSet: ["claude", "gpt"] });
  await second;
  children[0].stdout.emit("end"); // late EOF of the old process flushes its buffered line
  children[0].emit("close");
  assert.deepEqual(companion.snapshot().state?.characterSet, ["claude", "gpt"], "the new process's state stays");
  assert.equal(companion.snapshot().running, true);
  assert.equal(companion.snapshot().error, undefined, "no protocol error from the old process either");
  const quitting = companion.command("quit");
  children[1].exit();
  await quitting;
  rmSync(root, { recursive: true, force: true });
});

test("character events reach only a monitor that reports characterEvents: 1 and can show that character; nothing is queued", async () => {
  const f = fixture();
  const ev = { id: "assign:1", character: "deepseek" as const, kind: "assign" as const, text: "딥시크 1호에게 구현을 맡겼어요.", chatId: 1 };
  assert.equal(f.companion.characterEvent(ev), false, "not running: dropped");
  const starting = f.companion.start();
  f.child.emitState({ ...state(), characterSet: ["orch"] }); // no characterEvents, no characterIds
  await starting;
  assert.equal(f.companion.characterEvent({ ...ev, character: "orch" }), false, "older monitor: dropped");
  await assert.rejects(f.companion.command("character", { id: "deepseek", on: true }), /character|지원하지/);
  f.child.emitState({ ...state(), characterSet: ["orch"], characterIds: ["orch", "claude", "gpt", "gemini", "grok", "deepseek"], characterEvents: 1 });
  assert.equal(f.companion.characterEvent(ev), true);
  await f.companion.command("character", { id: "deepseek", on: true });
  assert.deepEqual(f.child.stdin.writes.map(line => JSON.parse(line)), [
    { command: "character-event", value: ev }, { command: "character", value: { id: "deepseek", on: true } },
  ]);
  await assert.rejects(f.companion.command("character-event" as any, ev), /지원하지 않는/);
  const quitting = f.companion.command("quit");
  f.child.exit();
  await quitting;
  rmSync(f.root, { recursive: true, force: true });
});

test("character questions work without an open chat and deduplicate requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-character-questions-"));
  const children = [new FakeChild(), new FakeChild()];
  let spawned = 0;
  const asked: unknown[] = [];
  let answer!: (p: { status: "answer"; text: string }) => void;
  const companion = new UsageCompanion({
    exe: "monitor", settingsFile: join(root, "desktop.json"), allowed: true, changed() {}, notification() {},
    characterAsk: async ask => { asked.push(ask); return new Promise(resolve => { answer = resolve; }); },
  }, () => children[spawned++]);
  const request = (requestId: string) => ({ type: "character-ask", requestId, character: "gpt", text: "질문입니다" });
  const emit = (child: FakeChild, value: unknown) => child.stdout.emit("data", JSON.stringify(value) + "\n");
  const writes = (child: FakeChild) => child.stdin.writes.map(line => JSON.parse(line));
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  try {
    const started = companion.start();
    children[0].emitState({ ...state(), characterAsk: 2 });
    await started;
    const ask = request("c".repeat(32));
    emit(children[0], ask);
    emit(children[0], { ...ask, requestId: ask.requestId.toUpperCase() });
    assert.equal(asked.length, 1);
    answer({ status: "answer", text: "실제 답변" });
    await tick();
    assert.deepEqual(writes(children[0]).at(-1), { command: "character-reply", value: { requestId: ask.requestId, character: "gpt", status: "answer", text: "실제 답변" } });
    emit(children[0], request("d".repeat(32)));
    children[0].exit();
    const restarted = companion.start();
    children[1].emitState({ ...state(), characterAsk: 2 });
    await restarted;
    answer({ status: "answer", text: "지연 답변" });
    await tick();
    assert.deepEqual(writes(children[1]), []);
  } finally {
    if (companion.snapshot().running) {
      const stopping = companion.stop();
      children[spawned - 1].exit();
      await stopping;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

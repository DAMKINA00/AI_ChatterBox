import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeConfirmed, pidAlive, shutdown } from "./proc";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver } from "./drivers/codex";
import { GrokDriver } from "./drivers/grok";

/** A real node process that starts a grandchild and prints its pid, then idles. */
function tree(): Promise<{ child: ChildProcess; grandchild: number }> {
  const script = `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(g.pid); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  return new Promise((resolve, reject) => {
    child.stdout!.setEncoding("utf8");
    child.stdout!.once("data", (d: string) => resolve({ child, grandchild: Number(d.trim()) }));
    child.once("error", reject);
  });
}
const gone = async (pid: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  return !pidAlive(pid);
};
/** A process object that never exits by itself. */
function stuck(pid = 4_000_000): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdin: null }) as unknown as ChildProcess;
}

test("[review2 2] confirmed close kills a real process tree and waits until the pids are gone", async () => {
  const { child, grandchild } = await tree();
  assert.equal(pidAlive(child.pid), true); assert.equal(pidAlive(grandchild), true);
  await closeConfirmed(child, { timeoutMs: 8000 });
  assert.notEqual(child.exitCode ?? child.signalCode, null, "exit event observed");
  assert.equal(pidAlive(child.pid), false, "parent pid gone");
  if (process.platform === "win32") assert.equal(await gone(grandchild), true, "taskkill /T took the grandchild too");
  else process.kill(grandchild, "SIGKILL");
  // An already-exited process is confirmed at once.
  await closeConfirmed(child, { timeoutMs: 100 });
});

test("[review2 2] confirmed close rejects when the kill fails, no exit arrives or the pid stays", async () => {
  // Kill request fails and the process does not exit.
  await assert.rejects(closeConfirmed(stuck(), { timeoutMs: 80, kill: async () => { throw new Error("access denied"); }, alive: () => true }), /강제 종료 실패 후 프로세스가 남아 있습니다: access denied/);
  // Kill "succeeds" but no exit event: unconfirmed.
  await assert.rejects(closeConfirmed(stuck(), { timeoutMs: 80, kill: async () => {}, alive: () => true }), /종료 응답이 없습니다/);
  // Exit event, but the pid is still there past the deadline.
  const lingering = stuck();
  await assert.rejects(closeConfirmed(lingering, { timeoutMs: 120, alive: () => true, kill: async c => { Object.assign(c, { exitCode: 1 }); c.emit("exit", 1); } }), /PID 4000000\)가 아직 남아 있습니다/);
  // A failed kill request is fine when the process really did exit.
  const exits = stuck();
  await closeConfirmed(exits, { timeoutMs: 500, alive: () => false, kill: async c => { setTimeout(() => { Object.assign(c, { exitCode: 1 }); c.emit("exit", 1); }, 10); throw new Error("not found"); } });
  // Without a pid there is nothing to verify.
  await assert.rejects(closeConfirmed(Object.assign(stuck(), { pid: undefined }), { timeoutMs: 50 }), /프로세스 ID를 확인할 수 없어/);
});

test("[review2 2] the ordinary shutdown used by fixed/auto stays unchanged (resolves after the grace kill without confirming)", async () => {
  const child = stuck();
  // Resolves after its grace timer and kill attempt even though no exit ever arrives (no confirmation).
  await shutdown(child, 30);
  assert.equal(child.exitCode, null);
});

test("[review2 2] Claude closeStrict confirms every started process and retries those still alive", async () => {
  const driver = Object.create(ClaudeDriver.prototype) as any;
  Object.assign(driver, { processes: new Set<ChildProcess>(), pendingSteers: new Set(), env: { bridge: { unregister() {} } } });
  const { child, grandchild } = await tree();
  const lingering = stuck(child.pid! + 1_000_000);
  driver.processes.add(child); driver.processes.add(lingering);
  // The stuck one cannot be confirmed (its kill fails and no exit arrives): reject, keep it for the next attempt.
  await assert.rejects(driver.closeStrict());
  assert.equal(driver.processes.has(lingering), true);
  assert.equal(driver.processes.has(child), false, "the real process was confirmed and dropped");
  assert.equal(pidAlive(child.pid), false);
  if (process.platform === "win32") assert.equal(await gone(grandchild), true); else process.kill(grandchild, "SIGKILL");
  Object.assign(lingering, { exitCode: 0 }); // it has exited now
  await driver.closeStrict();
  assert.equal(driver.processes.size, 0);
  assert.equal(driver.running, false);
});

test("[review2 2] Grok closeStrict confirms each connection and keeps unconfirmed ones", async () => {
  const driver = Object.create(GrokDriver.prototype) as any;
  let fail = true;
  const connection = { closeConfirmed: async () => { if (fail) throw new Error("still alive"); }, notify() {} };
  Object.assign(driver, { epoch: 0, _running: false, connection, connections: new Set([connection]), host: { emit() {} }, nativeId: "s" });
  await assert.rejects(driver.closeStrict(), /still alive/);
  assert.equal(driver.connections.size, 1);
  assert.equal(driver.connection, undefined, "no further turns go to the old connection");
  fail = false;
  await driver.closeStrict();
  assert.equal(driver.connections.size, 0);
});

test("[review2 2] Codex closeStrict requires a confirmed turn stop and thread release on the shared server", async () => {
  const make = (server: any, running = false) => {
    const driver = Object.create(CodexDriver.prototype) as any;
    Object.assign(driver, { _running: running, threadId: "t1", server, turnWaiters: [], host: { emit() {} } });
    return driver;
  };
  const calls: string[] = [];
  const server = { processAlive: true, loaded: new Set(["t1"]), request: async (m: string) => { calls.push(m); return {}; }, detach() { calls.push("detach"); }, dispose: async () => { calls.push("server.dispose"); } };
  await make(server).closeStrict();
  assert.deepEqual(calls, ["thread/unsubscribe", "detach"], "released by the server, the shared process is left running");
  // The server rejects the release: unconfirmed.
  const refusing = { ...server, loaded: new Set(["t1"]), request: async () => { throw new Error("thread busy"); } };
  await assert.rejects(make(refusing).closeStrict(), /thread busy/);
  // A server that already exited needs no request.
  calls.length = 0;
  await make({ ...server, processAlive: false, loaded: new Set(["t1"]) }).closeStrict();
  assert.deepEqual(calls, ["detach"]);
  // [review3 1] A late release answer holds the switch: the shared server (and a sibling thread on it) is
  // never closed, and the thread stays attached for a retry.
  const shared = { processAlive: true, loaded: new Set(["t1", "sibling"]), request: () => new Promise(() => {}), detach() { calls.push("detach"); }, dispose: async () => { calls.push("server.dispose"); } };
  calls.length = 0;
  const started = Date.now();
  await assert.rejects(make(shared).closeStrict(30), /제한 시간 안에 받지 못했습니다.*공유 서버는 유지/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(calls, [], "no server.dispose, no detach");
  assert.deepEqual([...shared.loaded], ["t1", "sibling"]);
  // A turn that does not stop in time is unconfirmed.
  const busy = make({ ...server, loaded: new Set(["t1"]) }, true);
  busy.recover = async () => { throw new Error("Codex 작업 중지 완료를 확인하지 못했습니다."); };
  await assert.rejects(busy.closeStrict(), /중지 완료를 확인하지 못했습니다/);
});

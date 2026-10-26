import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-worker-recovery-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const events: any[] = [], sent: any[] = [];
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event(e) { events.push(e.event); } }, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const instruction = { id: 1, text: "keep original scope", mode: "delegated", asks: 2, reviews: 0, requests: new Map(), queued: [], pinned: [] };
  engine.instructions.set(chat.id, instruction);
  const worker = store.createAgent(chat.id, "claude", "implementation");
  const failed = store.createConsult(chat.id, "orch", worker.key, "implement", "fix existing task", ["src/**"], 1, "original assignment");
  store.finishConsult(failed.id, "error", "provider connection failed", ["src/kept.ts"]);
  const master = { running: false, agent: "codex" as const, send: async (input: any) => { sent.push(input); }, stop: async () => {}, dispose: async () => {} };
  chats.driver = async () => master;
  return { store, chats, chat, worker, failed, engine, instruction, master, sent, events, async close() {
    engine.stopRecovery(); await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test("idle master receives failed work with original task and supersedes instructions, bounded to three reminders", async () => {
  const f = fixture();
  try {
    await f.engine.sweepWorkerRecovery(100_000);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /fix existing task/);
    assert.match(f.sent[0].text, /supersedes/);
    assert.match(f.sent[0].text, /ask_user/);
    assert.equal(f.engine.instructions.get(f.chat.id), f.instruction);
    assert.equal(f.instruction.asks, 2);
    await f.engine.sweepWorkerRecovery(120_000);
    assert.equal(f.sent.length, 1);
    await f.engine.sweepWorkerRecovery(160_000);
    await f.engine.sweepWorkerRecovery(220_000);
    await f.engine.sweepWorkerRecovery(280_000);
    await f.engine.sweepWorkerRecovery(340_000);
    assert.equal(f.sent.length, 3);
    assert.equal(f.events.filter(e => e.type === "notice" && e.text.includes("세 차례")).length, 1);
    assert.equal(f.store.chat(f.chat.id)?.status, "error");
  } finally { await f.close(); }
});

test("a replacement in progress suppresses duplicate recovery, including after success", async () => {
  const f = fixture();
  try {
    const replacement = f.store.createConsult(f.chat.id, "orch", f.worker.key, "implement", "retry", ["src/**"], 1, "retry", f.failed.id);
    await f.engine.sweepWorkerRecovery(100_000);
    assert.equal(f.sent.length, 0);
    f.store.finishConsult(replacement.id, "done", "fixed", []);
    await f.engine.sweepWorkerRecovery(200_000);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("paused, approval-waiting and user-stopped work never restarts automatically", async () => {
  const f = fixture();
  try {
    for (const status of ["paused", "pausing", "approval"] as const) {
      f.store.updateChat(f.chat.id, { status });
      await f.engine.sweepWorkerRecovery(100_000);
    }
    f.store.updateChat(f.chat.id, { status: "working" });
    f.engine.stopped.add(f.chat.id);
    await f.engine.sweepWorkerRecovery(200_000);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("running master gets a steer instead of a concurrent send", async () => {
  const f = fixture();
  try {
    f.master.running = true;
    let steers = 0;
    Object.assign(f.master, { steer: async () => { steers++; return true; } });
    await f.engine.sweepWorkerRecovery(100_000);
    assert.equal(steers, 1);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("quiet healthy worker is left alone; explicit orphaned error settles after its process is disposed", async () => {
  const f = fixture();
  try {
    let disposals = 0, resolved = 0;
    const driver = { running: true, dispose: async () => { disposals++; driver.running = false; } };
    f.chats.liveDriver = () => driver as any;
    f.chats.disposeRole = async () => {};
    const running = { lastEventAt: 1, recovering: false, resolve: (result: any) => { assert.equal(driver.running, false); assert.equal(result.error, "terminal error"); resolved++; } } as any;
    f.engine.running.set(f.chat.id, new Map([[f.worker.key, running]]));
    await f.engine.sweepWorkerRecovery(100_000);
    assert.equal(disposals, 0);
    running.lastError = "terminal error";
    running.lastEventAt = 100_000;
    await f.engine.sweepWorkerRecovery(159_999);
    assert.equal(disposals, 0);
    await f.engine.sweepWorkerRecovery(160_000);
    assert.equal(disposals, 1);
    assert.equal(resolved, 1);
  } finally { await f.close(); }
});

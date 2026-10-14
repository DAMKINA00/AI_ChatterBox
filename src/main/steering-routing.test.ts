import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";
import { DEFAULT_SETTINGS } from "../shared/types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-steering-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const inst = { id: 1, mode: "delegated", text: "original", asks: 0, reviews: 0, requests: new Map(), queued: [] as any[], pinned: [] as string[] };
  engine.instructions.set(chat.id, inst);
  store.updateChat(chat.id, { status: "working" });
  return { store, chat, chats, engine, inst, async close() { await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("immediate input steers the same master, preserves workers, and records delivery and time", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "analysis");
    let sent = "";
    f.chats.liveDriver = () => ({ agent: "claude", running: true, steer: async (input) => { sent = input.text; return true; }, send: async () => { throw new Error("must not start a second master"); }, stop: async () => {}, dispose: async () => {} });
    const before = Date.now();
    await f.chats.send(f.chat.id, "new constraint", [], "now");
    assert.match(sent, /new constraint/);
    assert.equal(f.inst.queued.length, 0);
    assert.match(f.inst.text, /new constraint/);
    assert.deepEqual(f.store.listAgents(f.chat.id).map((a) => a.key), [worker.key]);
    const event = f.store.events(f.chat.id).find((e) => e.event.type === "user")!;
    assert.ok(event.at >= before);
    assert.equal(event.event.type === "user" && event.event.delivery, "now");
  } finally { await f.close(); }
});

test("unsupported native steering preserves next-step input; stop during receipt never starts another turn", async () => {
  const f = fixture();
  try {
    const driver: any = { agent: "claude", running: true, steer: async () => false, send: async () => { throw new Error("unexpected turn"); } };
    f.chats.liveDriver = () => driver;
    await f.chats.send(f.chat.id, "fallback", [], "now");
    assert.equal(f.inst.queued[0].text, "fallback");
    driver.steer = async () => { f.engine.stopped.add(f.chat.id); driver.running = false; return false; };
    await f.chats.send(f.chat.id, "stopped", [], "now");
    assert.equal(f.inst.queued.length, 1);
    assert.match(f.store.events(f.chat.id).at(-1)!.event.type === "notice" ? (f.store.events(f.chat.id).at(-1)!.event as any).text : "", /중지/);
  } finally { await f.close(); }
});

test("master awaits existing worker results after detached ask, then synthesizes without reassigning", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "analysis");
    const consult = f.store.createConsult(f.chat.id, "orch", worker.key, "opinion", "calculate", [], f.inst.id);
    let finish!: () => void;
    f.engine.workerQueue.set(`${f.chat.id}:${worker.key}`, new Promise<void>((r) => { finish = r; }));
    const inputs: any[] = [];
    f.chats.driver = async () => ({ agent: "claude", running: false, send: async (input) => { inputs.push(input); }, stop: async () => {}, dispose: async () => {} });
    assert.equal(f.engine.checkCompletion(f.chat.id, { type: "turn_end", ok: true }), null);
    assert.equal((f.inst as any).repaired, undefined);
    f.store.finishConsult(consult.id, "done", "sum=42", []);
    finish();
    await new Promise((r) => setImmediate(r));
    assert.equal(inputs.length, 1);
    assert.match(inputs[0].text, /sum=42/);
    assert.equal(f.store.listConsults(f.chat.id).length, 1);
    assert.match((await f.engine.call(f.chat.id, "orch", "agents", {})).content[0].text, /sum=42/);
  } finally { await f.close(); }
});

test("manual stop cancels a pending result-synthesis continuation", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "analysis");
    const consult = f.store.createConsult(f.chat.id, "orch", worker.key, "opinion", "calculate", [], f.inst.id);
    let finish!: () => void;
    f.engine.workerQueue.set(`${f.chat.id}:${worker.key}`, new Promise<void>((r) => { finish = r; }));
    f.chats.driver = async () => { throw new Error("stopped instruction must not restart"); };
    f.engine.checkCompletion(f.chat.id, { type: "turn_end", ok: true });
    await f.engine.stop(f.chat.id);
    f.store.finishConsult(consult.id, "stopped", "stopped", []);
    finish();
    await new Promise((r) => setImmediate(r));
    assert.equal(f.store.events(f.chat.id).length, 0);
    assert.equal((f.inst as any).waitingForResults, false);
  } finally { await f.close(); }
});

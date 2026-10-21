import { test, mock } from "node:test";
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

test("default input immediately steers the same master, preserves workers, and records delivery and time", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "analysis");
    let sent = "";
    f.chats.liveDriver = () => ({ agent: "claude", running: true, steer: async (input) => { sent = input.text; return true; }, send: async () => { throw new Error("must not start a second master"); }, stop: async () => {}, dispose: async () => {} });
    const before = Date.now();
    await f.chats.send(f.chat.id, "new constraint", []);
    assert.match(sent, /new constraint/);
    assert.equal(f.inst.queued.length, 0);
    assert.match(f.inst.text, /new constraint/);
    assert.deepEqual(f.store.listAgents(f.chat.id).map((a) => a.key), [worker.key]);
    const event = f.store.events(f.chat.id).find((e) => e.event.type === "user")!;
    assert.ok(event.at >= before);
    assert.equal(event.event.type === "user" && event.event.delivery, "now");
  } finally { await f.close(); }
});

test("explicit next-step input queues without steering the running master", async () => {
  const f = fixture();
  try {
    f.chats.liveDriver = () => { throw new Error("next-step input must not steer"); };
    await f.chats.send(f.chat.id, "next constraint", [], "next");
    assert.equal(f.inst.queued.length, 1);
    assert.equal(f.inst.queued[0].text, "next constraint");
    assert.equal((f.inst as any).pendingImmediate, undefined);
    const event = f.store.events(f.chat.id).find((e) => e.event.type === "user")!;
    assert.equal(event.event.type === "user" && event.event.delivery, "next");
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

test("immediate direct question does not downgrade delegated work or its independent investigation", async () => {
  const f = fixture();
  try {
    (f.inst as any).dualInvestigation = true;
    const args = { mode: "direct", reason: "이미 알고 있는 설정의 적용 범위 질문", codeWork: false };
    assert.equal((await f.engine.call(f.chat.id, "orch", "route_request", args)).isError, true);
    f.chats.liveDriver = () => ({ running: true, steer: async () => true } as any);
    await f.chats.send(f.chat.id, "750k는 클로드에만 적용하지?", [], "now");
    assert.equal((await f.engine.call(f.chat.id, "orch", "route_request", args)).isError, false);
    assert.equal(f.inst.mode, "delegated");
    assert.equal((f.inst as any).dualInvestigation, true);
    const blocked = await f.engine.call(f.chat.id, "orch", "checklist", { steps: [] });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /먼저 직접 답변/);
    f.engine.observe(f.chat.id, "orch", { type: "text", text: "네, 현재 확인한 설정은 클로드 전용입니다." });
    assert.equal((await f.engine.call(f.chat.id, "orch", "checklist", { steps: [{ title: "기존 작업 계속", status: "inProgress" }] })).isError, false);
    assert.equal((await f.engine.call(f.chat.id, "orch", "route_request", args)).isError, true);
  } finally { await f.close(); }
});

test("immediate input releases parallel master waits without completing or cancelling worker tasks", async () => {
  const f = fixture();
  const completions: (() => void)[] = [];
  let finished = 0;
  try {
    f.engine.askTool = () => new Promise((resolve) => completions.push(() => {
      finished++;
      resolve({ content: [{ type: "text", text: "worker result" }], isError: false });
    }));
    f.chats.liveDriver = () => ({ running: true, steer: async () => true } as any);
    const result = f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [{ to: "one" }, { to: "two" }] });
    await f.chats.send(f.chat.id, "기존 작업을 유지하고 이 질문에 답해줘", [], "now");
    const reply = await result;
    assert.match(reply.content[0].text, /대기만 해제/);
    assert.match(reply.content[0].text, /이 질문에 답해줘/);
    assert.equal(finished, 0);
    assert.equal(f.engine.masterConsultWaiters.size, 0);
    completions.forEach((complete) => complete());
    await new Promise((r) => setImmediate(r));
    assert.equal(finished, 2);
  } finally { completions.forEach((complete) => complete()); await f.close(); }
});

test("older CLI can receive immediate input through its pending app consult result", async () => {
  const f = fixture();
  let complete!: () => void;
  try {
    f.engine.askTool = () => new Promise((resolve) => { complete = () => resolve({ content: [] }); });
    f.chats.liveDriver = () => ({ running: true, steer: async () => false } as any);
    const result = f.engine.call(f.chat.id, "orch", "ask", {});
    await f.chats.send(f.chat.id, "제목을 바꿔줘", [], "now");
    assert.match((await result).content[0].text, /제목을 바꿔줘/);
    assert.equal(f.inst.queued.length, 0);
    assert.equal((f.inst as any).pendingImmediate, true);
  } finally { complete(); await f.close(); }
});

test("stop during accepted steering never releases a new reply task", async () => {
  const f = fixture();
  try {
    f.chats.liveDriver = () => ({ running: true, steer: async () => { f.engine.stopped.add(f.chat.id); return true; } } as any);
    await f.chats.send(f.chat.id, "race", [], "now");
    assert.equal((f.inst as any).pendingImmediate, undefined);
    assert.equal(f.inst.pinned.length, 0);
  } finally { await f.close(); }
});

test("worker activity and queued user messages refresh persisted chat time; deltas are throttled", async () => {
  let now = 100_000;
  const clock = mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    now = 120_000;
    f.chats.emit(f.chat.id, "w1", "w1", { type: "text_delta", text: "working" });
    assert.equal(f.store.chat(f.chat.id)!.lastActiveAt, now);
    now = 120_001;
    f.chats.emit(f.chat.id, "w1", "w1", { type: "text_delta", text: "more" });
    assert.equal(f.store.chat(f.chat.id)!.lastActiveAt, 120_000);
    now = 121_000;
    f.chats.emit(f.chat.id, "w1", "w1", { type: "text", text: "worker progress" });
    assert.equal(f.store.chat(f.chat.id)!.lastActiveAt, now);
    now = 130_000;
    f.chats.emit(f.chat.id, "w1", "w1", { type: "expression", expression: "thinking" });
    assert.equal(f.store.chat(f.chat.id)!.lastActiveAt, 121_000);
    now = 140_000;
    await f.chats.send(f.chat.id, "next step", [], "next");
    assert.equal(f.store.chat(f.chat.id)!.lastActiveAt, now);
  } finally { await f.close(); clock.mock.restore(); }
});

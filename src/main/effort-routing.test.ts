import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";
import { DEFAULT_SETTINGS, type Role } from "../shared/types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-effort-routing-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.models = async (agent) => [{ id: agent === "claude" ? "opus" : agent === "codex" ? "gpt-6-astra" : "gemini-test-medium", label: agent, isDefault: true,
    reasoningEfforts: agent === "gemini" ? ["medium", "high"] : ["medium", "high", "xhigh"] }];
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, { id: 1, mode: "delegated", asks: 0, reviews: 0, startedAt: Date.now(), requests: new Map(), queued: [], pinned: [] });
  const sent: { role: Role; effort?: string }[] = [];
  chats.driver = async (_id, role, effort) => ({ agent: "claude", running: false, stop: async () => {}, dispose: async () => {}, send: async () => {
    sent.push({ role, effort });
    chats.onDriverEvent?.(chat.id, role, { type: "text", text: "verified" });
    chats.onDriverEvent?.(chat.id, role, { type: "turn_end", ok: true });
  } });
  return { store, project, chat, chats, engine, sent, async close() { await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("master defaults to auto; parallel assignments keep separate effort and persist Gemini's supported fallback", async () => {
  const f = fixture();
  try {
    assert.equal((await f.chats.assignmentEffort(f.chat.id, "orch")).effort, "");
    const claude = f.store.createAgent(f.chat.id, "claude", "analyze");
    const gemini = f.store.createAgent(f.chat.id, "gemini", "write dialogue");
    const response = await f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [
      { to: claude.nickname, kind: "opinion", message: "analyze", reason: "bounded analysis: medium", effort: "medium" },
      { to: gemini.nickname, kind: "writing", message: "write dialogue", reason: "complex character voice: xhigh", effort: "xhigh" },
    ] });
    assert.ok(!response.isError);
    assert.deepEqual(f.sent.sort((a, b) => a.role.localeCompare(b.role)), [{ role: claude.key, effort: "medium" }, { role: gemini.key, effort: "high" }]);
    const records = f.store.listConsults(f.chat.id);
    assert.deepEqual(records.map((c) => [c.requestedEffort, c.effort, c.status]), [["medium", "medium", "done"], ["xhigh", "high", "done"]]);
  } finally { await f.close(); }
});

test("missing/out-of-range master effort dispatches nothing; project setting retains master's request", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "analyze");
    for (const effort of [undefined, "low", "max", 1]) {
      assert.equal((await f.engine.call(f.chat.id, "orch", "ask", { to: worker.nickname, kind: "opinion", message: "read", reason: "test", effort })).isError, true);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.listConsults(f.chat.id).length, 0);
    f.store.updateChat(f.chat.id, { claudeEffortOverride: "high" });
    assert.equal((await f.chats.assignmentEffort(f.chat.id, worker.key, "medium")).effort, "medium");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, claudeEffort: "high" } });
    assert.deepEqual(await f.chats.assignmentEffort(f.chat.id, worker.key, "medium"), { requestedEffort: "medium", effort: "high" });
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, claudeEffort: "auto" } });
    assert.equal((await f.chats.assignmentEffort(f.chat.id, worker.key, "medium")).effort, "medium");
  } finally { await f.close(); }
});

test("stop while model capabilities load prevents a queued assignment from starting", async () => {
  const f = fixture();
  try {
    let finish!: (value: any[]) => void;
    f.chats.models = async () => new Promise((r) => { finish = r; });
    const worker = f.store.createAgent(f.chat.id, "claude", "test");
    const pending = f.engine.call(f.chat.id, "orch", "ask", { to: worker.nickname, kind: "opinion", message: "read", reason: "simple", effort: "medium" });
    await new Promise((r) => setImmediate(r));
    f.engine.stopped.add(f.chat.id);
    finish([{ id: "opus", label: "test", reasoningEfforts: ["medium"] }]);
    assert.equal((await pending).isError, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.listConsults(f.chat.id).length, 0);
  } finally { await f.close(); }
});

test("legacy time caps do not stop long-running work; manual stop still interrupts it", async () => {
  const f = fixture();
  try {
    f.store.updateProject(f.project.id, { settings: { ...DEFAULT_SETTINGS, maxMinutes: 1 } as any });
    assert.equal((f.store.project(f.project.id)!.settings as any).maxMinutes, undefined);
    const worker = f.store.createAgent(f.chat.id, "claude", "long task");
    f.engine.instructions.get(f.chat.id).startedAt = Date.now() - 365 * 86400_000;
    let started = false;
    f.chats.driver = async () => {
      const driver = { agent: "claude" as const, running: true, send: async () => { started = true; }, stop: async () => {
        driver.running = false;
        f.chats.onDriverEvent?.(f.chat.id, worker.key, { type: "turn_end", ok: false, interrupted: true });
      }, dispose: async () => {} };
      (f.chats as any).live.set(f.chat.id, { [worker.key]: { driver, agent: "claude", model: "opus", effort: "medium" } });
      return driver;
    };
    const pending = f.engine.call(f.chat.id, "orch", "ask", { to: worker.nickname, kind: "opinion", message: "long task", reason: "medium task", effort: "medium" });
    await new Promise((r) => setImmediate(r));
    assert.equal(started, true);
    await f.engine.stop(f.chat.id);
    await pending;
    assert.equal(f.store.listConsults(f.chat.id)[0].status, "stopped");
  } finally { await f.close(); }
});

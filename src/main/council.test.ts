import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Council, councilDriver, councilModel } from "./council";
import { exploreRepository } from "./council-repository";
import { Orchestrator } from "./orchestrator";
import { DEFAULT_SETTINGS, type AgentKind, type AgentEvent } from "../shared/types";
import type { AgentDriver, DriverHost, DriverOptions } from "./drivers/types";

const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-council-"));
  const store = new Store(join(dir, "test.db"));
  const project = store.createProject("council", dir, DEFAULT_SETTINGS), chat = store.createChat(project.id, "test");
  const events: AgentEvent[] = [];
  const chats = new ChatManager(store, { chat() {}, agents() {}, consult() {}, usage() {}, event(e) { events.push(e.event); } }, dir, "unused");
  chats.cliInfo = () => ["claude", "codex", "gemini", "grok"].map(agent => ({ agent: agent as AgentKind, path: "fixture-only" }));
  chats.models = async agent => [{ id: `${agent}-small-luna`, label: "small", reasoningEfforts: ["low", "high"] }, { id: `${agent}-opus-pro`, label: "large", isDefault: true, reasoningEfforts: ["low", "high"] }];
  const runs: { host: DriverHost; opts: DriverOptions; agent: AgentKind; prompt?: string }[] = [];
  let closes = 0;
  let closeFails = false;
  let behavior = async (host: DriverHost) => { host.emit({ type: "text", text: "짧은 결론과 근거" }); host.emit({ type: "turn_end", ok: true }); };
  const council = new Council(chats, (_chats, choice, opts, host) => {
    const run = { host, opts, agent: choice.agent, prompt: "" }; runs.push(run);
    const driver: AgentDriver = { agent: choice.agent, running: false, send: async input => { run.prompt = input.text; await behavior(host); }, stop: async () => {}, dispose: async () => {} };
    return { driver, close: async () => { closes++; if (closeFails) throw new Error("fixture close failed"); } };
  });
  t.after(async () => { await council.dispose(); await chats.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, project, chat, chats, events, runs, council, get closes() { return closes; }, failClose(value: boolean) { closeFails = value; }, behave(fn: typeof behavior) { behavior = fn; } };
}

test("one-shot consult uses only supplied context, no native session, denied tools and bounded output", async t => {
  const f = fixture(t);
  f.behave(async host => {
    assert.equal((await host.approve({ title: "Read", key: "Read", detail: "secret", readOnly: true })).verdict, "deny");
    host.nativeId("must-not-persist");
    host.emit({ type: "text", text: "결론".repeat(1200) }); host.emit({ type: "turn_end", ok: true });
  });
  const result = await f.council.run(f.chat.id, "council_consult", { question: "선택 기준?", context: "제공한 문맥" });
  assert.equal(result.model, "claude-opus-pro");
  assert.equal(result.text.length, 1500); assert.equal(result.truncated, true);
  assert.equal(f.runs[0].opts.readOnly, true); assert.equal(f.runs[0].opts.ephemeral, true);
  assert.equal(f.runs[0].opts.nativeId, null); assert.notEqual(f.runs[0].opts.cwd, f.project.folder);
  assert.match(f.runs[0].prompt!, /제공한 문맥/);
  assert.equal(f.store.chat(f.chat.id)!.orchClaudeSessionId, null);
  assert.equal(f.store.listAgents(f.chat.id).length, 0); assert.equal(f.store.listConsults(f.chat.id).length, 0);
  assert.equal(f.closes, 1);
});

test("explore literal search, grep and docs preserve evidence and never follow a junction", async t => {
  const f = fixture(t), outside = join(f.dir, "outside"), projectDir = join(f.dir, "project");
  mkdirSync(outside); mkdirSync(projectDir); mkdirSync(join(projectDir, "node_modules"));
  writeFileSync(join(projectDir, "code.ts"), "first\nconst needle = 1;\n");
  writeFileSync(join(projectDir, "guide.md"), "# Guide\nneedle 설명\n");
  writeFileSync(join(projectDir, ".env"), "needle credential");
  writeFileSync(join(projectDir, "credentials.json"), "needle credential");
  writeFileSync(join(projectDir, "node_modules", "large.js"), "needle dependency");
  writeFileSync(join(outside, "outside.txt"), "needle outside");
  symlinkSync(outside, join(projectDir, "linked"), process.platform === "win32" ? "junction" : "dir");
  const signal = new AbortController().signal;
  const found = await exploreRepository(projectDir, "needle", "grep", signal);
  assert.deepEqual(found.evidence.map(e => [e.path, e.line]), [["code.ts", 2], ["guide.md", 2]]);
  assert.ok(found.coverage.skipped >= 3);
  assert.deepEqual((await exploreRepository(projectDir, "needle", "docs", signal)).evidence.map(e => e.path), ["guide.md"]);
  assert.deepEqual((await exploreRepository(projectDir, "code ts", "search", signal)).evidence.map(e => e.path), ["code.ts"]);
  assert.equal((await exploreRepository(projectDir, ".*", "grep", signal)).evidence.length, 0);
  assert.equal(readFileSync(join(projectDir, "code.ts"), "utf8"), "first\nconst needle = 1;\n");
});

test("explore prefers an actually offered small model and reports bounded, partial evidence", async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "code.ts"), Array.from({ length: 40 }, (_, i) => `needle ${i} ${"x".repeat(200)}`).join("\n"));
  const result = await f.council.run(f.chat.id, "council_explore", { query: "needle", kind: "grep" });
  assert.equal(result.model, "codex-small-luna");
  assert.equal(result.evidence?.[0].line, 1);
  assert.equal(result.coverage?.limited, true);
  assert.ok(JSON.stringify(result).length <= 6000);
  assert.ok(f.runs[0].prompt!.length < 12000);
});

test("empty search skips model execution; cancellation and invalid inputs fail explicitly", async t => {
  const f = fixture(t);
  const result = await f.council.run(f.chat.id, "council_explore", { query: "unmatched-file", kind: "search" });
  assert.equal(result.model, null); assert.equal(f.runs.length, 0);
  for (const args of [{ question: "" }, { question: "x".repeat(2001) }, { question: "x", context: "x".repeat(8001) }, { question: "x", model: "invented:model" }])
    await assert.rejects(f.council.run(f.chat.id, "council_consult", args));
  const c = new AbortController(); c.abort();
  await assert.rejects(exploreRepository(f.dir, "x", "grep", c.signal));
});

test("explicit model and fixed accounts are respected; disabled/exhausted models are not substituted", async t => {
  const f = fixture(t);
  f.chats.assertCliAccount = () => ({ accountId: "claude-1", enabled: true, remainingPercent: 0 }) as any;
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "x", model: "claude:claude-opus-pro" }), /한도 도달/);
  assert.equal(f.runs.length, 0);
  assert.equal(councilModel([{ id: "hidden-mini", label: "x", hidden: true }, { id: "available", label: "x" }], true)?.id, "available");
});

test("Gemini helpers accept writing only and no helper is counted as an independent review", async t => {
  const f = fixture(t);
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "review", model: "gemini:gemini-opus-pro" }), /글쓰기|문장/);
  const result = await f.council.run(f.chat.id, "council_consult", { question: "대사 다듬기", purpose: "writing", model: "gemini:gemini-opus-pro" });
  assert.equal(result.provider, "gemini");
  assert.equal(f.store.listConsults(f.chat.id).length, 0);
});

test("stop during model discovery cannot start a late driver", async t => {
  const f = fixture(t);
  let resolve!: (v: any) => void;
  f.chats.models = () => new Promise(r => { resolve = r; });
  const work = f.council.run(f.chat.id, "council_consult", { question: "x" });
  const rejected = assert.rejects(work, /중지/);
  await tick(); await f.council.cancel(f.chat.id); await rejected;
  resolve([{ id: "late", label: "late" }]); await tick();
  assert.equal(f.runs.length, 0);
});

test("active helper cancels on chat stop/account change; empty or failed output is never success", async t => {
  const f = fixture(t);
  f.behave(async () => {});
  const work = f.council.run(f.chat.id, "council_consult", { question: "x" });
  const rejected = assert.rejects(work, /중지/);
  while (!f.runs.length) await tick();
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "duplicate" }), /진행 중/);
  await f.chats.releaseAccountJudges!("claude-1"); await rejected;
  assert.equal(f.closes, 1);
  f.behave(async host => { host.emit({ type: "turn_end", ok: true }); });
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "empty" }), /빈 답변/);
  f.behave(async host => { host.emit({ type: "text", text: "partial" }); host.emit({ type: "turn_end", ok: false, error: "fixture failure" }); });
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "failure" }), /fixture failure/);
});

test("all provider adapters use isolated read-only drivers; Claude advertises no tools", async t => {
  const f = fixture(t);
  const host: DriverHost = { nativeId() {}, emit() {}, approve: async () => ({ verdict: "deny" }) };
  for (const agent of ["claude", "codex", "gemini", "grok", "deepseek"] as const) {
    const connection = councilDriver(f.chats, { agent, model: "fixture", effort: "" }, { cwd: f.dir, exePath: "unused", nativeId: null, readOnly: true, ephemeral: true }, host);
    const driver = connection.driver as any;
    assert.equal(driver.opts.readOnly, true); assert.equal(driver.opts.nativeId, null);
    if (agent === "claude") { assert.deepEqual(driver.env.tools, []); assert.equal(driver.env.strictMcp, true); assert.equal(driver.env.disableHooks, true); }
    await connection.close();
  }
});

test("bridge advertises both helper tools and rejects stopped or unassigned callers", async t => {
  const f = fixture(t), engine = new Orchestrator(f.chats) as any;
  let tools: any[] = [];
  f.chats.bridge.register = ((definition: any) => { tools = definition.tools; return { key: "test", url: "http://127.0.0.1/test" }; }) as any;
  engine.bridgeFor(f.chat.id, "orch");
  assert.ok(tools.some(t => t.name === "council_consult")); assert.ok(tools.some(t => t.name === "council_explore"));
  engine.instructions.set(f.chat.id, { id: 1, text: "fixture", asks: 0, reviews: 0, requests: new Map(), pendingImmediate: true, queued: [], pinned: [] });
  const immediate = await engine.call(f.chat.id, "orch", "council_consult", { question: "x" });
  assert.equal(immediate.isError, true);
  assert.match(immediate.content[0].text, /먼저 직접 답변/);
  engine.instructions.delete(f.chat.id);
  assert.equal((await engine.call(f.chat.id, "w999", "council_consult", { question: "x" })).isError, true);
  await engine.stop(f.chat.id);
  assert.equal((await engine.call(f.chat.id, "orch", "council_consult", { question: "x" })).isError, true);
  await engine.council.dispose(); await engine.judge.dispose();
});

test("timeout closes the helper and releases its account", async t => {
  const f = fixture(t);
  f.behave(async () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = f.council.run(f.chat.id, "council_consult", { question: "x" });
  const rejection = assert.rejects(work, /120초/);
  while (!f.runs.length) await tick();
  assert.equal(f.chats.getCliAccount("claude-1")!.runningWorkers, 1);
  t.mock.timers.tick(120001); await rejection;
  assert.equal(f.closes, 1);
  assert.equal(f.chats.getCliAccount("claude-1")!.runningWorkers, 0);
});

test("failed process cleanup keeps account held and blocks another helper until cleanup succeeds", async t => {
  const f = fixture(t);
  f.failClose(true);
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "x" }), /close failed/);
  assert.equal(f.chats.getCliAccount("claude-1")!.runningWorkers, 1);
  await assert.rejects(f.council.run(f.chat.id, "council_consult", { question: "another" }), /진행 중/);
  f.failClose(false);
  await f.council.cancel(f.chat.id);
  assert.equal(f.chats.getCliAccount("claude-1")!.runningWorkers, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, GEMINI_WEB_MODEL, type GeminiWebAccountStatus, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";
import type { AgentInput } from "./drivers/types";
import { geminiBridgeTool } from "./drivers/gemini-protocol";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-master-accounts-")), path = join(root, "test.db");
  const store = new Store(path);
  const project = store.createProject("accounts", root, { ...DEFAULT_SETTINGS, geminiModel: GEMINI_WEB_MODEL, maxGeminiWorkers: 10 });
  const chat = store.createChat(project.id, "accounts");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.cliInfo = () => [];
  const accounts: GeminiWebAccountStatus[] = Array.from({ length: 7 }, (_, i) => ({
    accountId: `gemini-${i + 1}` as GeminiWebAccountStatus["accountId"], label: `웹 계정 ${i + 1}`, enabled: true,
    state: "ready", message: "확인됨", checkedAt: Date.now(), remainingPercent: i === 0 ? 0 : 90 - i * 5,
    usage: { status: "available", detail: "실측", checkedAt: Date.now(), current: { usedPercent: i === 0 ? 100 : 10 + i * 5 }, weekly: { usedPercent: 5 } },
  }));
  let inspections = 0;
  const pool = { list: () => structuredClone(accounts), inspect: async (_signal: AbortSignal, _wait: boolean) => { inspections++; return accounts; } };
  chats.geminiWebAccounts = () => pool as any;
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, { id: 1, mode: "delegated", text: "계정 직접 선택", asks: 0, reviews: 0, startedAt: Date.now(), requests: new Map(), queued: [], pinned: [] });
  const sent: { role: Role; input: AgentInput }[] = [];
  const finish = (role: Role, ok = true, error?: string) => chats.onDriverEvent?.(chat.id, role, { type: "turn_end", ok, error });
  let autoFinish = true;
  chats.driver = async (_id, role) => ({ agent: "gemini", running: false, stop: async () => {}, dispose: async () => {}, send: async input => {
    sent.push({ role, input });
    if (role === "orch") return;
    if (input.webAccountId) {
      chats.onDriverEvent?.(chat.id, role, { type: "notice", text: "실제 연결", webAccountId: input.webAccountId });
      store.updateAgent(store.agentByKey(chat.id, role)!.id, { sessionId: `web:${input.webAccountId}:/app/actual` });
    }
    chats.onDriverEvent?.(chat.id, role, { type: "text", text: autoFinish ? "완료 응답" : "미완성 초안" });
    if (autoFinish) finish(role);
  } });
  const call = (name: string, args: any = {}, caller: Role = "orch") => engine.call(chat.id, caller, name, args);
  const ask = (nickname: string, extra: any = {}, caller: Role = "orch") => call("ask", { to: nickname, kind: "writing", message: "이야기 계속", reason: "잔여량 확인 후 선택", effort: "medium", ...extra }, caller);
  return { root, path, store, chat, project, chats, engine, accounts, pool, sent, call, ask, finish,
    inspections: () => inspections, hold: () => { autoFinish = false; }, complete: () => { autoFinish = true; },
    async close() { await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const body = (r: any) => r.content.map((c: any) => c.text).join("\n");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("master sees all seven accounts and actual account 4 instead of stale account 1", async () => {
  const f = fixture();
  try {
    const old = f.store.createAgent(f.chat.id, "gemini", "existing");
    f.store.updateAgent(old.id, { sessionId: "web:gemini-4:/app/old" });
    const route = JSON.parse(body(await f.call("route_request", { mode: "delegated", reason: "잔여량 조회" })));
    assert.equal(route.capabilities.gemini.webAccounts.length, 7);
    assert.equal(route.capabilities.gemini.usage, undefined);
    assert.match(route.team, /최근 대화 계정=gemini-4/);
    assert.match(route.team, /마스터 선택 필요/);
    assert.equal(route.capabilities.gemini.webAccounts[3].workers[0].lastConversationAccountId, "gemini-4");
    const list = JSON.parse(body(await f.call("gemini_web_accounts")));
    assert.equal(list.accounts[3].remainingPercent, 75);
    assert.ok(list.accounts[3].usage.checkedAt > 0);
    assert.equal(f.inspections(), 1); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("spawn requires an eligible master-selected account and preserves binding on reopen", async () => {
  const f = fixture();
  try {
    for (const webAccountId of [undefined, "gemini-1", "gemini-10", "gemini-11", "../gemini-2"]) {
      assert.equal((await f.call("spawn", { kind: "gemini", job: "write", webAccountId })).isError, true);
    }
    assert.equal(f.store.listAgents(f.chat.id).length, 0);
    const result = await f.call("spawn", { kind: "gemini", job: "write", webAccountId: "gemini-4" });
    assert.equal(result.isError, false); assert.match(body(result), /gemini-4/);
    const worker = f.store.listAgents(f.chat.id)[0];
    assert.equal(worker.webAccountId, "gemini-4");
    assert.equal(f.sent.length, 0, "spawning never asks a Gemini worker to pick its account");
    const reopened = new Store(f.path);
    try { assert.equal(reopened.agent(worker.id)?.webAccountId, "gemini-4"); } finally { reopened.close(); }
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, false); assert.equal(f.sent[0].input.webAccountId, "gemini-4");
    assert.match(body(reply), /지정 계정=gemini-4 · 실제 실행 계정=gemini-4/);
    assert.match(f.store.listConsults(f.chat.id)[0].responseSummary!, /실제 실행 계정=gemini-4/);
  } finally { await f.close(); }
});

test("legacy unbound worker cannot dispatch until the master chooses; worker cannot choose for peers", async () => {
  const f = fixture();
  try {
    const legacy = f.store.createAgent(f.chat.id, "gemini", "old"), peer = f.store.createAgent(f.chat.id, "claude", "peer");
    f.store.updateAgent(legacy.id, { sessionId: "web:gemini-4:/app/old" });
    assert.equal((await f.ask(legacy.nickname)).isError, true);
    assert.equal((await f.ask(legacy.nickname, { webAccountId: "gemini-2" }, peer.key)).isError, true);
    assert.equal((await f.call("gemini_web_accounts", {}, peer.key)).isError, true);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.ask(legacy.nickname, { webAccountId: "gemini-3" })).isError, false);
    assert.equal(f.sent[0].input.webAccountId, "gemini-3");
  } finally { await f.close(); }
});

test("master assigns different accounts in parallel and cannot rebind a running worker", async () => {
  const f = fixture();
  try {
    await f.call("spawn", { kind: "gemini", job: "part A", webAccountId: "gemini-2" });
    await f.call("spawn", { kind: "gemini", job: "part B", webAccountId: "gemini-4" });
    const [a, b] = f.store.listAgents(f.chat.id); f.hold();
    const request = f.call("ask_parallel", { tasks: [a, b].map(w => ({ to: w.nickname, kind: "writing", message: "part", reason: "distinct accounts", effort: "medium" })) });
    await flush();
    assert.deepEqual(f.sent.map(s => s.input.webAccountId), ["gemini-2", "gemini-4"]);
    const team = body(await f.call("agents"));
    assert.match(team, /현재 실행 계정=gemini-2/); assert.match(team, /현재 실행 계정=gemini-4/);
    assert.equal((await f.ask(a.nickname, { webAccountId: "gemini-5" })).isError, true);
    assert.equal(f.store.agent(a.id)?.webAccountId, "gemini-2");
    f.finish(a.key); f.finish(b.key); assert.equal((await request).isError, false);
  } finally { await f.close(); }
});

test("quota failure with streamed draft reports account and reassigns only on master's next ask", async () => {
  const f = fixture();
  try {
    await f.call("spawn", { kind: "gemini", job: "write", webAccountId: "gemini-4" });
    const a = f.store.listAgents(f.chat.id)[0]; f.hold();
    const first = f.ask(a.nickname); await flush(); f.finish(a.key, false, "잔여 한도 부족; 마스터가 재배정하세요.");
    const failed = await first;
    assert.equal(failed.isError, true); assert.match(body(failed), /미완성 초안/); assert.match(body(failed), /마스터가 재배정/);
    assert.match(body(failed), /실제 실행 계정=gemini-4/); assert.equal(f.sent.length, 1);
    const prior = f.store.listConsults(f.chat.id)[0];
    const next = f.ask(a.nickname, { webAccountId: "gemini-5", supersedes: prior.id });
    await flush(); assert.equal(f.sent[1].input.webAccountId, "gemini-5");
    f.finish(a.key); assert.equal((await next).isError, false);
    assert.equal(f.store.listConsults(f.chat.id)[1].supersedes, prior.id);
  } finally { await f.close(); }
});

test("master availability wait is cancelled by stop and cannot dispatch after it", async () => {
  const f = fixture();
  try {
    f.pool.inspect = (signal, wait) => {
      assert.equal(wait, true);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const waiting = f.call("gemini_web_accounts", { waitForAvailable: true }); await flush();
    await f.engine.stop(f.chat.id);
    assert.equal((await waiting).isError, true); assert.equal(f.engine.webChecks.size, 0);
    assert.equal((await f.call("spawn", { kind: "gemini", job: "write", webAccountId: "gemini-4" })).isError, true);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("Antigravity master recognizes the account tool as an app bridge operation", () => {
  assert.equal(geminiBridgeTool("call_mcp_tool", { ServerName: "chatterbox_bridge", ToolName: "gemini_web_accounts" }), true);
  assert.equal(geminiBridgeTool("mcp__chatterbox_bridge__gemini_web_accounts"), true);
  assert.equal(geminiBridgeTool("call_mcp_tool", { ServerName: "other", ToolName: "gemini_web_accounts" }), false);
});

test("master can retry across several accounts while duplicate protection remains per account", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "gemini", "retry");
    for (const webAccountId of ["gemini-2", "gemini-3", "gemini-4", "gemini-4"])
      assert.equal((await f.ask(a.nickname, { webAccountId })).isError, false);
    assert.equal((await f.ask(a.nickname, { webAccountId: "gemini-4" })).isError, true);
    assert.deepEqual(f.sent.map(s => s.input.webAccountId), ["gemini-2", "gemini-3", "gemini-4", "gemini-4"]);
  } finally { await f.close(); }
});

test("paused assignments persist the master's account and resume with the same binding", async () => {
  const f = fixture();
  try {
    await f.call("spawn", { kind: "gemini", job: "write", webAccountId: "gemini-4" });
    const worker = f.store.listAgents(f.chat.id)[0];
    f.store.updateChat(f.chat.id, { status: "working" }); f.hold();
    const pending = f.ask(worker.nickname); await flush();
    f.chats.stop = async () => f.finish(worker.key, false, "일시 정지");
    await f.engine.pause(f.chat.id); await pending;
    const saved = JSON.parse(f.store.getSetting(`pause:${f.chat.id}`)!);
    assert.equal(saved.assignments[0].target.webAccountId, "gemini-4");
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");
    f.complete(); await f.engine.resume(f.chat.id); await flush();
    const requests = f.sent.filter(s => s.role === worker.key);
    assert.equal(requests.length, 2, JSON.stringify(f.store.events(f.chat.id).map(e => e.event))); assert.equal(requests[1].input.webAccountId, "gemini-4");
  } finally { await f.close(); }
});

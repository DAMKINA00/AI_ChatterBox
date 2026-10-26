import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Role, type CliAccountId, type CliAccountKind } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-orchestrator-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("CLI accounts", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "accounts");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.cliInfo = () => ["claude", "codex", "grok"].map(agent => ({ agent, path: "fake.exe" })) as any;
  chats.assignmentEffort = async (_chatId, _role, requested) => ({ requestedEffort: requested ?? "medium", effort: requested ?? "medium" });
  chats.teamCapabilities = async () => ({ claude: { installed: true }, gpt: { installed: true }, grok: { installed: true }, gemini: {} }) as any;
  const sent: { role: Role; accountId: CliAccountId | undefined; input: any }[] = [];
  let autoFinish = true;
  const finish = (role: Role, ok = true, error?: string) => {
    const live = (chats as any).live.get(chat.id)?.[role];
    if (live) live.driver.running = false;
    chats.onDriverEvent!(chat.id, role, { type: "turn_end", ok, error });
  };
  chats.driver = async (_id, role) => {
    const accountId = chats.roleAccount(chat.id, role)?.accountId;
    const driver = { agent: "codex" as const, running: false, stop: async () => finish(role, false, "stopped"), dispose: async () => {}, send: async (input: any) => {
      driver.running = true;
      sent.push({ role, accountId, input });
      if (accountId) store.updateAgent(store.agentByKey(chat.id, role)!.id, { sessionAccountId: accountId });
      chats.onDriverEvent!(chat.id, role, { type: "text", text: "verified" });
      if (autoFinish) finish(role);
    } };
    const slot = (chats as any).live.get(chat.id) ?? {};
    slot[role] = { driver, agent: "codex", accountId };
    (chats as any).live.set(chat.id, slot);
    return driver;
  };
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, { id: 1, mode: "delegated", text: "CLI accounts", asks: 0, reviews: 0, startedAt: Date.now(), requests: new Map(), queued: [], pinned: [] });
  const call = (name: string, args: any = {}, caller: Role = "orch") => engine.call(chat.id, caller, name, args);
  const ask = (nickname: string, extra: any = {}) => call("ask", { to: nickname, kind: "opinion", message: "review", reason: "bounded verification", effort: "medium", ...extra });
  const add = (kind: CliAccountKind) => { chats.createCliAccount(kind); return chats.listCliAccounts(kind).at(-1)!.accountId; };
  return { root, store, project, chat, chats, engine, call, ask, add, sent, finish,
    hold: () => { autoFinish = false; }, complete: () => { autoFinish = true; },
    async close() { await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const body = (r: any) => r.content.map((c: any) => c.text).join("\n");

test("CLI account schemas reach spawn, ask and parallel tasks without replacing webAccountId", async () => {
  const f = fixture();
  try {
    let tools: any[] = [];
    f.chats.bridge.register = (registration: any, key: string) => { tools = registration.tools; return { key, url: "http://127.0.0.1/fake" }; };
    f.engine.bridgeFor(f.chat.id, "orch");
    const tool = (name: string) => tools.find(t => t.name === name);
    const schemas = [tool("spawn").inputSchema.properties, tool("ask").inputSchema.properties, tool("ask_parallel").inputSchema.properties.tasks.items.properties];
    for (const schema of schemas) {
      assert.equal(schema.accountId.type, "string");
      assert.equal(schema.clearAccountId.type, "boolean");
      const pattern = new RegExp(schema.accountId.pattern);
      for (const id of ["claude-1", "gpt-10", "grok-9"]) assert.equal(pattern.test(id), true);
      for (const id of ["gpt-0", "gpt-11", "gpt-01", "codex-1", "gemini-1", "../gpt-1"]) assert.equal(pattern.test(id), false);
      assert.ok(schema.webAccountId);
    }
    assert.deepEqual(tool("cli_accounts").inputSchema.properties.kind.enum, ["claude", "gpt", "grok"]);
    assert.equal(tool("cli_accounts").inputSchema.additionalProperties, false);
    const checkSchema = (value: any): void => {
      if (!value || typeof value !== "object") return;
      if ("type" in value) assert.equal(typeof value.type, "string", JSON.stringify(value));
      for (const key of ["oneOf", "anyOf", "allOf", "not", "$ref"]) assert.equal(key in value, false, key);
      for (const child of Object.values(value)) checkSchema(child);
    };
    for (const t of tools) checkSchema(t.inputSchema);
    f.engine.bridgeFor(f.chat.id, "w1");
    for (const t of tools) checkSchema(t.inputSchema);
    const rules = f.chats.instructionsFor!(f.chat, f.project, "orch", "codex")!;
    for (const word of ["cli_accounts", "fixed", "auto", "accountId", "supersedes", "10%", "10분", "작업자 번호", "실행 계정", "clearAccountId=true"]) assert.ok(rules.includes(word), word);
    assert.doesNotMatch(rules, /accountId=null/);
  } finally { await f.close(); }
});

test("CLI quota failure stays failed, retains a streamed draft and never dispatches another worker", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "quota");
    let sends = 0;
    f.chats.driver = async (_chatId, role) => ({ agent: "claude", running: false, stop: async () => {}, dispose: async () => {}, send: async () => {
      sends++;
      f.chats.onDriverEvent!(f.chat.id, role, { type: "text", text: "preserved draft" });
      f.chats.onDriverEvent!(f.chat.id, role, { type: "error", kind: "process", message: "rate_limit_exceeded" });
      f.chats.onDriverEvent!(f.chat.id, role, { type: "turn_end", ok: false });
    } });
    const result = await f.call("ask", { to: worker.nickname, kind: "opinion", message: "read", reason: "bounded review", effort: "medium" });
    assert.equal(result.isError, true);
    assert.match(body(result), /CLI 한도 소진/);
    assert.match(body(result), /preserved draft/);
    assert.match(body(result), /supersedes/);
    assert.equal(sends, 1);
    assert.equal(f.store.listConsults(f.chat.id)[0].status, "error");
  } finally { await f.close(); }
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("explicit IDs reject wrong families, malformed, missing, disabled and signed-out accounts before dispatch", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    f.chats.updateCliAccount("gpt-2", { enabled: false });
    f.chats.cliAccounts().setAuth("gpt-3", { loggedIn: false, checkedAt: Date.now() });
    const ids: unknown[] = ["claude-1", "gpt-0", "gpt-11", "../gpt-1", 1, "gpt-10", "gpt-2", "gpt-3"];
    for (const accountId of ids) assert.equal((await f.call("spawn", { kind: "gpt", job: "read", accountId })).isError, true, String(accountId));
    assert.equal(f.store.listAgents(f.chat.id).length, 0);
    const a = f.store.createAgent(f.chat.id, "gpt", "review");
    for (const accountId of ids) assert.equal((await f.ask(a.nickname, { accountId })).isError, true, String(accountId));
    const parallel = await f.call("ask_parallel", { tasks: [{ to: a.nickname, kind: "opinion", message: "read", reason: "test", effort: "medium", accountId: "claude-1" }] });
    assert.equal(parallel.isError, true);
    assert.match(body(parallel), /계열 계정이 아닙니다/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.listConsults(f.chat.id).length, 0);
    assert.equal(f.store.agent(a.id)!.cliAccountId, undefined);
    assert.equal((await f.call("spawn", { kind: "gemini", job: "read", accountId: "gpt-1" })).isError, true);
  } finally { await f.close(); }
});

test("cli_accounts reports fresh minima, stale unknowns, auth, workers and policies; refresh is explicit and filtered", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("grok");
    const now = Date.now();
    f.chats.cliAccounts().setUsage("gpt-2", { fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 60 } }, false, now);
    f.chats.cliAccounts().setUsage("grok-2", { fiveHour: { usedPercent: 10 } }, false, now - 600_001);
    f.chats.cliAccounts().setAuth("gpt-2", { loggedIn: true, checkedAt: now });
    f.chats.setCliAccountPolicy({ claude: { mode: "fixed", accountId: "claude-1" } });
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { gpt: { mode: "auto" } } } });
    const refreshed: Array<CliAccountId | undefined> = [];
    f.chats.refreshCliAccount = async id => { refreshed.push(id); return f.chats.listCliAccounts(); };
    const info = JSON.parse(body(await f.call("cli_accounts")));
    const gpt = info.accounts.find((a: any) => a.accountId === "gpt-2");
    assert.equal(gpt.remainingPercent, 40); assert.equal(gpt.checkedAt, now);
    assert.equal(gpt.authStatus, "authenticated"); assert.equal(gpt.authCheckedAt, now);
    assert.equal(gpt.enabled, true); assert.equal(gpt.configDir, undefined);
    assert.equal(info.accounts.find((a: any) => a.accountId === "grok-2").remainingPercent, null);
    assert.equal(info.policies.gpt.mode, "auto"); assert.equal(info.policies.gpt.source, "project");
    assert.equal(info.policies.claude.source, "global"); assert.equal(info.policies.grok.source, "default");
    assert.deepEqual(refreshed, []);
    const filtered = JSON.parse(body(await f.call("cli_accounts", { kind: "gpt", refresh: true })));
    assert.equal(filtered.accounts.length, 2); assert.deepEqual(Object.keys(filtered.policies), ["gpt"]);
    assert.deepEqual(refreshed, ["gpt-1", "gpt-2"]);
    await f.call("cli_accounts", { refresh: true }); assert.equal(refreshed.at(-1), undefined);
    assert.equal((await f.call("cli_accounts", { kind: "codex" })).isError, true);
    assert.equal((await f.call("cli_accounts", { refresh: "true" })).isError, true);
  } finally { await f.close(); }
});

test("project and global fixed policies reject other explicit IDs and override saved bindings", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    const worker = f.store.createAgent(f.chat.id, "gpt", "review");
    f.chats.setWorkerAccount(f.chat.id, worker.key, "gpt-2");
    for (const source of ["project", "global"] as const) {
      f.chats.setCliAccountPolicy({ gpt: { mode: "fixed", accountId: "gpt-1" } });
      f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: source === "project" ? { gpt: { mode: "fixed", accountId: "gpt-1" } } : {} } });
      const spawn = await f.call("spawn", { kind: "gpt", job: "review", accountId: "gpt-2" });
      assert.equal(spawn.isError, true); assert.match(body(spawn), /사용자가 fixed로 지정한 계열입니다.*정책 변경을 사용자에게 요청하세요/);
      assert.equal((await f.ask(worker.nickname, { accountId: "gpt-2" })).isError, true);
      const parallel = await f.call("ask_parallel", { tasks: [{ to: worker.nickname, kind: "opinion", message: "read", reason: "test", effort: "medium", accountId: "gpt-2" }] });
      assert.equal(parallel.isError, true);
      assert.equal(f.store.listAgents(f.chat.id).length, 1);
      assert.equal(f.store.agent(worker.id)!.cliAccountId, "gpt-2", "refusal never mutates an older binding");
      const reply = await f.ask(worker.nickname, { message: source });
      assert.equal(reply.isError, false);
      assert.match(body(reply), /지정 계정=gpt-1 · 실제 실행 계정=gpt-1/);
      assert.ok(body(reply).includes(`모드=fixed · 출처=${source} · 정책 출처=${source}`));
    }
    const same = await f.ask(worker.nickname, { accountId: "gpt-1", message: "same-policy-account" });
    assert.equal(same.isError, false); assert.match(body(same), /출처=global/);
    const route = JSON.parse(body(await f.call("route_request", { mode: "delegated", reason: "accounts" })));
    assert.equal(route.capabilities.gpt.cliAccounts.length, 2);
    assert.equal(route.capabilities.gpt.accountPolicy.source, "global");
    assert.match(route.team, /지정 계정=gpt-1/);
  } finally { await f.close(); }
});

test("parallel tasks carry distinct CLI IDs and a running worker cannot be rebound", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "part A" });
    await f.call("spawn", { kind: "gpt", job: "part B" });
    const [a,b] = f.store.listAgents(f.chat.id); f.hold();
    const pending = f.call("ask_parallel", { tasks: [a,b].map((w,i) => ({ to: w.nickname, kind: "opinion", message: "part", reason: "separate account", effort: "medium", accountId: `gpt-${i+1}` })) });
    await flush();
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    const accounts = JSON.parse(body(await f.call("cli_accounts", { kind: "gpt" }))).accounts;
    assert.equal(accounts[1].runningWorkers, 1); assert.equal(accounts[1].workers[0].nickname, b.nickname);
    const team = body(await f.call("agents")); assert.match(team, /현재 실행 계정=gpt-1/); assert.match(team, /현재 실행 계정=gpt-2/);
    assert.equal((await f.ask(b.nickname, { accountId: "gpt-1" })).isError, true);
    assert.equal(f.store.agent(b.id)!.cliAccountId, "gpt-2");
    f.finish(a.key); f.finish(b.key); assert.equal((await pending).isError, false);
  } finally { await f.close(); }
});

test("auto without an ID follows policy or keeps the worker binding, with no automatic quota retry", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { gpt: { mode: "auto" } } } });
    const spawn = await f.call("spawn", { kind: "gpt", job: "retry" });
    assert.match(body(spawn), /지정 계정=gpt-1/); assert.match(body(spawn), /auto 자동 선택 없음/);
    const worker = f.store.listAgents(f.chat.id)[0]; f.hold();
    const first = f.ask(worker.nickname); await flush(); f.finish(worker.key, false, "usage_limit_reached");
    const failed = await first; assert.equal(failed.isError, true); assert.match(body(failed), /CLI 한도 소진/);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].accountId, "gpt-1");
    const prior = f.store.listConsults(f.chat.id)[0]; f.complete();
    const next = await f.ask(worker.nickname, { accountId: "gpt-2", supersedes: prior.id });
    assert.equal(next.isError, false); assert.equal(f.sent[1].accountId, "gpt-2");
    assert.equal(f.store.listConsults(f.chat.id)[1].supersedes, prior.id);
    assert.equal((await f.ask(worker.nickname, { message: "follow up" })).isError, false);
    assert.equal(f.sent[2].accountId, "gpt-2");
  } finally { await f.close(); }
});

test("single default account keeps the legacy spawn, agents and result text", async () => {
  const f = fixture();
  try {
    const spawn = await f.call("spawn", { kind: "gpt", job: "review" });
    const worker = f.store.listAgents(f.chat.id)[0];
    assert.equal(body(spawn), `${worker.nickname}이(가) 준비되었습니다. ask(to="${worker.nickname}")로 일을 맡기세요. 이전 기록이 있으면 유지됩니다.`);
    assert.equal(body(await f.call("agents")), `- ${worker.nickname} (지피티) · review · 대기`);
    assert.equal((await f.ask(worker.nickname)).isError, false);
    assert.equal(f.store.listConsults(f.chat.id)[0].responseSummary, "verified");
    assert.equal(f.sent[0].accountId, "gpt-1");
    const route = JSON.parse(body(await f.call("route_request", { mode: "delegated", reason: "legacy" })));
    assert.equal(route.capabilities.gpt.cliAccounts, undefined);
    assert.doesNotMatch(route.team, /지정 계정=/);
  } finally { await f.close(); }
});

test("pre-start failure never reports a previous session as the actual execution account", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "failure", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0];
    f.store.updateAgent(worker.id, { sessionAccountId: "gpt-1" });
    f.chats.driver = async () => { throw new Error("missing CLI"); };
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, true); assert.match(body(reply), /지정 계정=gpt-2 · 실제 실행 계정=연결 전 실패\/중지/);
    assert.doesNotMatch(body(reply), /실제 실행 계정=gpt-1/);
  } finally { await f.close(); }
});

test("workers cannot choose CLI accounts and a stopped refresh returns no actionable data", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "caller"), b = f.store.createAgent(f.chat.id, "gpt", "peer");
    assert.equal((await f.call("cli_accounts", {}, a.key)).isError, true);
    assert.equal((await f.call("ask", { to: b.nickname, kind: "opinion", message: "read", accountId: "gpt-1" }, a.key)).isError, true);
    let release!: () => void;
    f.chats.refreshCliAccount = async () => { await new Promise<void>(r => { release = r; }); return f.chats.listCliAccounts(); };
    const pending = f.call("cli_accounts", { refresh: true }); await flush();
    f.engine.stopped.add(f.chat.id); release();
    const reply = await pending;
    assert.equal(reply.isError, true); assert.doesNotMatch(body(reply), /remainingPercent/);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});


test("saved explicit bindings are revalidated after logout or disable", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "saved", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0];
    f.chats.updateCliAccount("gpt-2", { enabled: false });
    assert.match(body(await f.ask(worker.nickname)), /배정에서 제외/);
    f.chats.updateCliAccount("gpt-2", { enabled: true });
    f.chats.cliAccounts().setAuth("gpt-2", { loggedIn: false, checkedAt: Date.now() });
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, true); assert.match(body(reply), /로그인되어 있지 않습니다/);
    assert.equal(f.store.agent(worker.id)!.cliAccountId, "gpt-2");
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("result reports the policy applied at execution even if settings change mid-turn", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { gpt: { mode: "fixed", accountId: "gpt-2" } } } });
    await f.call("spawn", { kind: "gpt", job: "snapshot", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0]; f.hold();
    const pending = f.ask(worker.nickname); await flush();
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: {} } });
    f.chats.setCliAccountPolicy({ gpt: { mode: "auto" } });
    f.finish(worker.key);
    const reply = await pending;
    assert.equal(reply.isError, false);
    assert.match(body(reply), /모드=fixed · 출처=project · 정책 출처=project/);
    assert.match(body(reply), /실제 실행 계정=gpt-2/);
    assert.match(body(await f.call("agents")), /모드=auto · 출처=explicit · 정책 출처=global/);
  } finally { await f.close(); }
});


test("clearAccountId clears through spawn, ask and parallel; release and legacy null remain supported", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "bound", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0];
    assert.equal((await f.ask(worker.nickname, { clearAccountId: true })).isError, false);
    assert.equal(f.store.agent(worker.id)!.cliAccountId, undefined); assert.equal(f.sent[0].accountId, "gpt-1");
    await f.ask(worker.nickname, { accountId: "gpt-2", message: "bind again" });
    const parallel = await f.call("ask_parallel", { tasks: [{ to: worker.nickname, kind: "opinion", message: "clear in parallel", reason: "reset", effort: "medium", clearAccountId: true }] });
    assert.equal(parallel.isError, false); assert.equal(f.store.agent(worker.id)!.cliAccountId, undefined);
    f.chats.setWorkerAccount(f.chat.id, worker.key, "gpt-2");
    const changes: Array<CliAccountId | null> = [];
    const set = f.chats.setWorkerAccount.bind(f.chats);
    f.chats.setWorkerAccount = (chatId, role, id) => { changes.push(id); set(chatId, role, id); };
    assert.equal((await f.call("release", { nickname: worker.nickname })).isError, false);
    assert.equal(changes.at(-1), null); assert.equal(f.store.agent(worker.id)!.cliAccountId, undefined);
    const spawn = await f.call("spawn", { kind: "gpt", job: "reused", clearAccountId: true });
    assert.equal(spawn.isError, false); assert.equal(changes.at(-1), null);
    assert.equal(f.store.listAgents(f.chat.id)[0].id, worker.id);
    assert.equal(f.chats.roleAccount(f.chat.id, worker.key)!.accountId, "gpt-1");
    f.chats.setWorkerAccount(f.chat.id, worker.key, "gpt-2");
    assert.equal((await f.ask(worker.nickname, { accountId: null, message: "legacy clear" })).isError, false);
    assert.equal(f.store.agent(worker.id)!.cliAccountId, undefined);
  } finally { await f.close(); }
});

test("consult, review, planning and duplicate limits never persist refused account changes or clears", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "bound", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0], inst = f.engine.instructions.get(f.chat.id);
    for (const change of [{ accountId: "gpt-1" }, { clearAccountId: true }]) {
      inst.asks = f.project.settings.maxConsults;
      assert.equal((await f.ask(worker.nickname, change)).isError, true);
      inst.asks = 0; inst.reviews = f.project.settings.maxReviews;
      assert.equal((await f.ask(worker.nickname, { kind: "review", ...change })).isError, true);
      inst.reviews = 0; f.engine.planning.add(f.chat.id);
      assert.equal((await f.ask(worker.nickname, change)).isError, true);
      f.engine.planning.clear();
      assert.equal(f.store.agent(worker.id)!.cliAccountId, "gpt-2");
    }
    assert.equal(f.sent.length, 0);
    for (let i = 0; i < 2; i++) assert.equal((await f.ask(worker.nickname, { accountId: "gpt-1", message: "duplicate" })).isError, false);
    f.chats.setWorkerAccount(f.chat.id, worker.key, "gpt-2");
    for (const change of [{ accountId: "gpt-1" }, { clearAccountId: true }]) {
      assert.equal((await f.ask(worker.nickname, { ...change, message: "duplicate" })).isError, true);
      assert.equal(f.store.agent(worker.id)!.cliAccountId, "gpt-2");
    }
    assert.equal(f.sent.length, 2);
  } finally { await f.close(); }
});

test("default accounts validate confirmed logout while unknown login keeps legacy dispatch", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "gpt", "default");
    f.chats.cliAccounts().setAuth("gpt-1", { loggedIn: false, checkedAt: Date.now() });
    const failed = await f.ask(worker.nickname);
    assert.equal(failed.isError, true); assert.match(body(failed), /로그인되어 있지 않습니다/);
    assert.equal(f.sent.length, 0);
    f.chats.cliAccounts().setAuth("gpt-1", undefined);
    assert.equal((await f.ask(worker.nickname)).isError, false);
    assert.equal(f.sent[0].accountId, "gpt-1");
  } finally { await f.close(); }
});

test("auto permits several workers to share an eligible account and rules prefer idle accounts", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.chats.setCliAccountPolicy({ gpt: { mode: "auto" } });
    f.chats.cliAccounts().setUsage("gpt-2", { fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 30 } }, false);
    await f.call("spawn", { kind: "gpt", job: "one", accountId: "gpt-2" });
    await f.call("spawn", { kind: "gpt", job: "two", accountId: "gpt-2" });
    const [a,b] = f.store.listAgents(f.chat.id); f.hold();
    const pending = f.call("ask_parallel", { tasks: [a,b].map(w => ({ to: w.nickname, kind: "opinion", message: "shared account", reason: "capacity", effort: "medium" })) });
    await flush();
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-2", "gpt-2"]);
    const status = JSON.parse(body(await f.call("cli_accounts", { kind: "gpt" }))).accounts.find((a: any) => a.accountId === "gpt-2");
    assert.equal(status.runningWorkers, 2); assert.equal(status.remainingPercent, 70);
    const rules = f.chats.instructionsFor!(f.chat, f.project, "orch", "codex")!;
    assert.match(rules, /대기 계정이 없으면 잔여량 10% 초과 계정을 여러 작업자가 공유/);
    f.finish(a.key); f.finish(b.key); assert.equal((await pending).isError, false);
  } finally { await f.close(); }
});

test("quota detection ignores max-turn and context limits but recognizes provider quota errors", async () => {
  const cases: Array<[string, boolean]> = [
    ["reached max turns limit", false], ["exceeded context window limit", false], ["context length limit reached", false],
    ["최대 턴 한도 초과", false], ["컨텍스트 한도 초과", false],
    ["rate_limit_exceeded", true], ["usage_limit_reached", true], ["insufficient_quota", true],
    ["429 Too Many Requests", true], ["You've hit your limit", true], ["사용량 한도 초과", true], ["한도 소진", true],
  ];
  for (const [error, expected] of cases) {
    const f = fixture();
    try {
      const worker = f.store.createAgent(f.chat.id, "gpt", "failure");
      f.chats.driver = async () => ({ agent: "codex", running: false, stop: async () => {}, dispose: async () => {}, send: async () => { throw new Error(error); } });
      const reply = await f.ask(worker.nickname);
      assert.equal(reply.isError, true);
      assert.equal(body(reply).includes("CLI 한도 소진"), expected, error);
    } finally { await f.close(); }
  }
});

test("compact routes a persisted thread to its owning account even after policy changes", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, orchestratorModel: "codex:test", accountPolicy: { gpt: { mode: "fixed", accountId: "gpt-1" } } } });
    f.store.updateChat(f.chat.id, { orchCodexThreadId: "thread-owned-by-two" });
    f.store.setSetting(`orchSessionAccount:${f.chat.id}:codex`, `gpt-2@${f.chats.getCliAccount("gpt-2")!.createdAt}`);
    const calls: any[] = [];
    f.chats.driver = async () => { throw new Error("compact must not switch the driver account"); };
    f.chats.codex = ((id: CliAccountId) => ({ ensure: async () => { calls.push([id, "ensure"]); }, request: async (method: string, params: any) => { calls.push([id, method, params]); } })) as any;
    await f.engine.command(f.chat.id, "compact", "");
    assert.deepEqual(calls, [["gpt-2", "ensure"], ["gpt-2", "thread/compact/start", { threadId: "thread-owned-by-two" }]]);
    f.store.setSetting(`orchSessionAccount:${f.chat.id}:codex`, "gpt-2@-1");
    await assert.rejects(f.engine.command(f.chat.id, "compact", ""), /삭제·재생성/);
    assert.equal(calls.length, 2);
  } finally { await f.close(); }
});

test("account binding reaches account-specific effort validation before driver creation", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    const worker = f.store.createAgent(f.chat.id, "gpt", "models");
    const checked: CliAccountId[] = [];
    f.chats.assignmentEffort = async (chatId, role, requested) => {
      checked.push(f.chats.roleAccount(chatId, role)!.accountId);
      return { requestedEffort: requested!, effort: requested! };
    };
    assert.equal((await f.ask(worker.nickname, { accountId: "gpt-2" })).isError, false);
    assert.deepEqual(checked, ["gpt-2"]);
    assert.equal(f.sent[0].accountId, "gpt-2");
  } finally { await f.close(); }
});


test("clearAccountId rejects invalid flags and any simultaneous accountId before mutating workers", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    await f.call("spawn", { kind: "gpt", job: "bound", accountId: "gpt-2" });
    const worker = f.store.listAgents(f.chat.id)[0];
    const invalid = [
      { accountId: "gpt-1", clearAccountId: true }, { accountId: "gpt-1", clearAccountId: false },
      { accountId: null, clearAccountId: true }, { clearAccountId: "true" }, { clearAccountId: 1 }, { clearAccountId: null },
    ];
    for (const args of invalid) {
      assert.equal((await f.call("spawn", { kind: "gpt", job: "invalid", ...args })).isError, true);
      assert.equal((await f.ask(worker.nickname, args)).isError, true);
      assert.equal((await f.call("ask_parallel", { tasks: [{ to: worker.nickname, kind: "opinion", message: "invalid", reason: "test", effort: "medium", ...args }] })).isError, true);
      assert.equal(f.store.agent(worker.id)!.cliAccountId, "gpt-2");
    }
    assert.equal(f.store.listAgents(f.chat.id).length, 1); assert.equal(f.sent.length, 0);
    const reply = await f.ask(worker.nickname, { clearAccountId: false });
    assert.equal(reply.isError, false); assert.equal(f.sent[0].accountId, "gpt-2");
    assert.equal((await f.call("spawn", { kind: "gemini", job: "invalid", clearAccountId: true })).isError, true);
  } finally { await f.close(); }
});

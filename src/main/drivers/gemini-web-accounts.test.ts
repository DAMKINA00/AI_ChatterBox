import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, GeminiWebAccountId, GeminiWebStatus, GeminiWebUsage } from "../../shared/types";
import type { GeminiWebBrowser } from "./gemini-web-browser";
import { GeminiWebAccounts, webRemaining, WEB_RECHECK_MS } from "./gemini-web-accounts";
import { GeminiWebDriver, type WebContext } from "./gemini-web";
import { webAccountId, webConversationId, webConversationUrl, type WebSnapshot } from "./gemini-web-protocol";

const usage = (used: number, weekly = used): GeminiWebUsage => ({ status: "available", detail: "조회됨", checkedAt: Date.now(), current: { usedPercent: used }, weekly: { usedPercent: weekly } });
const snapshot = (id: GeminiWebAccountId, patch: Partial<WebSnapshot> = {}): WebSnapshot => ({
  url: `https://gemini.google.com/app/${id}-chat`, login: false, composer: true, draft: "", model: "Argon", chatMode: true,
  generating: false, users: [], responses: [], notices: [], ...patch,
});
function fixture() {
  const saved = new Map<string, string>();
  const states = new Map<GeminiWebAccountId, { browser: GeminiWebBrowser; usage: GeminiWebUsage; owner?: string; state: GeminiWebStatus["state"]; prompts: string[]; resumes: (string | null)[]; interrupts: number; polls: number; read?: () => Promise<GeminiWebUsage>; poll?: (n: number, prompt: string) => WebSnapshot }>();
  const settings = { getSetting: (key: string) => saved.get(key), setSetting: (key: string, value: string) => { saved.set(key, value); } };
  const factory = (id: GeminiWebAccountId, changed: (u: GeminiWebUsage) => void, initial?: GeminiWebUsage) => {
    const state = { browser: undefined as unknown as GeminiWebBrowser, usage: initial ?? usage(50), owner: undefined as string | undefined, state: "ready" as GeminiWebStatus["state"], prompts: [] as string[], resumes: [] as (string | null)[], interrupts: 0, polls: 0,
      read: undefined as (() => Promise<GeminiWebUsage>) | undefined, poll: undefined as ((n: number, prompt: string) => WebSnapshot) | undefined };
    const browser = {
      accountId: id, get busy() { return !!state.owner; },
      status: () => ({ accountId: id, state: state.owner ? "busy" : state.state, message: "상태", checkedAt: Date.now(), usage: state.usage }),
      refreshUsage: async () => { if (state.read) state.usage = await state.read(); changed(state.usage); return state.usage; },
      refresh: async () => browser.status(),
      claim: async (owner: string) => { if (state.owner) throw new Error("다른 작업 중"); state.owner = owner; },
      release: (owner: string) => { if (state.owner === owner) state.owner = undefined; },
      prepare: async (_owner: string, native: string | null, signal: AbortSignal) => { signal.throwIfAborted(); state.resumes.push(native); return snapshot(id); },
      submit: async (_owner: string, prompt: string, signal: AbortSignal) => { signal.throwIfAborted(); state.prompts.push(prompt); },
      snapshot: async () => {
        const prompt = state.prompts.at(-1) ?? "";
        if (!prompt) return snapshot(id);
        state.polls++;
        return state.poll?.(state.polls, prompt) ?? snapshot(id, { users: [prompt], responses: [{ text: `완료 ${id}`, complete: true }] });
      },
      observe: () => state.usage,
      nativeId: (s: WebSnapshot) => webConversationId(s.url, id),
      interrupt: async (owner: string) => { if (state.owner === owner) state.interrupts++; },
      dispose: async () => { state.owner = undefined; },
    } as unknown as GeminiWebBrowser;
    state.browser = browser; states.set(id, state);
    return browser;
  };
  const pool = new GeminiWebAccounts("unused", settings, factory);
  const state = (id: GeminiWebAccountId) => { pool.browser(id); return states.get(id)!; };
  return { pool, saved, settings, factory, state };
}
async function flush() { for (let n = 0; n < 15; n++) await Promise.resolve(); await new Promise<void>(r => setImmediate(r)); }
async function pulse(t: any) { await flush(); t.mock.timers.tick(750); await flush(); }
const input = { text: "사서의 목소리와 도서관 이름을 유지해 안내문을 완성하세요.", attachments: [], noWrites: true, webAccountId: "gemini-1" as const };
function run(pool: GeminiWebAccounts, memory?: { load(): WebContext; save(c: WebContext): void }, nativeId: string | null = null) {
  const events: AgentEvent[] = [], ids: string[] = [];
  const driver = new GeminiWebDriver({ cwd: "unused", exePath: "unused", nativeId }, pool, { emit: e => events.push(e), nativeId: id => ids.push(id), approve: async () => ({ verdict: "allow" }) }, memory);
  return { driver, events, ids, task: () => (driver as any).task as Promise<void> };
}

test("web quota uses both windows and rejects invalid, stale, and unconfirmed balances", () => {
  assert.equal(webRemaining(usage(20, 70)), 30);
  assert.equal(webRemaining({ ...usage(20), remaining: 1, limit: 10 }), 10);
  for (const bad of [{ ...usage(20), checkedAt: Date.now() - 600_001 }, { ...usage(20), status: "error" as const }, { ...usage(20), status: "unknown" as const }, { ...usage(20), current: { usedPercent: -1 }, weekly: { usedPercent: 101 } }]) assert.equal(webRemaining(bad), undefined);
  assert.equal(webRemaining({ ...usage(20), status: "limited" }), 0);
});

test("ten account metadata entries preserve account 1, names and exclusion after restart", () => {
  const f = fixture();
  assert.equal(f.pool.list()[0].accountId, "gemini-1");
  for (let n = 1; n < 10; n++) f.pool.add();
  assert.equal(f.pool.list().length, 10);
  assert.throws(() => f.pool.add(), /최대 10/);
  f.pool.update("gemini-10", { label: "글쓰기 팀", enabled: false });
  const restored = new GeminiWebAccounts("unused", f.settings, f.factory);
  assert.equal(restored.list().find(a => a.accountId === "gemini-10")?.label, "글쓰기 팀");
  assert.equal(restored.list().find(a => a.accountId === "gemini-10")?.enabled, false);
  assert.throws(() => f.pool.update("gemini-11" as GeminiWebAccountId, { enabled: true }), /등록되지/);
  assert.throws(() => f.pool.update("gemini-1", { label: " " }), /1~60/);
});


test("the master can inspect all balances without assigning work", async () => {
  const f = fixture(); f.pool.add(); f.pool.add();
  f.state("gemini-1").usage = usage(1, 80);
  f.state("gemini-2").usage = usage(30, 20);
  f.state("gemini-3").usage = { status: "unknown", detail: "모름", checkedAt: Date.now() };
  const list = await f.pool.inspect(new AbortController().signal);
  assert.deepEqual(list.map(a => a.remainingPercent), [20, 70, undefined]);
  assert.ok(list.every(a => !f.state(a.accountId).owner));
});

test("only the master-selected account is claimed, even when another has more quota", async () => {
  const f = fixture(); f.pool.add();
  f.state("gemini-1").usage = usage(70); f.state("gemini-2").usage = usage(1);
  const b = await f.pool.acquireSelected("one", new AbortController().signal, "gemini-1");
  assert.equal(b.accountId, "gemini-1");
  await assert.rejects(f.pool.acquireSelected("two", new AbortController().signal, "gemini-1"), /지정 계정/);
  assert.equal(f.state("gemini-1").owner, "one");
  assert.equal(f.state("gemini-2").owner, undefined);
  b.release("wrong-owner"); assert.equal(b.busy, true);
  b.release("one"); assert.equal(b.busy, false);
});

test("concurrent claims of one selected account never release the winner's lease", async () => {
  const f = fixture(); const signal = new AbortController().signal;
  const result = await Promise.allSettled([f.pool.acquireSelected("one", signal, "gemini-1"), f.pool.acquireSelected("two", signal, "gemini-1")]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(result.filter(r => r.status === "rejected").length, 1);
  assert.ok(f.state("gemini-1").owner);
  await f.pool.dispose();
});

test("low, stale, unknown, logged-out, disabled and unregistered accounts cannot be selected", async () => {
  const f = fixture(); f.pool.add(); const first = f.state("gemini-1");
  const signal = new AbortController().signal;
  for (const u of [usage(90), { ...usage(20), checkedAt: Date.now() - 600001 }, { status: "unknown", detail: "조회 전", checkedAt: Date.now() } as GeminiWebUsage]) {
    first.usage = u;
    await assert.rejects(f.pool.acquireSelected("worker", signal, "gemini-1"));
  }
  first.usage = usage(10); first.state = "login_required";
  await assert.rejects(f.pool.acquireSelected("worker", signal, "gemini-1"));
  first.state = "ready"; f.pool.update("gemini-1", { enabled: false });
  await assert.rejects(f.pool.acquireSelected("worker", signal, "gemini-1"));
  await assert.rejects(f.pool.acquireSelected("worker", signal, "gemini-10"));
  assert.equal(f.state("gemini-2").owner, undefined);
});

test("manual drafts prevent selected work without modifying or switching accounts", async () => {
  const f = fixture(); f.pool.add(); const first = f.state("gemini-1");
  first.browser.snapshot = async () => snapshot("gemini-1", { draft: "직접 작성한 내용" });
  await assert.rejects(f.pool.acquireSelected("worker", new AbortController().signal, "gemini-1"));
  assert.equal(first.interrupts, 0); assert.equal(first.owner, undefined);
  assert.equal(f.state("gemini-2").owner, undefined);
});

test("master waits for a busy account and receives a fresh list, without claiming it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  f.state("gemini-1").owner = "one"; f.state("gemini-2").owner = "two";
  let finished = false;
  const task = f.pool.inspect(new AbortController().signal, true).then(a => { finished = true; return a; });
  await flush(); assert.equal(finished, false);
  f.state("gemini-2").browser.release("two");
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  const list = await task;
  assert.equal(list[1].state, "ready"); assert.equal(list[0].state, "busy");
  assert.equal(f.state("gemini-2").owner, undefined);
});

test("master waits for quota reset and can cancel without later dispatch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const first = f.state("gemini-1"); first.usage = usage(100);
  const controller = new AbortController();
  const task = f.pool.inspect(controller.signal, true);
  await flush(); first.read = async () => usage(50);
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.equal((await task)[0].remainingPercent, 50); assert.equal(first.owner, undefined);
  first.read = undefined; first.usage = usage(100);
  const waiting = f.pool.inspect(controller.signal, true); await flush();
  const rejected = assert.rejects(waiting); controller.abort(); await rejected;
  first.usage = usage(1); t.mock.timers.tick(WEB_RECHECK_MS * 2); await flush();
  assert.equal(first.prompts.length, 0);
});

test("pool disposal cancels master inspection", async () => {
  const f = fixture(); f.state("gemini-1").usage = usage(100);
  const task = f.pool.inspect(new AbortController().signal, true); await flush();
  const rejected = assert.rejects(task, /종료/); await f.pool.dispose(); await rejected;
});

test("new account wakes master inspection even when another account's lookup is stalled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const first = f.state("gemini-1"); first.usage = usage(100);
  let releaseRead!: (u: GeminiWebUsage) => void;
  first.read = () => new Promise(resolve => { releaseRead = resolve; });
  const task = f.pool.inspect(new AbortController().signal, true); await flush();
  f.pool.add(); await f.state("gemini-2").browser.refreshUsage(); await flush();
  const list = await task;
  assert.equal(list[1].remainingPercent, 50); assert.equal(f.state("gemini-2").owner, undefined);
  releaseRead(usage(100)); await flush(); await f.pool.dispose();
});

test("web driver rejects missing master selection before claiming a profile", async () => {
  const f = fixture(), r = run(f.pool);
  await assert.rejects(r.driver.send({ ...input, webAccountId: undefined }), /마스터/);
  assert.equal(f.state("gemini-1").owner, undefined);
});

test("explicitly retaining an account resumes its previous conversation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add(); f.state("gemini-2").usage = usage(1);
  const r = run(f.pool, undefined, "web:gemini-1:/app/previous-story");
  await r.driver.send(input); for (let n = 0; n < 4; n++) await pulse(t); await r.task();
  assert.deepEqual(f.state("gemini-1").resumes, ["web:gemini-1:/app/previous-story"]);
  assert.equal(f.state("gemini-2").prompts.length, 0);
  assert.equal(r.events.find(e => e.type === "notice" && e.webAccountId)?.webAccountId, "gemini-1");
});

test("quota falling before submission returns control to the master without switching", async () => {
  const f = fixture(); f.pool.add(); const first = f.state("gemini-1");
  first.browser.prepare = async () => { first.usage = usage(95); return snapshot("gemini-1"); };
  let stored: WebContext = { history: [] };
  const r = run(f.pool, { load: () => stored, save: c => { stored = structuredClone(c); } });
  await r.driver.send(input); await r.task();
  assert.equal(first.prompts.length, 0); assert.equal(first.owner, undefined);
  assert.equal(f.state("gemini-2").prompts.length, 0);
  assert.match(stored.pending!.request, /사서/);
  assert.match(r.events.findLast(e => e.type === "turn_end")?.error ?? "", /마스터/);
});

test("low quota preserves draft; only a new master assignment transfers it to the selected account", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add(); const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.poll = (_n, prompt) => { first.usage = usage(96); return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "도서관 초안과 사서의 말투", complete: false }] }); };
  let stored: WebContext = { history: [{ request: "도서관은 별빛도서관이다.", response: "별빛도서관" }] };
  const memory = { load: () => structuredClone(stored), save: (c: WebContext) => { stored = structuredClone(c); } };
  const r = run(f.pool, memory);
  await r.driver.send(input); await pulse(t); await r.task();
  assert.equal(r.driver.running, false); assert.equal(first.owner, undefined); assert.equal(first.interrupts, 1);
  assert.equal(second.prompts.length, 0); assert.equal(stored.pending?.partial, "도서관 초안과 사서의 말투");
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, false);
  const resumed = run(f.pool, memory, r.ids.at(-1)!);
  await resumed.driver.send({ ...input, webAccountId: "gemini-2" });
  for (let n = 0; n < 4; n++) await pulse(t); await resumed.task();
  assert.equal(second.prompts.length, 1); assert.match(second.prompts[0], /도서관 초안과 사서의 말투/);
  assert.match(second.prompts[0], /별빛도서관/); assert.match(second.prompts[0], /사서의 목소리/);
  assert.equal(second.prompts[0].split(input.text).length - 1, 1);
  assert.deepEqual(second.resumes, [null]); assert.equal(stored.pending, undefined);
  assert.equal(resumed.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("after quota reset, the master can resume the same account with its partial draft", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), first = f.state("gemini-1");
  first.poll = (_n, prompt) => { first.usage = usage(100); return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "보존할 초안", complete: false }] }); };
  let stored: WebContext = { history: [] };
  const r = run(f.pool, { load: () => stored, save: c => { stored = structuredClone(c); } });
  await r.driver.send(input); await pulse(t); await r.task();
  assert.equal(stored.pending?.partial, "보존할 초안"); assert.equal(r.driver.running, false);
  first.usage = usage(20); first.poll = undefined;
  await r.driver.send(input); for (let n = 0; n < 4; n++) await pulse(t); await r.task();
  assert.equal(first.prompts.length, 2); assert.match(first.prompts[1], /보존할 초안/);
  assert.equal(first.resumes.at(-1), "web:gemini-1:/app/gemini-1-chat");
  assert.equal(stored.pending, undefined); assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("quota downgrade transfers only the verified Argon draft on master reassignment", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add(); const first = f.state("gemini-1");
  first.poll = (n, prompt) => {
    if (n === 1) return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "검증된 Argon 초안", complete: false }] });
    first.usage = { ...usage(100), status: "limited" };
    return snapshot("gemini-1", { users: [prompt], model: "Flash", responses: [{ text: "넘기면 안 되는 응답", complete: true }] });
  };
  const r = run(f.pool); await r.driver.send(input); await pulse(t); await pulse(t); await r.task();
  assert.equal(f.state("gemini-2").prompts.length, 0);
  await r.driver.send({ ...input, webAccountId: "gemini-2" });
  for (let n = 0; n < 4; n++) await pulse(t); await r.task();
  assert.match(f.state("gemini-2").prompts[0], /검증된 Argon 초안/);
  assert.doesNotMatch(f.state("gemini-2").prompts[0], /넘기면 안 되는/);
});

test("stop during quota lookup prevents later submission and releases the selected account", async () => {
  const f = fixture(), first = f.state("gemini-1"); let resolve!: (u: GeminiWebUsage) => void;
  first.read = () => new Promise(r => { resolve = r; });
  const r = run(f.pool); await r.driver.send(input); await flush(); await r.driver.stop();
  assert.equal(r.driver.running, false); assert.equal(r.events.findLast(e => e.type === "turn_end")?.interrupted, true);
  resolve(usage(20)); await flush(); assert.equal(first.prompts.length, 0); assert.equal(first.owner, undefined);
});

test("conversation identities isolate all ten accounts and reject path traversal", () => {
  for (let n = 1; n <= 10; n++) {
    const account = `gemini-${n}` as GeminiWebAccountId;
    const id = webConversationId("https://gemini.google.com/app/story_123", account);
    assert.equal(id, `web:${account}:/app/story_123`);
    assert.equal(webConversationUrl(id, account), "https://gemini.google.com/app/story_123");
    if (n !== 1) assert.equal(webConversationUrl(id), "https://gemini.google.com/app");
  }
  for (const bad of ["gemini-0", "gemini-11", "gemini-01", "../gemini-1", "gemini-1/../../other"]) assert.equal(webAccountId(bad), null);
});

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
const input = { text: "사서의 목소리와 도서관 이름을 유지해 안내문을 완성하세요.", attachments: [], noWrites: true };
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

test("assignment picks the most available bottleneck and separates concurrent workers", async () => {
  const f = fixture(); f.pool.add(); f.pool.add();
  f.state("gemini-1").usage = usage(1, 80);
  f.state("gemini-2").usage = usage(30, 20);
  f.state("gemini-3").usage = { status: "unknown", detail: "모름", checkedAt: Date.now() };
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([f.pool.acquire("one", signal), f.pool.acquire("two", signal)]);
  assert.equal(a.accountId, "gemini-2");
  assert.equal(b.accountId, "gemini-1");
  assert.throws(() => f.pool.update("gemini-2", { enabled: false }), /작업 중/);
  a.release("not-owner"); assert.equal(a.busy, true);
  a.release("one"); b.release("two");
  f.pool.update("gemini-2", { enabled: false });
  assert.equal((await f.pool.acquire("three", signal)).accountId, "gemini-1");
});

test("the previous account is checked first and retains its conversation when its quota is sufficient", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(99); first.read = async () => usage(60);
  second.usage = usage(1);
  let otherReads = 0; second.read = async () => { otherReads++; return second.usage; };
  const nativeId = "web:gemini-1:/app/previous-story";
  const r = run(f.pool, undefined, nativeId);
  await r.driver.send(input);
  for (let n = 0; n < 4; n++) await pulse(t);
  await r.task();
  assert.deepEqual(first.resumes, [nativeId]);
  assert.equal(first.prompts.length, 1); assert.equal(second.prompts.length, 0);
  assert.equal(otherReads, 0, "other accounts need not be queried before a usable previous account");
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("an insufficient or busy previous account falls back to the idle account with most quota", async () => {
  const f = fixture(); f.pool.add(); f.pool.add(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2"), third = f.state("gemini-3"), fourth = f.state("gemini-4");
  first.usage = usage(90); second.usage = usage(1); second.owner = "other-job";
  third.usage = usage(40); fourth.usage = usage(70);
  const signal = new AbortController().signal;
  const chosen = await f.pool.acquire("worker", signal, "gemini-1");
  assert.equal(chosen.accountId, "gemini-3"); chosen.release("worker");
  first.usage = usage(1); first.owner = "previous-job";
  const fallback = await f.pool.acquire("worker", signal, "gemini-1");
  assert.equal(fallback.accountId, "gemini-3");
  assert.equal(first.owner, "previous-job"); assert.equal(second.owner, "other-job");
});

test("low, unknown, blocked and disabled accounts wait without assignment and can be cancelled", async () => {
  const f = fixture(); f.pool.add(); f.pool.add(); f.pool.add();
  f.state("gemini-1").usage = usage(90);
  f.state("gemini-2").state = "login_required";
  f.pool.update("gemini-3", { enabled: false });
  f.state("gemini-4").usage = { status: "unknown", detail: "조회 전", checkedAt: Date.now() };
  const controller = new AbortController(); let waits = 0;
  const task = f.pool.acquire("job", controller.signal, "gemini-1", () => { waits++; });
  await flush();
  assert.equal(waits, 1);
  assert.ok(f.pool.list().every(a => !f.state(a.accountId).owner));
  controller.abort(); await assert.rejects(task);
});

test("all busy accounts wait and a completed account is assigned on the next periodic check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.owner = "one"; first.usage = usage(40);
  second.owner = "two"; second.usage = usage(1);
  let waits = 0, assigned = false;
  const task = f.pool.acquire("queued", new AbortController().signal, "gemini-1", () => { waits++; }).then(b => { assigned = true; return b; });
  await flush(); t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.equal(assigned, false); assert.equal(waits, 1);
  second.browser.release("two");
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.equal((await task).accountId, "gemini-2");
  assert.equal(first.owner, "one"); assert.equal(first.interrupts, 0);
});

test("a waiting request rechecks the previous account before newly available alternatives", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(100); second.owner = "other-job"; second.usage = usage(1);
  const task = f.pool.acquire("queued", new AbortController().signal, "gemini-1");
  await flush(); first.read = async () => usage(50); second.browser.release("other-job");
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.equal((await task).accountId, "gemini-1");
});

test("disposing the account pool cancels waiting allocations", async () => {
  const f = fixture(); f.state("gemini-1").usage = usage(100);
  const task = f.pool.acquire("queued", new AbortController().signal);
  await flush();
  const rejected = assert.rejects(task, /종료/);
  await f.pool.dispose(); await rejected;
});

test("new ready accounts wake a waiting request even while the previous account's quota lookup is stalled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), first = f.state("gemini-1");
  first.usage = usage(100);
  const controller = new AbortController();
  let chosen: GeminiWebBrowser | undefined, releaseRead!: (u: GeminiWebUsage) => void;
  const task = f.pool.acquire("waiting-job", controller.signal, "gemini-1").then(b => { chosen = b; }, () => {});
  try {
    await flush();
    first.read = () => new Promise(resolve => { releaseRead = resolve; });
    t.mock.timers.tick(WEB_RECHECK_MS); await flush();
    assert.ok(releaseRead, "the previous account has a pending lookup");
    for (let n = 2; n <= 4; n++) {
      f.pool.add();
      f.state(`gemini-${n}` as GeminiWebAccountId).usage = usage(n * 10);
    }
    await Promise.all([2, 3, 4].map(n => f.state(`gemini-${n}` as GeminiWebAccountId).browser.refreshUsage()));
    await flush();
    assert.equal(chosen?.accountId, "gemini-2", "fresh available accounts must be selected without waiting for account 1");
    assert.equal(first.owner, undefined);
    assert.equal(f.state("gemini-2").owner, "waiting-job");
  } finally {
    controller.abort();
    releaseRead?.(usage(100));
    await task; await f.pool.dispose();
  }
});

test("a simultaneous account change releases a lease returned by the abandoned allocation pass", async () => {
  const f = fixture(), first = f.state("gemini-1");
  const original = (f.pool as any).pick.bind(f.pool);
  let race = true;
  (f.pool as any).pick = (owner: string, signal: AbortSignal, preferred: GeminiWebAccountId | null, refresh: boolean) => {
    if (!race) return original(owner, signal, preferred, refresh);
    race = false;
    return new Promise(resolve => setImmediate(() => {
      first.owner = owner;
      f.pool.add();
      resolve(first.browser);
    }));
  };
  try {
    const chosen = await f.pool.acquire("racing-job", new AbortController().signal);
    const owned = f.pool.list().filter(a => f.state(a.accountId).owner === "racing-job");
    assert.deepEqual(owned.map(a => a.accountId), [chosen.accountId]);
    chosen.release("racing-job");
    assert.ok(f.pool.list().every(a => !f.state(a.accountId).owner));
  } finally { await f.pool.dispose(); }
});

test("a newly usable account resumes the same waiting driver request with its saved context and partial draft", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), first = f.state("gemini-1");
  first.usage = usage(100);
  let stored: WebContext = { history: [{ request: "독자와 인물을 유지하세요.", response: "확인된 설정" }], pending: { request: input.text, partial: "이어 쓸 초안" } };
  const r = run(f.pool, { load: () => stored, save: c => { stored = structuredClone(c); } }, "web:gemini-1:/app/previous-story");
  await r.driver.send(input); await flush();
  assert.ok(r.events.some(e => e.type === "notice" && e.text.includes("배정 대기")));
  assert.equal(r.events.some(e => e.type === "turn_end"), false);
  f.pool.add();
  const second = f.state("gemini-2");
  second.usage = usage(1);
  await second.browser.refreshUsage(); await flush();
  for (let n = 0; n < 4; n++) await pulse(t);
  await r.task();
  assert.equal(first.prompts.length, 0);
  assert.equal(second.prompts.length, 1);
  assert.match(second.prompts[0], /확인된 설정/);
  assert.match(second.prompts[0], /이어 쓸 초안/);
  assert.match(second.prompts[0], /사서의 목소리/);
  assert.equal(stored.pending, undefined);
  assert.equal(r.events.filter(e => e.type === "turn_end").length, 1);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
  await f.pool.dispose();
});

test("accounts added after the user stops a waiting request cannot restart that request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.state("gemini-1").usage = usage(100);
  const r = run(f.pool);
  await r.driver.send(input); await flush();
  await r.driver.stop();
  f.pool.add();
  await f.state("gemini-2").browser.refreshUsage();
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.ok(f.pool.list().every(a => !f.state(a.accountId).owner && f.state(a.accountId).prompts.length === 0));
  assert.equal(r.events.filter(e => e.type === "turn_end").length, 1);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.interrupted, true);
  await f.pool.dispose();
});

test("manual drafts are skipped without interruption when another account can work", async () => {
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(5); second.usage = usage(30);
  first.browser.snapshot = async () => snapshot("gemini-1", { draft: "사용자가 직접 쓰던 내용" });
  assert.equal((await f.pool.acquire("worker", new AbortController().signal, "gemini-1")).accountId, "gemini-2");
  assert.equal(first.owner, undefined); assert.equal(first.interrupts, 0); assert.equal(first.prompts.length, 0);
});

test("quota that falls during browser preparation is reassigned before the request is submitted", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(1); second.usage = usage(50);
  first.browser.prepare = async () => { first.usage = usage(95); return snapshot("gemini-1"); };
  const r = run(f.pool, undefined, "web:gemini-1:/app/previous-story");
  await r.driver.send(input);
  for (let n = 0; n < 4; n++) await pulse(t);
  await r.task();
  assert.equal(first.prompts.length, 0); assert.equal(first.interrupts, 0); assert.equal(first.owner, undefined);
  assert.equal(second.prompts.length, 1); assert.match(second.prompts[0], /사서의 목소리/);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("the last accepted in-flight account remains preferred after a quota reset", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.owner = "other-job"; first.usage = usage(1); second.usage = usage(50);
  second.poll = (_n, prompt) => { second.usage = usage(95); return snapshot("gemini-2", { users: [prompt], generating: true, responses: [{ text: "이전 작업을 이어갈 초안", complete: false }] }); };
  const r = run(f.pool);
  await r.driver.send(input); await pulse(t);
  assert.equal(r.ids.at(-1), "web:gemini-2:/app/gemini-2-chat");
  assert.equal(r.driver.running, true);
  first.browser.release("other-job"); second.read = async () => usage(50); second.poll = undefined;
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  for (let n = 0; n < 4; n++) await pulse(t);
  await r.task();
  assert.equal(first.prompts.length, 0); assert.equal(second.prompts.length, 2);
  assert.equal(second.resumes.at(-1), "web:gemini-2:/app/gemini-2-chat");
  assert.match(second.prompts.at(-1)!, /이전 작업을 이어갈 초안/);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
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

test("low quota hands the current request and partial draft to another account without completing early", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(10); second.usage = usage(40);
  first.poll = (_n, prompt) => { first.usage = usage(96); return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "도서관 초안과 사서의 말투", complete: false }] }); };
  let stored: WebContext = { history: [{ request: "도서관은 별빛도서관이다.", response: "별빛도서관" }] };
  const history: WebContext[] = [];
  const memory = { load: () => structuredClone(stored), save: (c: WebContext) => { stored = structuredClone(c); history.push(stored); } };
  const r = run(f.pool, memory);
  await r.driver.send(input);
  for (let n = 0; n < 6; n++) await pulse(t);
  await r.task();
  assert.equal(first.prompts.length, 1); assert.equal(second.prompts.length, 1);
  assert.match(second.prompts[0], /도서관 초안과 사서의 말투/);
  assert.match(second.prompts[0], /별빛도서관/);
  assert.match(second.prompts[0], /사서의 목소리/);
  assert.equal(second.prompts[0].split(input.text).length - 1, 1, "an in-flight request must not be included twice in a handover");
  assert.deepEqual(second.resumes, [null]);
  assert.equal(first.interrupts, 1);
  assert.equal(r.events.filter(e => e.type === "turn_end").length, 1);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
  assert.equal(r.events.some(e => e.type === "error"), false);
  assert.equal(history.some(c => c.pending?.partial.includes("초안")), true);
  assert.equal(stored.pending, undefined);
  assert.equal(stored.history.at(-1)?.response, "완료 gemini-2");
  first.usage = usage(5); second.usage = usage(90);
  first.poll = undefined;
  const restarted = run(f.pool, memory, r.ids.at(-1)!);
  await restarted.driver.send({ ...input, text: "이전 도서관 안내를 이어서 다듬으세요." });
  for (let n = 0; n < 4; n++) await pulse(t);
  await restarted.task();
  assert.match(first.prompts.at(-1)!, /완료 gemini-2/);
  assert.equal(restarted.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("exhausted work remains pending and resumes with its draft after the same account's quota resets", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), first = f.state("gemini-1");
  first.usage = usage(10);
  first.poll = (_n, prompt) => { first.usage = { ...usage(100), status: "limited" }; return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "보존할 초안", complete: false }] }); };
  let stored: WebContext = { history: [] };
  const r = run(f.pool, { load: () => stored, save: c => { stored = structuredClone(c); } });
  await r.driver.send(input); await pulse(t);
  assert.equal(stored.pending?.partial, "보존할 초안");
  assert.equal(r.driver.running, true);
  assert.equal(r.events.some(e => e.type === "turn_end"), false);
  assert.equal(r.events.some(e => e.type === "text"), false);
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  assert.equal(first.prompts.length, 1);
  first.read = async () => usage(20); first.poll = undefined;
  t.mock.timers.tick(WEB_RECHECK_MS); await flush();
  for (let n = 0; n < 4; n++) await pulse(t);
  await r.task();
  assert.equal(first.prompts.length, 2); assert.match(first.prompts[1], /보존할 초안/);
  assert.equal(stored.pending, undefined);
  assert.equal(r.events.filter(e => e.type === "turn_end").length, 1);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("low quota pauses an unfinished response and stop while waiting prevents any later submission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), first = f.state("gemini-1");
  first.poll = (_n, prompt) => { first.usage = usage(91); return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "계속할 초안", complete: false }] }); };
  let stored: WebContext = { history: [] };
  const r = run(f.pool, { load: () => stored, save: c => { stored = structuredClone(c); } });
  await r.driver.send(input); await pulse(t);
  assert.equal(r.driver.running, true); assert.equal(first.interrupts, 1); assert.equal(first.owner, undefined);
  assert.equal(r.events.some(e => e.type === "notice" && e.text.includes("배정 대기")), true);
  await r.driver.stop();
  first.read = async () => usage(1); first.poll = undefined;
  t.mock.timers.tick(WEB_RECHECK_MS * 2); await flush();
  assert.equal(first.prompts.length, 1); assert.equal(first.interrupts, 1);
  assert.equal(stored.pending?.partial, "계속할 초안");
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.interrupted, true);
});

test("a quota-triggered model downgrade transfers only the last verified Argon draft", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.pool.add();
  const first = f.state("gemini-1"), second = f.state("gemini-2");
  first.usage = usage(10); second.usage = usage(40);
  first.poll = (n, prompt) => {
    if (n === 1) return snapshot("gemini-1", { users: [prompt], generating: true, responses: [{ text: "검증된 Argon 초안", complete: false }] });
    first.usage = { ...usage(100), status: "limited" };
    return snapshot("gemini-1", { users: [prompt], model: "Flash", responses: [{ text: "넘기면 안 되는 다른 모델 응답", complete: true }] });
  };
  const r = run(f.pool);
  await r.driver.send(input);
  for (let n = 0; n < 7; n++) await pulse(t);
  await r.task();
  assert.match(second.prompts[0], /검증된 Argon 초안/);
  assert.doesNotMatch(second.prompts[0], /넘기면 안 되는/);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.ok, true);
});

test("stop during quota lookup cancels allocation promptly and cannot submit afterward", async () => {
  const f = fixture(), first = f.state("gemini-1");
  let resolve!: (u: GeminiWebUsage) => void;
  first.read = () => new Promise(r => { resolve = r; });
  const r = run(f.pool);
  await r.driver.send(input); await flush();
  await r.driver.stop();
  assert.equal(r.driver.running, false);
  assert.equal(r.events.findLast(e => e.type === "turn_end")?.interrupted, true);
  resolve(usage(20)); await flush();
  assert.equal(first.prompts.length, 0); assert.equal(first.owner, undefined);
});

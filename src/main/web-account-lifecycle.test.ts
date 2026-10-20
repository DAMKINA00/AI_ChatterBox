import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type GeminiWebAccountId } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { GeminiWebAccounts } from "./drivers/gemini-web-accounts";
import { GeminiWebBrowser } from "./drivers/gemini-web-browser";
import type { WebSnapshot } from "./drivers/gemini-web-protocol";

const quota = { status: "available" as const, detail: "fixture", checkedAt: Date.now(), current: { usedPercent: 20 } };
const page = (patch: Partial<WebSnapshot> = {}): WebSnapshot => ({
  url: "https://gemini.google.com/app", login: false, composer: true, draft: "", model: "Argon",
  chatMode: true, generating: false, users: [], responses: [], notices: [], ...patch,
});
function poolFixture() {
  const saved = new Map<string, string>();
  const settings = { getSetting: (key: string) => saved.get(key), setSetting: (key: string, value: string) => { saved.set(key, value); } };
  const cleared: string[] = [];
  const make = (id: GeminiWebAccountId, changed: (u: typeof quota) => void, initial?: typeof quota) => {
    const browser = new GeminiWebBrowser("unused", changed as any, id, initial ?? quota);
    browser.logout = disconnect => GeminiWebBrowser.prototype.logout.call(browser, disconnect, async () => { cleared.push(id); });
    return browser;
  };
  const pool = new GeminiWebAccounts("unused", settings, make as any);
  return { pool, settings, make, cleared };
}

test("logout keeps slot preferences; removal persists an empty list and reuses a clean slot", async () => {
  const f = poolFixture();
  f.pool.update("gemini-1", { label: "Writing", enabled: false });
  let unlink = 0;
  const loggedOut = await f.pool.disconnect("gemini-1", false, async () => { unlink++; });
  assert.equal(loggedOut.length, 1);
  assert.equal(loggedOut[0].label, "Writing");
  assert.equal(loggedOut[0].enabled, false);
  assert.equal(loggedOut[0].state, "login_required");
  assert.equal(loggedOut[0].remainingPercent, undefined);
  assert.equal(loggedOut[0].usage.current, undefined);
  const restored = new GeminiWebAccounts("unused", f.settings, f.make as any);
  assert.equal(restored.list()[0].usage.current, undefined);
  assert.deepEqual(await f.pool.disconnect("gemini-1", true, async () => { unlink++; }), []);
  assert.deepEqual(new GeminiWebAccounts("unused", f.settings, f.make as any).list(), []);
  const reused = f.pool.add()[0];
  assert.equal(reused.accountId, "gemini-1");
  assert.equal(reused.label, "계정 1");
  assert.equal(unlink, 2);
  assert.deepEqual(f.cleared, ["gemini-1", "gemini-1"]);
  await f.pool.dispose(); await restored.dispose();
});

test("busy browser and manual content refuse logout before any unlink or session change", async () => {
  for (const state of ["owned", "draft", "generating"] as const) {
    const browser = new GeminiWebBrowser("unused", () => {});
    if (state === "owned") (browser as any).owner = "active-worker";
    browser.snapshot = async () => page(state === "draft" ? { draft: "unfinished" } : { generating: state === "generating" });
    let mutations = 0;
    await assert.rejects(browser.logout(async () => { mutations++; }, async () => { mutations++; }));
    assert.equal(mutations, 0);
    assert.equal(browser.busy, state === "owned");
  }
});

test("logout blocks concurrent claims and a second logout until cleanup finishes", async () => {
  const browser = new GeminiWebBrowser("unused", () => {}, "gemini-1", quota);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const task = browser.logout(async () => { entered(); await gate; }, async () => {});
  await ready;
  assert.equal(browser.busy, true);
  await assert.rejects(browser.claim("new-worker"), /로그아웃 중/);
  await assert.rejects(browser.open(false), /로그아웃 중/);
  await assert.rejects(browser.studioState(false), /로그아웃 중/);
  await assert.rejects(browser.logout(async () => {}, async () => {}), /작업 중/);
  release(); await task;
  assert.equal(browser.busy, false);
  assert.equal(browser.status().state, "login_required");
});

test("unlink failure preserves session and slot; failed storage clearing remains retryable", async () => {
  const f = poolFixture();
  await assert.rejects(f.pool.disconnect("gemini-1", true, async () => { throw Error("backend offline"); }), /offline/);
  assert.equal(f.pool.list().length, 1);
  assert.equal(f.pool.list()[0].usage.current?.usedPercent, 20);
  assert.deepEqual(f.cleared, []);
  const browser = f.pool.browser();
  await assert.rejects(GeminiWebBrowser.prototype.logout.call(browser, async () => {}, async () => { throw Error("locked"); }), /locked/);
  assert.equal(browser.status().state, "error");
  assert.equal(browser.status().usage.current, undefined);
  await f.pool.disconnect("gemini-1", false, async () => {});
  assert.equal(browser.status().state, "login_required");
  await f.pool.dispose();
});

test("a draft or generation started during unlink prevents browser disposal", async () => {
  for (const patch of [{ draft: "new manual draft" }, { generating: true }]) {
    const browser = new GeminiWebBrowser("unused", () => {});
    browser.snapshot = async () => page();
    let disposed = false, cleared = false;
    browser.dispose = async () => { disposed = true; };
    await assert.rejects(browser.logout(async () => { browser.snapshot = async () => page(patch); },
      async () => { cleared = true; }), /새로 작성 중/);
    assert.equal(disposed, false);
    assert.equal(cleared, false);
    assert.equal(browser.busy, false);
  }
});

test("a late status lookup cannot overwrite completed logout with old data or an error", async () => {
  for (const fail of [false, true]) {
    const browser = new GeminiWebBrowser("unused", () => {}, "gemini-1", quota);
    let resolve!: (value: WebSnapshot) => void, reject!: (error: Error) => void;
    browser.snapshot = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const refresh = browser.refresh(false);
    browser.snapshot = async () => null;
    await browser.logout(async () => {}, async () => {});
    if (fail) reject(Error("window destroyed")); else resolve(page());
    await refresh;
    assert.equal(browser.status().state, "login_required");
    assert.equal(browser.status().usage.current, undefined);
  }
});

function managerFixture() {
  const root = mkdtempSync(join(tmpdir(), "chatterbox-account-lifecycle-"));
  const store = new Store(join(root, "test.sqlite"));
  const project = store.createProject("fixture", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "preserved chat");
  const manager = new ChatManager(store, { agents() {}, event() {}, chat() {}, consult() {}, usage() {} }, root, "unused");
  const pool = poolFixture();
  manager.geminiWebAccounts = () => pool.pool;
  let unlinked = 0;
  manager.aiStudio = () => ({ disconnectWeb: async () => { unlinked++; } }) as any;
  return { root, store, chat, manager, pool, unlinked: () => unlinked,
    async close() { await manager.dispose(); await pool.pool.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("disconnect clears only matching account bindings and native sessions while preserving history", async () => {
  const f = managerFixture();
  try {
    const a = f.store.createAgent(f.chat.id, "gemini", "first");
    const b = f.store.createAgent(f.chat.id, "gemini", "other");
    const c = f.store.createAgent(f.chat.id, "gemini", "reassigned");
    f.store.updateAgent(a.id, { webAccountId: "gemini-1", sessionId: "web:gemini-1:/app/first" });
    f.store.updateAgent(b.id, { webAccountId: "gemini-10", sessionId: "web:gemini-10:/app/other" });
    f.store.updateAgent(c.id, { webAccountId: "gemini-2", sessionId: "web:gemini-1:/app/old" });
    f.store.setSetting(`orchSession:${f.chat.id}:gemini`, "web:gemini-1:/app/legacy");
    f.store.setSetting(`gemini-web-context:${f.chat.id}:${a.key}`, "saved local context");
    f.store.addEvent(f.chat.id, a.key, a.key, { type: "text", text: "preserved response" });
    const consult = f.store.createConsult(f.chat.id, "orch", a.key, "implement", "preserved request", []);
    let disposed = 0;
    (f.manager as any).live.set(f.chat.id, { [a.key]: { driver: { running: false, dispose: async () => { disposed++; } } } });
    await f.manager.disconnectWebAccount("gemini-1", true);
    assert.equal(f.unlinked(), 1);
    assert.equal(disposed, 1);
    assert.equal(f.store.agent(a.id)?.webAccountId, undefined);
    assert.equal(f.store.agent(a.id)?.sessionId, null);
    assert.equal(f.store.agent(b.id)?.sessionId, "web:gemini-10:/app/other");
    assert.equal(f.store.agent(b.id)?.webAccountId, "gemini-10");
    assert.equal(f.store.agent(c.id)?.sessionId, null);
    assert.equal(f.store.agent(c.id)?.webAccountId, "gemini-2");
    assert.equal(f.store.getSetting(`orchSession:${f.chat.id}:gemini`), undefined);
    assert.equal(f.store.getSetting(`gemini-web-context:${f.chat.id}:${a.key}`), "saved local context");
    assert.equal(f.store.chat(f.chat.id)?.title, "preserved chat");
    assert.equal(f.store.events(f.chat.id)[0].event.type, "text");
    assert.equal(f.store.consult(consult.id)?.request, "preserved request");
    assert.deepEqual(f.pool.pool.list(), []);
  } finally { await f.close(); }
});

test("a running linked worker rejects disconnect without stopping work or unlinking", async () => {
  const f = managerFixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "gemini", "running");
    f.store.updateAgent(worker.id, { webAccountId: "gemini-1" });
    let disposed = 0;
    (f.manager as any).live.set(f.chat.id, { [worker.key]: { driver: { running: true, dispose: async () => { disposed++; } } } });
    await assert.rejects(f.manager.disconnectWebAccount("gemini-1", true), /실행 중/);
    assert.equal(disposed, 0);
    assert.equal(f.unlinked(), 0);
    assert.deepEqual(f.pool.cleared, []);
    assert.equal(f.store.agent(worker.id)?.webAccountId, "gemini-1");
    assert.equal(f.pool.pool.list().length, 1);
  } finally { await f.close(); }
});

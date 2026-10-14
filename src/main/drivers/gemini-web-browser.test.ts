import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiWebBrowser } from "./gemini-web-browser";
import type { WebSnapshot } from "./gemini-web-protocol";

const snapshot = (patch: Partial<WebSnapshot> = {}): WebSnapshot => ({ url: "https://gemini.google.com/app", login: false,
  composer: true, draft: "", model: "Argon", chatMode: true, generating: false, users: [], responses: [], notices: [], ...patch });
function fixture() {
  const updates: any[] = [];
  const browser = new GeminiWebBrowser("unused", u => updates.push(u));
  const b = browser as any;
  browser.open = async () => browser.status();
  browser.refresh = async () => browser.status();
  browser.refreshUsage = async () => browser.status().usage;
  return { browser, b, updates };
}

test("account lock refuses a second chat and a foreign release cannot unlock it", async () => {
  const { browser, b } = fixture();
  await browser.claim("chat-one");
  await assert.rejects(browser.claim("chat-two"), /다른 작업/);
  browser.release("chat-two");
  assert.equal(b.owner, "chat-one");
  browser.release("chat-one");
  await browser.claim("chat-two");
  assert.equal(b.owner, "chat-two");
});

test("abort during browser opening stops navigation, releases lock and cannot submit", async () => {
  const { browser, b } = fixture();
  let reject!: (e: Error) => void, stopped = 0;
  b.win = { isDestroyed: () => false, webContents: { stop: () => { stopped++; reject(new Error("navigation stopped")); } } };
  browser.open = () => new Promise((_resolve, r) => { reject = r; });
  const signal = new AbortController();
  const opening = browser.claim("chat", signal.signal);
  signal.abort();
  await assert.rejects(opening, /navigation stopped/);
  assert.equal(stopped, 1);
  assert.equal(b.owner, undefined);
});

test("pre-existing draft or manual generation never gets replaced by app navigation", async () => {
  for (const patch of [{ draft: "my unfinished message" }, { generating: true }]) {
    const { browser, b } = fixture();
    await browser.claim("chat");
    let navigation = 0;
    b.win = { isDestroyed: () => false, loadURL: () => { navigation++; } };
    browser.snapshot = async () => snapshot(patch);
    await assert.rejects(browser.prepare("chat", null, new AbortController().signal), /작성 중/);
    assert.equal(navigation, 0);
  }
});

test("resuming a missing conversation never falls back to a new conversation", async () => {
  const { browser, b } = fixture();
  await browser.claim("chat");
  b.win = { isDestroyed: () => false, webContents: { getURL: () => "https://gemini.google.com/app/old" } };
  browser.snapshot = async () => snapshot();
  await assert.rejects(browser.prepare("chat", "web:gemini-1:/app/old", new AbortController().signal), /다시 열지 못했습니다/);
});

test("a failed usage refresh cannot retain a previous numeric quota", async () => {
  const { browser, b, updates } = fixture();
  b.setUsage({ status: "available", detail: "known", checkedAt: 1, current: { usedPercent: 50 } });
  b.win = {};
  browser.snapshot = async () => { throw new Error("DOM changed"); };
  // Use the real refresh method, not the fixture override.
  const status = await GeminiWebBrowser.prototype.refresh.call(browser, false);
  assert.equal(status.usage.status, "error");
  assert.equal(status.usage.current, undefined);
  assert.equal(updates.at(-1).current, undefined);
});

test("ordinary response polling preserves quota snapshot and does not persist on every poll", () => {
  const { browser, b, updates } = fixture();
  b.setUsage({ status: "available", detail: "known", checkedAt: 1, weekly: { usedPercent: 7 } });
  for (let n = 0; n < 20; n++) browser.observe(snapshot());
  assert.equal(updates.length, 1);
  assert.equal(browser.status().usage.weekly?.usedPercent, 7);
  browser.observe(snapshot({ notices: ["You've reached the usage limit."] }));
  browser.observe(snapshot({ notices: ["You've reached the usage limit."] }));
  assert.equal(updates.length, 2);
  assert.equal(browser.status().usage.status, "limited");
});

test("Google verification blocks background reads and worker claims until manual recovery", async () => {
  const { browser, b } = fixture();
  b.verificationRequired = true;
  b.setUsage({ status: "unknown", detail: "Google 보안 확인 필요", checkedAt: 1 });
  let opened = 0;
  browser.open = async () => { opened++; return browser.status(); };
  await assert.rejects(browser.claim("chat"), /보안 확인/);
  const usage = await GeminiWebBrowser.prototype.refreshUsage.call(browser);
  assert.equal(usage.detail, "Google 보안 확인 필요");
  assert.equal(opened, 0);
  b.win = {};
  browser.snapshot = async () => snapshot();
  await GeminiWebBrowser.prototype.refresh.call(browser, false);
  assert.equal(b.verificationRequired, true, "an automatic chat observation cannot clear a blocked usage page");
  await GeminiWebBrowser.prototype.refresh.call(browser, true);
  assert.equal(b.verificationRequired, false, "manual refresh after a visible Gemini login can recover");
});

test("automatic usage reads are coalesced and throttled between short worker turns", async () => {
  const { browser, b } = fixture();
  let reads = 0;
  b.readUsage = async () => { reads++; return browser.status().usage; };
  await Promise.all([1, 2, 3].map(() => GeminiWebBrowser.prototype.refreshUsage.call(browser)));
  await GeminiWebBrowser.prototype.refreshUsage.call(browser);
  assert.equal(reads, 1);
  await GeminiWebBrowser.prototype.refreshUsage.call(browser, true);
  assert.equal(reads, 2);
});

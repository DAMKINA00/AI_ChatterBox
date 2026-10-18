import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { GeminiWebBrowser } from "./gemini-web-browser";
import { GeminiWebAccounts } from "./gemini-web-accounts";
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

function usageFixture(t: TestContext, frames: { current: string; weekly: string; login?: boolean }[]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates: any[] = [];
  const browser = new GeminiWebBrowser("unused", usage => updates.push(usage));
  let reads = 0, destroyed = false;
  (browser as any).makeWindow = (show: boolean) => {
    assert.equal(show, false);
    return {
      isDestroyed: () => destroyed, destroy() { destroyed = true; },
      async loadURL(url: string) { assert.equal(url, "https://gemini.google.com/usage"); },
      webContents: { getURL: () => "https://gemini.google.com/usage",
        async executeJavaScript() { return frames[Math.min(reads++, frames.length - 1)]; } },
    };
  };
  return { browser, updates, reads: () => reads, destroyed: () => destroyed,
    async tick(count: number) {
      await new Promise(resolve => setImmediate(resolve));
      for (let n = 0; n < count; n++) {
        t.mock.timers.tick(400);
        await new Promise(resolve => setImmediate(resolve));
      }
    } };
}

test("usage refresh waits past headings and a partial window for both visible percentages", async t => {
  const f = usageFixture(t, [
    { current: "현재 사용량", weekly: "주간 한도" },
    { current: "현재 사용량\n0% 사용됨\n오전 12:45에 초기화", weekly: "주간 한도" },
    { current: "현재 사용량\n0% 사용됨\n오전 12:45에 초기화", weekly: "주간 한도\n10월 21일 오후 3:45에 초기화\n12% 사용됨" },
  ]);
  const pending = f.browser.refreshUsage(true);
  assert.equal(f.browser.refreshUsage(true), pending);
  await f.tick(2);
  const usage = await pending;
  assert.equal(f.reads(), 3);
  assert.equal(usage.current?.usedPercent, 0);
  assert.equal(usage.weekly?.usedPercent, 12);
  assert.equal(usage.current?.resetText, "오전 12:45에 초기화");
  assert.equal(usage.weekly?.resetText, "10월 21일 오후 3:45에 초기화");
  assert.equal(f.updates.length, 1);
  assert.equal(f.destroyed(), true);
});

test("usage polling is bounded and reports only numbers actually present at completion", async t => {
  for (const current of ["현재 사용량", "현재 사용량\n0% 사용됨", "현재 사용량\n100% 사용됨"]) {
    const f = usageFixture(t, [{ current, weekly: "주간 한도" }]);
    const pending = f.browser.refreshUsage(true);
    await f.tick(30);
    const usage = await pending;
    assert.equal(f.reads(), 30);
    assert.equal(usage.weekly, undefined);
    assert.equal(usage.status, current.includes("100%") ? "limited" : current.includes("0%") ? "available" : "unknown");
    assert.equal(f.destroyed(), true);
    t.mock.timers.reset();
  }
});

test("login redirect during quota loading clears old numeric usage", async t => {
  const f = usageFixture(t, [
    { current: "현재 사용량", weekly: "주간 한도" },
    { current: "", weekly: "", login: true },
  ]);
  (f.browser as any).setUsage({ status: "available", detail: "old", checkedAt: 1, current: { usedPercent: 20 } });
  const pending = f.browser.refreshUsage(true);
  await f.tick(1);
  const usage = await pending;
  assert.match(usage.detail, /로그인이 필요/);
  assert.equal(usage.current, undefined);
  assert.equal(f.destroyed(), true);
});

test("manual quota refresh still runs while the account browser displays its usage page", async () => {
  const { browser, b } = fixture();
  b.win = {};
  browser.snapshot = async () => snapshot({ url: "https://gemini.google.com/usage", composer: false, model: "" });
  let reads = 0;
  browser.refreshUsage = async () => {
    reads++;
    return b.setUsage({ status: "available", detail: "new", checkedAt: Date.now(), current: { usedPercent: 0 }, weekly: { usedPercent: 12 } });
  };
  const status = await GeminiWebBrowser.prototype.refresh.call(browser);
  assert.equal(reads, 1);
  assert.equal(status.state, "ready");
  assert.equal(status.usage.current?.usedPercent, 0);
  assert.equal(status.usage.weekly?.usedPercent, 12);
});

test("usage-page exception still rejects sign-in pages and missing editors on chat pages", async () => {
  for (const patch of [{ url: "https://gemini.google.com/usage", login: true }, { url: "https://gemini.google.com/app" }]) {
    const { browser, b } = fixture();
    b.win = {};
    browser.snapshot = async () => snapshot({ ...patch, composer: false });
    browser.refreshUsage = async () => { throw new Error("must not query"); };
    const status = await GeminiWebBrowser.prototype.refresh.call(browser);
    assert.equal(status.state, patch.login ? "login_required" : "error");
    assert.match(status.message, patch.login ? /로그인을 완료/ : /입력창/);
  }
});

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

test("web image downloads require owner, trusted HTTPS host, image MIME and bounded bytes", async () => {
  const { browser, b } = fixture();
  const calls: any[] = [];
  b.owner = "own";
  b.win = { isDestroyed: () => false, webContents: { session: { fetch: async (url: string, options: any) => {
    calls.push({ url, options }); return new Response(Buffer.from("image bytes"), { headers: { "Content-Type": "image/png" } });
  } } } };
  const signal = new AbortController().signal;
  await assert.rejects(browser.imageBytes("foreign", "https://lh3.googleusercontent.com/image", signal), /소유 작업/);
  for (const url of ["http://lh3.googleusercontent.com/a", "https://googleusercontent.com.evil.test/a", "file:///C:/private.png", "https://name:password@lh3.googleusercontent.com/a"]) await assert.rejects(browser.imageBytes("own", url, signal), /지원하지 않는/);
  assert.equal(calls.length, 0);
  assert.equal(await browser.imageBytes("own", "https://lh3.googleusercontent.com/a", signal), Buffer.from("image bytes").toString("base64"));
  assert.equal(calls[0].options.redirect, "error");
  b.win.webContents.session.fetch = async () => new Response("html", { headers: { "Content-Type": "text/html" } });
  await assert.rejects(browser.imageBytes("own", "https://lh3.googleusercontent.com/a", signal), /다운로드/);
  b.win.webContents.session.fetch = async () => new Response(new Uint8Array(32 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } });
  await assert.rejects(browser.imageBytes("own", "https://lh3.googleusercontent.com/a", signal), /32MB/);
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

test("visible low request counts update quota without reading assistant prose", () => {
  const { browser, b } = fixture();
  b.setUsage({ status: "available", detail: "old", checkedAt: Date.now(), weekly: { usedPercent: 5 } });
  browser.observe(snapshot({ notices: ["Remaining: 1 of 100 requests"] }));
  assert.equal(browser.status().usage.remaining, 1);
  assert.equal(browser.status().usage.limit, 100);
});

function loginFixture(t: TestContext) {
  const confirmed: any[] = [];
  const usageWrites: any[] = [];
  const browser = new GeminiWebBrowser("unused", usage => usageWrites.push(usage), "gemini-1", undefined, status => confirmed.push(status));
  const b = browser as any;
  let hidden = 0, flushed = 0, destroyed = false;
  const win = { isDestroyed: () => destroyed, show() {}, focus() {}, hide() { hidden++; },
    destroy() { destroyed = true; }, webContents: { stop() {}, session: { flushStorageData() { flushed++; } } } };
  b.win = win;
  browser.open = async () => browser.status();
  browser.refresh = async () => browser.status();
  browser.refreshUsage = async () => browser.status().usage;
  t.after(() => b.cancelLoginWatch());
  return { browser, b, win, confirmed, usageWrites, counts: () => ({ hidden, flushed }) };
}

test("waiting for Google login does not persist identical unknown quota every second", async t => {
  const { browser, b, usageWrites } = loginFixture(t);
  browser.snapshot = async () => snapshot({ login: true });
  await browser.login();
  const watch = b.loginWatch;
  clearTimeout(watch.timer);
  for (let n = 0; n < 3; n++) { await b.checkLogin(watch); clearTimeout(watch.timer); }
  assert.equal(usageWrites.length, 1);
  assert.equal(browser.status().state, "login_required");
});

test("explicit login waits for authenticated composer, closes once and publishes confirmation", async t => {
  const { browser, b, confirmed, counts } = loginFixture(t);
  browser.snapshot = async () => snapshot({ login: true });
  const pending = await browser.login();
  assert.equal(pending.state, "login_required");
  assert.match(pending.message, /자동으로 닫습니다/);
  const watch = b.loginWatch;
  assert.ok(watch.timer);
  assert.equal(confirmed.length, 0);
  browser.snapshot = async () => snapshot();
  await b.checkLogin(watch);
  await b.checkLogin(watch);
  assert.equal(browser.status().state, "ready");
  assert.match(browser.status().message, /로그인 완료/);
  assert.deepEqual(counts(), { hidden: 1, flushed: 1 });
  assert.equal(confirmed.length, 1);
  assert.equal(b.loginWatch, undefined);
});

test("login monitoring never treats an OAuth page, loading editor or visible sign-in button as success", async t => {
  const { browser, b, confirmed, counts } = loginFixture(t);
  browser.snapshot = async () => null;
  await browser.login();
  const watch = b.loginWatch;
  clearTimeout(watch.timer);
  for (const incomplete of [snapshot({ composer: false }), snapshot({ model: "" }), snapshot({ login: true })]) {
    browser.snapshot = async () => incomplete;
    await b.checkLogin(watch);
    // Run a deterministic observation instead of leaving a second scheduled tick behind.
    clearTimeout(watch.timer);
  }
  assert.equal(confirmed.length, 0);
  assert.equal(browser.status().state, "login_required");
  assert.equal(counts().hidden, 0);
});

test("successful sign-in preserves a manually typed draft or generating response", async t => {
  for (const patch of [{ draft: "unfinished dialogue" }, { generating: true }]) {
    const { browser, b, confirmed, counts } = loginFixture(t);
    browser.snapshot = async () => snapshot(patch);
    await browser.login();
    assert.equal(browser.status().state, "busy");
    assert.equal(counts().hidden, 0);
    assert.match(confirmed[0].message, /브라우저를 유지/);
    assert.equal(b.loginWatch, undefined);
  }
});

test("manual browser opening cancels auto-close and login cannot close a worker-owned browser", async t => {
  const { browser, b, confirmed, counts } = loginFixture(t);
  browser.snapshot = async () => snapshot({ login: true });
  await browser.login();
  const oldWatch = b.loginWatch;
  await GeminiWebBrowser.prototype.open.call(browser, true);
  browser.snapshot = async () => snapshot();
  await b.checkLogin(oldWatch);
  assert.equal(b.loginWatch, undefined);
  assert.equal(confirmed.length, 0);
  b.owner = "active-worker";
  await browser.login();
  assert.equal(b.owner, "active-worker");
  assert.equal(b.loginWatch, undefined);
  assert.equal(counts().hidden, 0);
});

test("late login observation cannot report success after shutdown", async t => {
  const { browser, b, win, confirmed, counts } = loginFixture(t);
  let finish!: (s: WebSnapshot) => void;
  browser.snapshot = () => new Promise(resolve => { finish = resolve; });
  const pending = browser.login();
  await new Promise(resolve => setImmediate(resolve));
  await browser.dispose();
  finish(snapshot());
  await pending;
  assert.equal(win.isDestroyed(), true);
  assert.equal(b.loginWatch, undefined);
  assert.equal(confirmed.length, 0);
  assert.equal(counts().hidden, 0);
});

test("closing during login opening never starts a watcher for a missing window", async t => {
  const { browser, b, confirmed } = loginFixture(t);
  browser.open = async () => { b.win = undefined; return browser.status(); };
  await browser.login();
  assert.equal(b.loginWatch, undefined);
  assert.equal(confirmed.length, 0);
});

test("explicit visible login recovers Google verification only after a confirmed signed-in page", async t => {
  const { browser, b, confirmed } = loginFixture(t);
  b.verificationRequired = true;
  browser.snapshot = async () => null;
  await browser.login();
  const watch = b.loginWatch;
  assert.equal(b.verificationRequired, true);
  browser.snapshot = async () => snapshot();
  await b.checkLogin(watch);
  assert.equal(b.verificationRequired, false);
  assert.equal(confirmed.length, 1);
});

test("account pool login callbacks and windows stay isolated for two simultaneous sign-ins", async t => {
  const confirmed: any[] = [], values = new Map<string, string>();
  const pool = new GeminiWebAccounts("unused", { getSetting: key => values.get(key), setSetting: (key, value) => { values.set(key, value); } }, undefined, status => confirmed.push(status));
  pool.add();
  t.after(() => pool.dispose());
  const first = pool.browser("gemini-1"), second = pool.browser("gemini-2");
  let firstHidden = 0, secondHidden = 0;
  for (const [browser, hide] of [[first, () => firstHidden++], [second, () => secondHidden++]] as const) {
    const b = browser as any;
    b.win = { isDestroyed: () => false, hide, destroy() {}, webContents: { stop() {}, session: { flushStorageData() {} } } };
    browser.open = async () => browser.status();
    browser.refreshUsage = async () => browser.status().usage;
  }
  first.snapshot = async () => snapshot();
  second.snapshot = async () => snapshot({ login: true });
  await Promise.all([first.login(), second.login()]);
  assert.deepEqual(confirmed.map(status => status.accountId), ["gemini-1"]);
  assert.equal(firstHidden, 1);
  assert.equal(secondHidden, 0);
  assert.equal(pool.list()[1].state, "login_required");
  second.snapshot = async () => snapshot();
  await (second as any).checkLogin((second as any).loginWatch);
  assert.deepEqual(confirmed.map(status => status.accountId), ["gemini-1", "gemini-2"]);
  assert.equal(secondHidden, 1);
});

test("authentication redirects allow cookie handoff while blocking unrelated hosts and keeping URL secrets out of feedback", () => {
  const { browser, b } = fixture();
  const win = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler() {} }) });
  b.protectNavigation(win);
  for (const url of ["https://accounts.google.com/signin", "https://www.google.com/accounts/SetSID", "https://www.google.co.kr/accounts/SetSID", "https://accounts.youtube.com/accounts/CheckCookie", "https://gemini.google.com/app"]) {
    let blocked = false;
    win.webContents.emit("will-redirect", { preventDefault: () => { blocked = true; } }, url);
    assert.equal(blocked, false, url);
  }
  for (const url of ["http://accounts.google.com/signin", "https://accounts.google.com.evil.test/login?token=secret", "https://www.google.com/search?q=secret", "https://accounts.youtube.com/watch?v=secret"]) {
    let blocked = false;
    win.webContents.emit("will-navigate", { preventDefault: () => { blocked = true; } }, url);
    assert.equal(blocked, true, url);
    assert.equal(browser.status().state, "error");
    assert.ok(!browser.status().message.includes("secret"));
  }
});

test("startup abort after allowed sign-in navigation preserves the window, but real connection errors still fail", async () => {
  for (const [code, redirected, expected] of [["ERR_ABORTED", true, true], ["ERR_ABORTED", false, false], ["ERR_CONNECTION_REFUSED", true, false]] as const) {
    const { b } = fixture();
    let destroyed = false;
    const contents = new EventEmitter();
    const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; },
      loadURL: async () => { if (redirected) contents.emit("did-start-navigation", {}, "https://gemini.google.com/signin?continue=fixture", false, true); throw Object.assign(new Error(code), { code }); } });
    b.makeWindow = () => win;
    if (expected) { assert.equal(await b.createWindow(true), win); assert.equal(destroyed, false); }
    else { await assert.rejects(b.createWindow(true), new RegExp(code)); assert.equal(destroyed, true); }
    assert.equal(contents.listenerCount("did-start-navigation"), 0);
  }
});

test("login popup drafts are preserved and a new parent draft prevents an asynchronous return navigation", async t => {
  for (const popupDraft of [true, false]) {
    const { browser, b, win, confirmed } = loginFixture(t);
    let navigated = 0;
    (win as any).loadURL = async () => { navigated++; };
    (win.webContents as any).getURL = () => "https://gemini.google.com/app";
    let current = snapshot({ login: true });
    browser.snapshot = async () => current;
    const popup = { isDestroyed: () => false, webContents: { getURL: () => "https://gemini.google.com/app", executeJavaScript: async () => {
      if (!popupDraft) current = snapshot({ draft: "parent draft typed during observation" });
      return snapshot({ draft: popupDraft ? "popup draft" : "" });
    } } };
    b.authWindows.add(popup);
    await browser.login();
    assert.equal(navigated, 0);
    assert.equal(confirmed.length, 0);
    await assert.rejects(browser.claim("worker"), /로그인 창/);
    b.authWindows.clear();
  }
});

test("a failed return from an authenticated popup reports an error instead of waiting forever", async t => {
  const { browser, b, win, confirmed } = loginFixture(t);
  (win.webContents as any).getURL = () => "https://gemini.google.com/app";
  (win as any).loadURL = async () => { throw Object.assign(new Error("offline"), { code: "ERR_CONNECTION_REFUSED" }); };
  browser.snapshot = async () => snapshot({ login: true });
  b.authWindows.add({ isDestroyed: () => false, webContents: { getURL: () => "https://gemini.google.com/app", executeJavaScript: async () => snapshot() } });
  await browser.login();
  assert.equal(browser.status().state, "error");
  assert.match(browser.status().message, /Gemini 화면을 열지 못했습니다/);
  assert.equal(b.loginWatch, undefined);
  assert.equal(confirmed.length, 0);
  b.authWindows.clear();
});

test("an authenticated opener never destroys a popup containing a draft or generating response", async t => {
  for (const patch of [{ draft: "popup draft" }, { generating: true }]) {
    const { browser, b, confirmed, counts } = loginFixture(t);
    let destroyed = false;
    b.authWindows.add({ isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, webContents: {
      getURL: () => "https://gemini.google.com/app", executeJavaScript: async () => snapshot(patch) } });
    browser.snapshot = async () => snapshot();
    await browser.login();
    assert.equal(destroyed, false);
    assert.equal(browser.status().state, "busy");
    assert.equal(confirmed.length, 1);
    assert.equal(counts().hidden, 0);
    b.authWindows.clear();
  }
});

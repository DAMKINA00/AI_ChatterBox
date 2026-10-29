import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COOKIE, FAIL_LIMIT_IP, GLOBAL_DELAY_AFTER, LOGIN_FAILED, LOGIN_TIME_BUCKETS_MS, Limiter, RemoteWeb, SESSION_IDLE_MS, globalDelayMs, loginPaddingMs, normalizeOrigin } from "./remote-web";

const PASSWORD = "correct horse battery";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(ok => server.close(() => ok()));
  return port;
}

async function setup(t: { after(fn: () => unknown): void }, results: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-remote-"));
  mkdirSync(join(dir, "static", "assets"), { recursive: true });
  writeFileSync(join(dir, "static", "remote.html"), "<!doctype html><title>remote</title>");
  writeFileSync(join(dir, "static", "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "nope");
  const calls: [string, unknown[]][] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const remote = new RemoteWeb({
    file: join(dir, "remote-web.json"), staticDir: join(dir, "static"), now: () => now,
    // Record waits instead of sleeping (minimum login time and the global delay).
    sleep: async ms => { sleeps.push(ms); },
    call: async (channel, args) => {
      calls.push([channel, args]);
      if (channel in results) return results[channel];
      if (channel === "chats:list") return [{ id: 1, title: "작업", status: "working" }];
      if (channel === "projects:list") return [{ id: 9, name: "P", archived: false, folder: "D:\\secret", settings: {} }];
      if (channel === "chats:approve") return "once";
      if (channel === "chats:answerAsk") return true;
      return [];
    },
  });
  const port = await freePort();
  await remote.action("set-password", { password: PASSWORD });
  await remote.action("update", { enabled: true, port, publicOrigin: "https://ai.example.test" });
  t.after(async () => { await remote.stop(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const origin = "https://ai.example.test";
  const request = (path: string, init: RequestInit & { cookie?: string; csrf?: string; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    if (init.method === "POST") {
      headers["content-type"] ??= "application/json";
      if (init.origin !== null) headers.origin = init.origin ?? origin;
    }
    return fetch(base + path, { ...init, headers });
  };
  /** `ip` arrives as X-ChatterBox-Client-IP, as the Caddy site block sets it. */
  const login = async (password = PASSWORD, ip?: string) => {
    const res = await request("/api/login", { method: "POST", headers: ip ? { "x-chatterbox-client-ip": ip } : {}, body: JSON.stringify({ password }) });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const body = await res.json() as { csrf?: string; error?: string };
    return { res, body, setCookie, cookie: setCookie.split(";")[0] };
  };
  return { dir, remote, calls, sleeps, request, login, port, advance: (ms: number) => { now += ms; } };
}

test("origin normalization requires https or loopback http and rejects paths", () => {
  assert.equal(normalizeOrigin("https://ai.damkina.net/"), "https://ai.damkina.net");
  assert.equal(normalizeOrigin("http://127.0.0.1:47821"), "http://127.0.0.1:47821");
  assert.throws(() => normalizeOrigin("http://ai.damkina.net"));
  assert.throws(() => normalizeOrigin("https://ai.damkina.net/app"));
});

test("disabled by default, refuses to enable without a password, and stores only a hash", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cbx-remote-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = new RemoteWeb({ file: join(dir, "remote-web.json"), staticDir: dir, call: async () => [] });
  await remote.apply();
  assert.equal(remote.status().enabled, false);
  assert.equal(remote.status().running, false);
  await assert.rejects(remote.action("update", { enabled: true }), /비밀번호/);
  await assert.rejects(remote.action("set-password", { password: "short" }), /12자/);
  await remote.action("set-password", { password: PASSWORD });
  const saved = readFileSync(join(dir, "remote-web.json"), "utf8");
  assert.ok(!saved.includes(PASSWORD));
  assert.match(saved, /"hash"/);
  assert.equal(JSON.stringify(remote.status()).includes("hash"), false);
});

test("only the login endpoint and static page work without a session; no path traversal", async (t) => {
  const s = await setup(t);
  assert.equal((await s.request("/")).status, 200);
  assert.equal((await s.request("/assets/app.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await s.request("/assets/..%2fsecret.txt")).status, 404);
  assert.equal((await s.request("/assets/%2e%2e/%2e%2e/secret.txt")).status, 404);
  for (const path of ["/api/session", "/api/chats", "/api/chats/1", "/api/stream"]) assert.equal((await s.request(path)).status, 401, path);
  assert.equal((await s.request("/api/chats/1/send", { method: "POST", body: JSON.stringify({ text: "x" }) })).status, 401);
  // fetch() cannot override Host, so a DNS-rebinding style request is sent with node:http.
  const rebinding = await new Promise<number>((ok, fail) => httpGet({ host: "127.0.0.1", port: s.port, path: "/", headers: { host: "evil.example" } }, res => { res.resume(); ok(res.statusCode!); }).on("error", fail));
  assert.equal(rebinding, 421);
  assert.equal(s.calls.length, 0);
});

test("login sets a strict session cookie; wrong passwords lock out the client", async (t) => {
  const s = await setup(t);
  const ok = await s.login();
  assert.equal(ok.res.status, 200);
  assert.match(ok.setCookie, new RegExp(`^${COOKIE}=`));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(ok.setCookie.includes(flag), flag);
  assert.ok(ok.body.csrf);
  // Login from a foreign origin is refused before the password is checked.
  assert.equal((await s.request("/api/login", { method: "POST", origin: "https://evil.example", body: JSON.stringify({ password: PASSWORD }) })).status, 403);
  for (let i = 0; i < FAIL_LIMIT_IP; i++) assert.equal((await s.login("wrong password!!")).res.status, 401);
  const locked = await s.login();
  assert.equal(locked.res.status, 429);
  assert.ok(Number(locked.res.headers.get("retry-after")) > 0);
});

test("parallel wrong guesses cannot overrun the per-IP lockout", async (t) => {
  const s = await setup(t);
  // One client: only one login may be pending at a time, so a burst is mostly refused outright.
  const burst = (await Promise.all(Array.from({ length: FAIL_LIMIT_IP * 2 }, () => s.login("parallel wrong guess", "203.0.113.1")))).map(r => r.res.status);
  assert.ok(burst.filter(code => code === 401).length <= FAIL_LIMIT_IP, String(burst));
  assert.ok(burst.every(code => code === 401 || code === 429), String(burst));
  for (let i = 0; i < FAIL_LIMIT_IP; i++) await s.login("sequential wrong guess", "203.0.113.1");
  assert.equal((await s.login(PASSWORD, "203.0.113.1")).res.status, 429);
});

test("failures from a few IPs cannot lock everyone out; the global count only slows verification", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < FAIL_LIMIT_IP; i++) assert.equal((await s.login("wrong guess A", "198.51.100.1")).res.status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await s.login("wrong guess B", "198.51.100.2")).res.status, 401);
  s.sleeps.length = 0;
  // 9 failures in the window: no lock for a third client, only a delay before checking.
  assert.equal((await s.login(PASSWORD, "198.51.100.3")).res.status, 200);
  assert.ok(s.sleeps.includes(globalDelayMs(FAIL_LIMIT_IP + 4)), String(s.sleeps));
  assert.equal(globalDelayMs(GLOBAL_DELAY_AFTER), 0);
  assert.equal(globalDelayMs(1_000), 10_000);
});

test("every login answer is uniform and padded to a fixed time bucket; the real reason stays in the app", async (t) => {
  const s = await setup(t);
  s.sleeps.length = 0;
  const failed = await s.login("wrong password!!");
  assert.equal(failed.body.error, LOGIN_FAILED);
  assert.ok(s.sleeps.some(ms => ms > LOGIN_TIME_BUCKETS_MS[0] * 0.5 && ms <= LOGIN_TIME_BUCKETS_MS[0]), String(s.sleeps));
  assert.equal(s.remote.status().loginFailures[0].detail, "로컬 비밀번호 불일치");
  // Answers land on bucket totals: 1.5 s normally, 6 s for a slow NAS (e.g. a timeout), and so on.
  assert.equal(loginPaddingMs(200), 1_300);
  assert.equal(loginPaddingMs(2_500), 3_500);
  assert.equal(loginPaddingMs(30_000), 0);
});

test("the client IP comes only from the Caddy-set header behind a trusted loopback proxy; X-Forwarded-For is ignored", async (t) => {
  const s = await setup(t);
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } }) as any;
  assert.equal(s.remote.clientIp(req("127.0.0.1", { "x-chatterbox-client-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(s.remote.clientIp(req("::ffff:127.0.0.1", { "x-chatterbox-client-ip": "2001:db8::1" })), "2001:db8::1");
  assert.equal(s.remote.clientIp(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), "127.0.0.1");
  assert.equal(s.remote.clientIp(req("127.0.0.1", { "x-chatterbox-client-ip": "not-an-ip" })), "127.0.0.1");
  assert.equal(s.remote.clientIp(req("192.168.0.5", { "x-chatterbox-client-ip": "203.0.113.9" })), "192.168.0.5");
  await s.remote.action("update", { trustProxy: false });
  assert.equal(s.remote.clientIp(req("127.0.0.1", { "x-chatterbox-client-ip": "203.0.113.9" })), "127.0.0.1");
});

test("the login limiter drops waiting tasks on timeout or disconnect and caps its queue", async () => {
  const limiter = new Limiter(1, 2);
  let release = () => {};
  const blocker = limiter.run(() => new Promise<string>(ok => { release = () => ok("first"); }), { timeoutMs: 60_000, signal: new AbortController().signal });
  const timedOut = limiter.run(async () => "never", { timeoutMs: 30, signal: new AbortController().signal });
  const leaving = new AbortController();
  const aborted = limiter.run(async () => "never", { timeoutMs: 60_000, signal: leaving.signal });
  await assert.rejects(limiter.run(async () => "over", { timeoutMs: 60_000, signal: new AbortController().signal }), (e: any) => e.status === 503);
  leaving.abort();
  await assert.rejects(aborted, (e: any) => e.status === 499);
  await assert.rejects(timedOut, (e: any) => e.status === 503);
  assert.equal(limiter.size, 1);
  release();
  assert.equal(await blocker, "first");
  assert.equal(limiter.size, 0);
});

test("state changes need the session CSRF token and an allowed origin", async (t) => {
  const s = await setup(t);
  const { cookie, body } = await s.login();
  const send = (init: { csrf?: string; origin?: string | null; contentType?: string }) => s.request("/api/chats/1/send", {
    method: "POST", cookie, csrf: init.csrf, origin: init.origin,
    headers: init.contentType ? { "content-type": init.contentType } : undefined, body: JSON.stringify({ text: "추가 지시", delivery: "next" }),
  });
  assert.equal((await send({})).status, 403);
  assert.equal((await send({ csrf: "x".repeat(32) })).status, 403);
  assert.equal((await send({ csrf: body.csrf, origin: "https://evil.example" })).status, 403);
  assert.equal((await send({ csrf: body.csrf, origin: null })).status, 403);
  assert.equal((await send({ csrf: body.csrf, contentType: "text/plain" })).status, 415);
  assert.equal(s.calls.filter(([c]) => c === "chats:send").length, 0);
  assert.equal((await send({ csrf: body.csrf })).status, 200);
  assert.deepEqual(s.calls.find(([c]) => c === "chats:send"), ["chats:send", [1, "추가 지시", [], "next"]]);
});

test("reads chats/history and forwards instructions, stop, approvals and answers to the core", async (t) => {
  const s = await setup(t);
  const { cookie, body: { csrf } } = await s.login();
  const list = await (await s.request("/api/chats", { cookie })).json() as { projects: Record<string, unknown>[] };
  assert.deepEqual(list.projects, [{ id: 9, name: "P", archived: false }]);
  assert.equal((await s.request("/api/chats/1", { cookie })).status, 200);
  assert.equal((await s.request("/api/chats/2", { cookie })).status, 404);
  const post = (path: string, body: unknown) => s.request(path, { method: "POST", cookie, csrf, body: JSON.stringify(body) });
  assert.equal((await post("/api/chats/1/send", { text: "새 지시" })).status, 200);
  assert.equal((await post("/api/chats/1/send", { text: "  " })).status, 400);
  assert.equal((await post("/api/chats/1/send", { text: "x", delivery: "later" })).status, 400);
  assert.equal((await post("/api/chats/1/stop", {})).status, 200);
  assert.equal((await post("/api/chats/1/approve", { approvalId: "a1", decision: "deny" })).status, 200);
  assert.equal((await post("/api/chats/1/approve", { approvalId: "a1", decision: "always" })).status, 400);
  assert.equal((await post("/api/chats/1/answer", { askId: "q1", answer: "A안" })).status, 200);
  assert.deepEqual(s.calls.filter(([c]) => !["chats:list", "projects:list", "chats:events", "chats:agents", "chats:consults"].includes(c)), [
    ["chats:send", [1, "새 지시", [], "now"]],
    ["chats:stop", [1]],
    ["chats:approve", [1, "a1", "deny"]],
    ["chats:answerAsk", [1, "q1", "A안"]],
  ]);
});

test("an approval or question already answered in the app returns 409", async (t) => {
  const s = await setup(t, { "chats:approve": null, "chats:answerAsk": false });
  const { cookie, body: { csrf } } = await s.login();
  const post = (path: string, body: unknown) => s.request(path, { method: "POST", cookie, csrf, body: JSON.stringify(body) });
  assert.equal((await post("/api/chats/1/approve", { approvalId: "a1", decision: "once" })).status, 409);
  assert.equal((await post("/api/chats/1/answer", { askId: "q1", answer: "B" })).status, 409);
});

test("sessions expire, log out, and are revoked by password change or logout-all", async (t) => {
  const s = await setup(t);
  const first = await s.login();
  assert.equal((await s.request("/api/session", { cookie: first.cookie })).status, 200);
  s.advance(SESSION_IDLE_MS + 1);
  assert.equal((await s.request("/api/session", { cookie: first.cookie })).status, 401);

  const second = await s.login();
  assert.equal(s.remote.status().sessions.length, 1);
  assert.equal((await s.request("/api/logout", { method: "POST", cookie: second.cookie, csrf: second.body.csrf, body: "{}" })).status, 200);
  assert.equal((await s.request("/api/session", { cookie: second.cookie })).status, 401);

  const third = await s.login();
  s.remote.logoutAll();
  assert.equal((await s.request("/api/session", { cookie: third.cookie })).status, 401);

  const fourth = await s.login();
  await s.remote.action("set-password", { password: "another long password" });
  assert.equal((await s.request("/api/session", { cookie: fourth.cookie })).status, 401);
  assert.equal((await s.login()).res.status, 401);
});

test("the event stream only delivers the selected chat's events", async (t) => {
  const s = await setup(t);
  const { cookie } = await s.login();
  const controller = new AbortController();
  const res = await s.request("/api/stream?chat=1", { cookie, signal: controller.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body!.getReader();
  await reader.read(); // retry line
  s.remote.publish("chat:event", [{ id: 5, chatId: 2, event: { type: "text", text: "다른 채팅" } }]);
  s.remote.publish("usage", [{}]);
  s.remote.publish("chat:event", [{ id: 6, chatId: 1, event: { type: "text", text: "보이는 채팅" } }]);
  const chunk = new TextDecoder().decode((await reader.read()).value);
  // Every message carries a sequence number (SSE id), counted across all channels.
  assert.match(chunk, /^id: 3\nevent: chat:event\n/);
  assert.match(chunk, /보이는 채팅/);
  assert.doesNotMatch(chunk, /다른 채팅/);
  controller.abort();
  // A snapshot reports the number it started from; the page replays only newer stream messages on top.
  const snapshot = await (await s.request("/api/chats/1", { cookie })).json() as { seq: number };
  assert.equal(snapshot.seq, 3);
});

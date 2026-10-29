import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DsmProvider, normalizeDsmUrl, normalizeFingerprint, probeDsm } from "./remote-auth";
import { FAIL_LIMIT_ACCOUNT, RemoteWeb } from "./remote-web";

// Test-only self-signed certificate (like DSM's default certificate), shared with scripts/e2e-remote-web.mjs.
import fixture from "../../scripts/fixtures/dsm-test-cert.json";
const { cert: CERT, key: KEY, fingerprint: FINGERPRINT } = fixture;

interface Seen { method: string; path: string; params: Record<string, string> }

/** Minimal DSM Web API: SYNO.API.Info query + SYNO.API.Auth login/logout on entry.cgi. */
async function mockDsm(t: { after(fn: () => unknown): void }, accounts: Record<string, { password: string; otp?: string; code?: number }> = {}) {
  const seen: Seen[] = [];
  // hold(): the next login answer waits until release() — a slow NAS for race tests.
  let gate: Promise<void> | undefined;
  let release = () => {};
  let arrived = () => {};
  const server: Server = createServer({ key: KEY, cert: CERT }, (req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url!, "https://dsm");
      const params = Object.fromEntries([...url.searchParams, ...new URLSearchParams(body)]);
      seen.push({ method: req.method!, path: url.pathname, params });
      const reply = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname === "/webapi/query.cgi") return reply({ success: true, data: { "SYNO.API.Auth": { path: "entry.cgi", minVersion: 1, maxVersion: 7 } } });
      if (url.pathname !== "/webapi/entry.cgi" || params.api !== "SYNO.API.Auth") return reply({ success: false, error: { code: 102 } });
      if (params.method === "logout") return reply({ success: true });
      if (gate) { arrived(); await gate; gate = undefined; }
      // DSM account names are case-insensitive.
      const account = accounts[params.account?.toLowerCase()];
      if (account?.code) return reply({ success: false, error: { code: account.code } });
      if (!account || account.password !== params.passwd) return reply({ success: false, error: { code: 400 } });
      if (account.otp && !params.otp_code) return reply({ success: false, error: { code: 403 } });
      if (account.otp && account.otp !== params.otp_code) return reply({ success: false, error: { code: 404 } });
      reply({ success: true, data: { sid: "SID-SECRET" } });
    });
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }));
  const hold = () => {
    gate = new Promise(ok => { release = ok; });
    return { arrived: new Promise<void>(ok => { arrived = ok; }), release: () => release() };
  };
  return { url: `https://127.0.0.1:${(server.address() as { port: number }).port}`, seen, hold };
}

test("DSM URL and fingerprint normalization", () => {
  assert.equal(normalizeDsmUrl("https://192.168.0.250:5001/"), "https://192.168.0.250:5001");
  assert.throws(() => normalizeDsmUrl("http://192.168.0.250:5000"), /https/);
  assert.equal(normalizeFingerprint("64:a2:9b:ee:b7:7e:80:6d:c1:fc:a0:72:46:1c:f2:f2:98:1f:d4:cb:12:7e:3a:7e:eb:0b:2c:e9:7a:64:34:af"), FINGERPRINT);
  assert.throws(() => normalizeFingerprint("AB:CD"));
});

test("probe reads the certificate fingerprint and login API without sending credentials", async (t) => {
  const dsm = await mockDsm(t);
  const probe = await probeDsm(dsm.url);
  assert.deepEqual(probe, { fingerprint: FINGERPRINT, trusted: false, authPath: "entry.cgi", version: 6 });
  assert.ok(dsm.seen.every(s => !("passwd" in s.params)));
});

test("pinned login verifies the account, sends the password in the POST body, then logs out", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const provider = new DsmProvider({ url: dsm.url, certSha256: FINGERPRINT, allowedUsers: ["admin"] });
  assert.deepEqual(await provider.verify({ username: "Admin", password: "nas-pass" }), { ok: true, user: "admin" });
  const login = dsm.seen.find(s => s.params.method === "login")!;
  assert.equal(login.method, "POST");
  assert.equal(login.params.version, "6");
  assert.equal(login.params.passwd, "nas-pass");
  assert.ok(dsm.seen.every(s => s.method === "GET" ? !s.params.passwd : true));
  // The DSM logout runs in the background (it must not hold the login queue).
  while (!dsm.seen.some(s => s.params.method === "logout")) await new Promise(ok => setTimeout(ok, 5));
  assert.deepEqual(dsm.seen.find(s => s.params.method === "logout")?.params._sid, "SID-SECRET");
});

test("a wrong or missing pin never sends the password", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const wrongPin = await new DsmProvider({ url: dsm.url, certSha256: "00".repeat(32), allowedUsers: ["admin"] }).verify({ username: "admin", password: "nas-pass" });
  assert.equal(wrongPin.ok, false);
  assert.match(!wrongPin.ok ? wrongPin.detail : "", /지문/);
  // Nothing was sent, so DSM's failure count cannot have moved: not counted toward the NAS-wide cap.
  assert.ok(!wrongPin.ok && !wrongPin.nasRejected);
  const noPin = await new DsmProvider({ url: dsm.url, allowedUsers: ["admin"] }).verify({ username: "admin", password: "nas-pass" });
  assert.equal(noPin.ok, false);
  assert.equal(!noPin.ok && noPin.failure, false);
  assert.equal(dsm.seen.length, 0);
});

test("allow-list is required and unlisted accounts never reach the NAS", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" }, guest: { password: "g" } });
  const empty = await new DsmProvider({ url: dsm.url, certSha256: FINGERPRINT, allowedUsers: [] }).verify({ username: "admin", password: "nas-pass" });
  assert.equal(empty.ok, false);
  const other = await new DsmProvider({ url: dsm.url, certSha256: FINGERPRINT, allowedUsers: ["admin"] }).verify({ username: "guest", password: "g" });
  assert.deepEqual(other, { ok: false, detail: "허용 목록에 없는 아이디(guest)", failure: true });
  assert.equal(dsm.seen.length, 0);
});

test("DSM error codes map to detailed reasons for the app; OTP is forwarded", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "p", otp: "123456" }, blocked: { password: "p", code: 407 }, off: { password: "p", code: 401 } });
  const provider = new DsmProvider({ url: dsm.url, certSha256: FINGERPRINT, allowedUsers: ["admin", "blocked", "off"] });
  const detail = async (input: { username: string; password: string; otp?: string }) => { const r = await provider.verify(input); return r.ok ? "ok" : `${r.failure}:${r.detail}`; };
  assert.match(await detail({ username: "admin", password: "x" }), /^true:아이디 또는 비밀번호.*400/);
  assert.match(await detail({ username: "admin", password: "p" }), /^true:.*OTP\)를 입력.*403/);
  assert.match(await detail({ username: "admin", password: "p", otp: "000000" }), /^true:.*OTP\)가 맞지.*404/);
  assert.match(await detail({ username: "admin", password: "p", otp: "12ab" }), /6~8자리/);
  assert.equal(await detail({ username: "admin", password: "p", otp: "123456" }), "ok");
  assert.match(await detail({ username: "blocked", password: "p" }), /^false:.*차단.*407/);
  assert.match(await detail({ username: "off", password: "p" }), /^true:.*비활성화.*401/);
});

test("an unreachable NAS is reported without counting as a wrong password", async () => {
  const closed = createNetServer();
  await new Promise<void>(ok => closed.listen(0, "127.0.0.1", ok));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>(ok => closed.close(() => ok()));
  const result = await new DsmProvider({ url: `https://127.0.0.1:${port}`, certSha256: FINGERPRINT, allowedUsers: ["admin"] }).verify({ username: "admin", password: "p" });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure, false);
  assert.match(!result.ok ? result.detail : "", /연결하지 못했습니다/);
  assert.ok(!result.ok && !result.nasRejected);
});

test("a login the NAS received but never answered (timeout) counts toward the NAS-wide cap", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const { remote, login } = await dsmRemote(t, dsm);
  await remote.action("update", { dsmFailureLimit: 1 });
  // The mock records the login, then holds its answer past the 2.5 s request timeout.
  const stalled = dsm.hold();
  t.after(() => stalled.release());
  const first = await login({ username: "admin", password: "wrong" }, "192.0.2.10");
  assert.equal(first.status, 401);
  assert.equal(dsm.seen.filter(s => s.params.method === "login").length, 1);
  assert.match(remote.status().loginFailures[0].detail, /시간이 초과.*NAS 보호 상한에 포함/);
  // Budget used up: even the right password is not sent to the NAS now; the emergency login still works.
  assert.equal((await login({ username: "admin", password: "nas-pass" }, "192.0.2.11")).status, 401);
  assert.equal(dsm.seen.filter(s => s.params.method === "login").length, 1);
  assert.match(remote.status().loginFailures[0].detail, /NAS 보호/);
  assert.equal((await login({ provider: "local", password: "local emergency pass" }, "192.0.2.12")).status, 200);
});

/** RemoteWeb with NAS login against the mock DSM; logins come "from" `ip` via X-Forwarded-For. */
async function dsmRemote(t: { after(fn: () => unknown): void }, dsm: { url: string }) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-remote-dsm-"));
  const probe = createNetServer();
  await new Promise<void>(ok => probe.listen(0, "127.0.0.1", ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(ok => probe.close(() => ok()));
  let now = 1_000_000;
  const remote = new RemoteWeb({ file: join(dir, "remote-web.json"), staticDir: dir, call: async () => [], sleep: async () => {}, now: () => now });
  t.after(async () => { await remote.stop(); rmSync(dir, { recursive: true, force: true }); });
  await remote.action("set-password", { password: "local emergency pass" });
  await assert.rejects(remote.action("update", { provider: "synology-dsm" }), /허용 계정/);
  // The emergency login is used from public test IPs here, so allow it from the internet (20-char password).
  await remote.action("update", { enabled: true, port, publicOrigin: `http://127.0.0.1:${port}`, provider: "synology-dsm", dsmUrl: dsm.url, dsmCertSha256: FINGERPRINT, dsmAllowedUsers: ["Admin"], allowInternetEmergency: true });
  const base = `http://127.0.0.1:${port}`;
  const login = (body: unknown, ip = "203.0.113.10") => fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-chatterbox-client-ip": ip }, body: JSON.stringify(body) });
  /** Resolves once `n` NAS logins are running or waiting in the NAS queue. */
  const queued = async (n: number) => { while ((remote as any).dsmLimiter.size < n) await new Promise(ok => setTimeout(ok, 5)); };
  return { remote, base, login, queued, advance: (ms: number) => { now += ms; } };
}

test("remote web logs in through the NAS and keeps the local emergency login; failures look identical", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const { remote, base, login } = await dsmRemote(t, dsm);
  assert.equal((await remote.action("dsm-probe", { dsmUrl: dsm.url })).dsmProbe?.fingerprint, FINGERPRINT);
  assert.deepEqual(remote.status().dsm.allowedUsers, ["admin"]);
  assert.deepEqual(await (await fetch(`${base}/api/auth-info`)).json(), { provider: "synology-dsm" });
  assert.equal((await login({ username: "admin", password: "nas-pass" })).status, 200);
  assert.equal(remote.status().sessions[0].user, "admin");
  assert.equal((await login({ provider: "local", password: "local emergency pass" })).status, 200);
  assert.equal(remote.status().sessions.length, 2);
  // Wrong password for a listed id and any password for an unlisted id: same public answer, real reason in the app.
  const listed = await login({ username: "admin", password: "wrong" }, "203.0.113.11");
  const unlisted = await login({ username: "guest", password: "wrong" }, "203.0.113.12");
  assert.deepEqual([listed.status, await listed.json()], [unlisted.status, await unlisted.json()]);
  assert.deepEqual(remote.status().loginFailures.map(f => f.user), ["guest", "admin"]);
  assert.ok(!JSON.stringify(remote.status()).includes("nas-pass"));
});

test("a NAS account locks after repeated failures from many IPs, while the emergency login still works", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const { remote, login } = await dsmRemote(t, dsm);
  // With the default NAS-wide cap (6) that cap stops NAS checks first; raise it to see the account lock.
  await remote.action("update", { dsmFailureLimit: 9 });
  for (let i = 0; i < FAIL_LIMIT_ACCOUNT; i++) assert.equal((await login({ username: "admin", password: `wrong-${i}` }, `198.51.100.${i + 1}`)).status, 401);
  assert.equal((await login({ username: "admin", password: "nas-pass" }, "198.51.100.200")).status, 429);
  assert.equal((await login({ provider: "local", password: "local emergency pass" }, "198.51.100.201")).status, 200);
});

test("a login still waiting behind a slow NAS check is voided by logout-all", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const { remote, login, queued } = await dsmRemote(t, dsm);
  const slow = dsm.hold();
  const first = login({ username: "admin", password: "nas-pass" }, "203.0.113.21");
  await slow.arrived;
  const second = login({ username: "admin", password: "nas-pass" }, "203.0.113.22");
  await queued(2);
  await remote.action("logout-all");
  slow.release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status], [401, 401]);
  assert.equal(b.headers.get("set-cookie"), null);
  assert.equal(remote.status().sessions.length, 0);
  // Only the first request ever reached the NAS; the voided one was dropped before contacting it.
  assert.equal(dsm.seen.filter(s => s.params.method === "login").length, 1);
});

test("a flooded or stuck NAS queue does not block the local emergency login", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
  const { login, queued } = await dsmRemote(t, dsm);
  const slow = dsm.hold();
  const flood = [login({ username: "admin", password: "x" }, "198.51.100.1")];
  await slow.arrived;
  for (let i = 2; i <= 9; i++) flood.push(login({ username: "admin", password: "x" }, `198.51.100.${i}`));
  await queued(9);
  // NAS queue full (1 running + 8 waiting): further NAS logins are refused at once...
  assert.equal((await login({ username: "admin", password: "nas-pass" }, "198.51.100.50")).status, 503);
  // ...but the emergency login has its own path and still works.
  assert.equal((await login({ provider: "local", password: "local emergency pass" }, "198.51.100.51")).status, 200);
  slow.release();
  await Promise.all(flood);
});

test("NAS-rejected logins across all allowed accounts are capped before DSM's auto-block", async (t) => {
  const dsm = await mockDsm(t, { admin: { password: "nas-pass" }, bob: { password: "bob-pass" } });
  const { remote, login, advance } = await dsmRemote(t, dsm);
  await remote.action("update", { dsmAllowedUsers: ["admin", "bob"] });
  const limit = remote.status().dsmFailureLimit;
  assert.equal(limit, 6);
  for (let i = 0; i < limit; i++) assert.equal((await login({ username: i % 2 ? "bob" : "admin", password: "wrong" }, `192.0.2.${i + 1}`)).status, 401);
  // Cap reached: correct credentials get the same uniform failure and the NAS is not contacted.
  const capped = await login({ username: "admin", password: "nas-pass" }, "192.0.2.100");
  assert.deepEqual([capped.status, (await capped.json() as { error: string }).error], [401, "로그인 실패: 아이디·비밀번호·OTP를 확인하세요."]);
  assert.equal(dsm.seen.filter(s => s.params.method === "login").length, limit);
  assert.match(remote.status().loginFailures[0].detail, /NAS 보호/);
  assert.equal((await login({ provider: "local", password: "local emergency pass" }, "192.0.2.101")).status, 200);
  advance(5 * 60 * 1000 + 1);
  assert.equal((await login({ username: "admin", password: "nas-pass" }, "192.0.2.102")).status, 200);
});

for (const [name, change] of [
  ["the allow-list changes", (remote: RemoteWeb) => remote.action("update", { dsmAllowedUsers: ["someone-else"] })],
  ["logout-all runs", (remote: RemoteWeb) => remote.action("logout-all")],
  ["the emergency password changes", (remote: RemoteWeb) => remote.action("set-password", { password: "a brand new password" })],
] as const) {
  test(`a NAS login still being verified when ${name} gets no session`, async (t) => {
    const dsm = await mockDsm(t, { admin: { password: "nas-pass" } });
    const { remote, login } = await dsmRemote(t, dsm);
    const slow = dsm.hold();
    const pending = login({ username: "admin", password: "nas-pass" });
    await slow.arrived;
    await change(remote);
    slow.release();
    const res = await pending;
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(remote.status().sessions.length, 0);
  });
}

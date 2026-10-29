// Remote web end-to-end: real app on a scratch data dir, remote server enabled from the settings IPC,
// then a real browser (Edge) logs in, opens a chat and sends an instruction that reaches the core.
// The project uses a DeepSeek master without an API key, so the turn fails locally and no AI account is used.
// Run after `npm run build`:  node scripts/e2e-remote-web.mjs
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { makeChecks, launch, scratchDir, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const fixture = JSON.parse(readFileSync(join(root, "scripts", "fixtures", "dsm-test-cert.json"), "utf8"));

/** Minimal Synology DSM Web API (SYNO.API.Info + SYNO.API.Auth login/logout). */
async function mockDsm(accounts) {
  const seen = [];
  const server = createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "https://dsm");
      const p = Object.fromEntries([...url.searchParams, ...new URLSearchParams(body)]);
      seen.push({ method: p.method, queryHasPassword: url.searchParams.has("passwd") });
      const reply = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (url.pathname === "/webapi/query.cgi") return reply({ success: true, data: { "SYNO.API.Auth": { path: "entry.cgi", minVersion: 1, maxVersion: 7 } } });
      if (p.method === "logout") return reply({ success: true });
      const a = accounts[p.account];
      if (!a || a.password !== p.passwd) return reply({ success: false, error: { code: 400 } });
      if (a.otp && !p.otp_code) return reply({ success: false, error: { code: 403 } });
      if (a.otp && a.otp !== p.otp_code) return reply({ success: false, error: { code: 404 } });
      reply({ success: true, data: { sid: "mock-sid" } });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `https://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
const data = scratchDir("e2e-remote-web");
const folder = join(data, "work");
mkdirSync(folder, { recursive: true });
const PORT = 47899;
const PASSWORD = "remote-e2e-password-1";
const base = `http://127.0.0.1:${PORT}`;
const UNIFORM_FAILURE = "로그인 실패: 아이디·비밀번호·OTP를 확인하세요.";

const { app, page } = await launch(data);
let browser;
try {
  await page.click('[data-testid="connection-settings"]');
  await page.click('[data-testid="remote-web-manage"]');
  check("settings menu opens the remote web dialog", await page.waitForSelector('[data-testid="remote-web-dialog"]').then(() => true, () => false));
  check("remote web is off by default", (await page.textContent('[data-testid="remote-web-state"]'))?.includes("꺼짐"));
  check("the dialog offers the login method choice", await page.isVisible('[data-testid="remote-web-login-method"]'));
  await page.keyboard.press("Escape");

  const status = await page.evaluate(async ({ port, password }) => {
    await window.chatterbox.remoteWeb("set-password", { password });
    return window.chatterbox.remoteWeb("update", { enabled: true, port, publicOrigin: `http://127.0.0.1:${port}` });
  }, { port: PORT, password: PASSWORD });
  check("enabling starts the loopback server", status.running && status.port === PORT, JSON.stringify({ running: status.running, error: status.error }));

  const { chatId } = await page.evaluate(async (folder) => {
    const project = await window.chatterbox.createProject({ name: "원격 테스트", folder, settings: { orchestratorModel: "deepseek:deepseek-flash" } });
    const chat = await window.chatterbox.createChat(project.id);
    await window.chatterbox.updateChat(chat.id, { title: "원격 채팅" });
    return { chatId: chat.id };
  }, folder);

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(`${base}/api/chats`);
  check("API without a session is 401", denied.status() === 401, denied.status());
  await anonymous.close();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const web = await context.newPage();
  web.on("pageerror", (e) => console.log("[remote pageerror]", e.message));
  const cspErrors = [];
  web.on("console", (m) => { if (m.type() === "error") { console.log("[remote console]", m.text()); if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); } });
  await web.goto(base);
  await web.fill("#remote-password", "wrong-password-123");
  await web.click('button[type="submit"]');
  check("wrong password shows the uniform error", await web.getByRole("alert").textContent().then((t) => t === UNIFORM_FAILURE, () => false));
  await web.fill("#remote-password", PASSWORD);
  await web.click('button[type="submit"]');
  await web.getByRole("button", { name: /원격 채팅/ }).waitFor({ timeout: 15_000 });
  check("login shows the chat list", true);
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-cbx_session");
  check("session cookie is HttpOnly, Secure, SameSite=Strict", cookie?.httpOnly && cookie.secure && cookie.sameSite === "Strict", JSON.stringify(cookie && { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }));
  const sessions = await page.evaluate(() => window.chatterbox.remoteWeb("status"));
  check("the app lists the active remote session", sessions.sessions.length === 1, sessions.sessions.length);

  await web.getByRole("button", { name: /원격 채팅/ }).click();
  await web.getByLabel("지시 입력").fill("원격 웹에서 보낸 지시입니다");
  await web.getByRole("button", { name: "보내기" }).click();
  await web.getByText("원격 웹에서 보낸 지시입니다").waitFor({ timeout: 15_000 });
  check("the instruction appears in the remote timeline", true);
  const failed = await web.getByText(/DeepSeek API/).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  check("live events (the master's result) arrive over the stream", failed);
  const desktopEvents = await page.evaluate((id) => window.chatterbox.loadEvents(id), chatId);
  check("the desktop app recorded the same instruction", desktopEvents.some((e) => e.event.type === "user" && e.event.text === "원격 웹에서 보낸 지시입니다"));
  await web.screenshot({ path: join(data, "remote-mobile.png") });
  check("no CSP violations in the remote page", cspErrors.length === 0, cspErrors[0]);

  await web.getByRole("button", { name: "채팅 목록" }).click();
  await web.getByRole("button", { name: "로그아웃" }).click();
  check("logout returns to the login form", await web.waitForSelector("#remote-password").then(() => true, () => false));
  const after = await context.request.get(`${base}/api/chats`);
  check("the old cookie no longer works after logout", after.status() === 401, after.status());

  // NAS login against a mock Synology DSM (self-signed certificate, pinned by fingerprint).
  const dsm = await mockDsm({ admin: { password: "nas-pass", otp: "123456" } });
  const probe = await page.evaluate((dsmUrl) => window.chatterbox.remoteWeb("dsm-probe", { dsmUrl }), dsm.url);
  check("NAS certificate check reads the fingerprint", probe.dsmProbe?.fingerprint === fixture.fingerprint && !probe.dsmProbe.trusted, JSON.stringify(probe.dsmProbe));
  await page.evaluate(({ dsmUrl, pin }) => window.chatterbox.remoteWeb("update", { provider: "synology-dsm", dsmUrl, dsmCertSha256: pin, dsmAllowedUsers: ["admin"] }), { dsmUrl: dsm.url, pin: fixture.fingerprint });
  await web.reload();
  await web.fill("#remote-username", "admin");
  await web.fill("#remote-password", "nas-pass");
  await web.click('button[type="submit"]');
  check("NAS login without OTP fails with the uniform message", await web.getByRole("alert").textContent().then((t) => t === UNIFORM_FAILURE, () => false));
  const reasons = await page.evaluate(() => window.chatterbox.remoteWeb("status"));
  check("the real reason (OTP required) is shown only in the app", /OTP.*403/.test(reasons.loginFailures[0]?.detail ?? ""), reasons.loginFailures[0]?.detail);
  await web.fill("#remote-otp", "123456");
  await web.click('button[type="submit"]');
  check("NAS account with OTP logs in", await web.getByRole("button", { name: /원격 웹에서 보낸 지시입니다/ }).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  const nasSessions = await page.evaluate(() => window.chatterbox.remoteWeb("status"));
  check("the session is recorded for the NAS account", nasSessions.sessions.some((s) => s.user === "admin"), JSON.stringify(nasSessions.sessions.map((s) => s.user)));
  check("the DSM session was closed right after the check", dsm.seen.some((s) => s.method === "logout"));
  check("the NAS password was only sent in POST bodies", dsm.seen.every((s) => !s.queryHasPassword));
  await web.getByRole("button", { name: "로그아웃" }).click();
  await web.getByRole("button", { name: /비상용 로컬 비밀번호/ }).click();
  await web.fill("#remote-password", PASSWORD);
  await web.click('button[type="submit"]');
  check("the local password still works as the emergency login", await web.getByRole("button", { name: /원격 웹에서 보낸 지시입니다/ }).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  dsm.close();

  const off = await page.evaluate(() => window.chatterbox.remoteWeb("update", { enabled: false }));
  const closed = await fetch(`${base}/`).then(() => false, () => true);
  check("disabling stops the server", !off.running && closed);
} finally {
  await browser?.close().catch(() => undefined);
  await app.close().catch(() => undefined);
}
finish();

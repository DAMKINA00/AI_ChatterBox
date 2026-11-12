// Remote web end-to-end: real app on a scratch data dir, remote server enabled from the settings IPC,
// then a real browser (Edge) logs in, opens a chat and sends an instruction that reaches the core.
// The project uses a DeepSeek master without an API key, so the turn fails locally and no AI account is used.
// Run after `npm run build`:  node scripts/e2e-remote-web.mjs
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
// D1: temporary allowed root for remote project creation.
const roots = join(data, "roots");
mkdirSync(roots, { recursive: true });
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
  check("the dialog shows the remote upload storage cap (default 2 GB)", (await page.inputValue("#remote-upload-storage").catch(() => "")) === "2");
  await page.fill("#remote-upload-storage", "3.5");
  await page.locator('[data-testid="remote-web-upload-storage"]').getByRole("button", { name: "저장" }).click();
  check("the storage cap is saved", await page.waitForFunction(() => window.chatterbox.remoteWeb("status").then((s) => s.uploadStorageGb === 3.5), null, { timeout: 10_000 }).then(() => true, () => false));
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
  await web.getByText("원격 웹에서 보낸 지시입니다", { exact: true }).and(web.locator("div")).waitFor({ timeout: 15_000 });
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

  // ---------- extended features (docs/remote-web-features.md), still on the phone-sized page
  const ok = (p) => p.then(() => true, () => false);
  const dialog = (name) => web.getByRole("dialog", { name });
  const desktopChats = () => page.evaluate(() => window.chatterbox.listChats());
  await page.evaluate((path) => window.chatterbox.remoteWeb("update", { projectRoots: [{ id: "", label: "e2e", path }] }), roots);

  // Dark mode (D6): cycle the theme button until dark, then it survives a reload.
  for (let i = 0; i < 3 && !(await web.evaluate(() => document.documentElement.classList.contains("dark"))); i++) await web.getByRole("button", { name: /^테마:/ }).click();
  check("dark mode turns on", await web.evaluate(() => document.documentElement.classList.contains("dark")));
  await web.reload();
  await web.getByRole("button", { name: /^테마:/ }).waitFor({ timeout: 15_000 });
  check("dark mode is kept after reload", await web.evaluate(() => document.documentElement.classList.contains("dark") && localStorage.getItem("cbx-theme") === "dark"));

  // New chat → rename (desktop list follows through chat:updated).
  const before = (await desktopChats()).length;
  await web.getByRole("button", { name: "원격 테스트에 새 채팅" }).click();
  check("a new chat is created", await ok(web.waitForFunction(async (n) => (await (await fetch("/api/chats")).json()).chats.length > n, before, { timeout: 15_000 })));
  const newest = (await desktopChats()).sort((a, b) => b.id - a.id)[0];
  check("the desktop app sees the new chat", (await desktopChats()).length === before + 1, newest?.title);
  await web.getByRole("button", { name: "채팅 설정" }).click();
  await web.locator("#chat-title").fill("원격 e2e 채팅");
  await dialog("채팅 설정").getByRole("button", { name: "저장" }).click();
  check("rename reaches the desktop app", await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => l.find((c) => c.id === id)?.title === "원격 e2e 채팅"), newest.id, { timeout: 15_000 })));

  // Model and effort for one slot; approval raise needs the D3 confirmation.
  const deepseek = web.locator('select[aria-label="딥시크 모델"]');
  await deepseek.waitFor({ timeout: 20_000 });
  const modelValues = await deepseek.locator("option").evaluateAll((o) => o.map((x) => x.value).filter((v) => v && !v.startsWith("\u0000")));
  await deepseek.selectOption(modelValues.at(-1));
  check("model change reaches the desktop app", await ok(page.waitForFunction(({ id, m }) => window.chatterbox.listChats().then((l) => l.find((c) => c.id === id)?.deepseekModelOverride === m), { id: newest.id, m: modelValues.at(-1) }, { timeout: 15_000 })), modelValues.at(-1));
  const efforts = web.locator('select[aria-label$="추론 수준"]');
  let effortChanged = false;
  for (const sel of await efforts.all()) {
    const values = await sel.locator("option").evaluateAll((o) => o.map((x) => x.value));
    const pick = values.find((v) => v === "high" || v === "low");
    if (!pick || !(await sel.isEnabled())) continue;
    await sel.selectOption(pick);
    effortChanged = await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => { const c = l.find((x) => x.id === id); return Object.keys(c).some((k) => k.endsWith("EffortOverride") && (c[k] === "high" || c[k] === "low")); }), newest.id, { timeout: 15_000 }));
    break;
  }
  check("effort change reaches the desktop app", effortChanged);
  await web.locator("#chat-approval").selectOption("orchestrator-all");
  check("raising autonomy asks for confirmation", await ok(web.getByRole("button", { name: "계속" }).waitFor({ timeout: 10_000 })));
  await web.getByRole("button", { name: "계속" }).click();
  check("confirmed approval change is applied", await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => l.find((c) => c.id === id)?.approvalModeOverride === "orchestrator-all"), newest.id, { timeout: 15_000 })));
  check("the approval change is in the desktop audit log", (await page.evaluate(() => window.chatterbox.remoteWeb("status"))).audit?.some((a) => a.action === "chat.approvalMode"));
  await dialog("채팅 설정").getByRole("button", { name: "닫기" }).first().click();

  // Instruction with one attachment, then the attachment is viewable.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b80000000049454e44ae426082", "hex");
  await web.locator('input[type="file"]').setInputFiles({ name: "e2e.png", mimeType: "image/png", buffer: png });
  check("the attachment is uploaded", await ok(web.getByRole("list", { name: "보낼 첨부" }).getByText("e2e.png").waitFor({ timeout: 15_000 })));
  // Unsent uploads live in attachments/remote-pending; the list follows the server.
  const pendingDir = join(data, "attachments", "remote-pending");
  const pendingFiles = () => (existsSync(pendingDir) ? readdirSync(pendingDir) : []);
  const queued = web.getByRole("list", { name: "보낼 첨부" });
  await web.locator('input[type="file"]').setInputFiles({ name: "remove-me.txt", mimeType: "text/plain", buffer: Buffer.from("remove me") });
  await queued.getByText("remove-me.txt").waitFor({ timeout: 15_000 });
  check("uploads are stored as UUID files in remote-pending", pendingFiles().length === 2 && pendingFiles().every((f) => /^[0-9a-f-]{36}\.(png|txt)$/.test(f)), JSON.stringify(pendingFiles()));
  await web.getByRole("button", { name: "remove-me.txt 첨부 제거" }).click();
  check("removing an upload drops it from the list and the folder", await ok(queued.getByText("remove-me.txt").waitFor({ state: "detached", timeout: 10_000 })) && pendingFiles().length === 1);
  await web.locator('input[type="file"]').setInputFiles({ name: "gone.txt", mimeType: "text/plain", buffer: Buffer.from("gone") });
  await queued.getByText("gone.txt").waitFor({ timeout: 15_000 });
  for (const f of pendingFiles().filter((f) => f.endsWith(".txt"))) rmSync(join(pendingDir, f)); // cleaned up behind the page's back
  await web.getByLabel("지시 입력").fill("첨부와 함께 보내는 지시");
  await web.getByRole("button", { name: /보내기|즉시 전달/ }).first().click();
  check("sending a cleaned-up upload answers 409 and keeps the text", await ok(web.getByText(/첨부 목록을 새로 고친 뒤/).waitFor({ timeout: 10_000 })) && (await web.getByLabel("지시 입력").inputValue()) === "첨부와 함께 보내는 지시");
  check("after the 409 the list shows what the server still has", await ok(queued.getByText("gone.txt").waitFor({ state: "detached", timeout: 10_000 })) && await queued.getByText("e2e.png").isVisible());
  await web.getByRole("button", { name: /보내기|즉시 전달/ }).first().click();
  const img = web.locator('img[alt="e2e.png"]');
  check("the sent attachment shows in the timeline", await ok(img.waitFor({ timeout: 20_000 })));
  const src = await img.getAttribute("src");
  const fetched = await web.evaluate(async (s) => { const r = await fetch(s); return [r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength]; }, src);
  check("the attachment can be opened (owning chat only)", fetched[0] === 200 && fetched[1] === "image/png" && fetched[2] === png.length && /[?&]chat=\d+/.test(src), JSON.stringify(fetched));
  check("the desktop record has the attachment", (await page.evaluate((id) => window.chatterbox.loadEvents(id), newest.id)).some((e) => e.event.type === "user" && e.event.attachments?.some((a) => a.name === "e2e.png")));
  const sentPaths = (await page.evaluate((id) => window.chatterbox.loadEvents(id), newest.id)).flatMap((e) => e.event.type === "user" ? (e.event.attachments ?? []) : []).filter((a) => a.name === "e2e.png").map((a) => a.path);
  check("a sent upload stays in remote-pending (sending only links it)", sentPaths.length === 1 && sentPaths[0].startsWith(pendingDir) && existsSync(sentPaths[0]) && pendingFiles().length === 1, JSON.stringify({ sentPaths, pending: pendingFiles() }));

  // Pause/resume: the DeepSeek master fails at once, so the buttons only show while busy; check the API path.
  const api = async (path, body) => web.evaluate(async ({ path, body }) => {
    const { csrf } = await (await fetch("/api/session")).json();
    return (await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body ?? {}) })).status;
  }, { path, body });
  const pauseStatus = await api(`/api/chats/${newest.id}/pause`);
  const resumeStatus = await api(`/api/chats/${newest.id}/resume`);
  check("pause and resume reach the core", pauseStatus === 200 && resumeStatus === 200, `${pauseStatus}/${resumeStatus}`);

  // Search, archive/unarchive.
  await web.getByRole("button", { name: "채팅 목록" }).click().catch(() => undefined);
  // The first instruction retitles a new chat from its text (desktop rule), so read the current title.
  const title = (await desktopChats()).find((c) => c.id === newest.id).title;
  await web.getByLabel("채팅 검색").fill("첨부와 함께");
  check("search finds the chat by its content", await ok(web.getByRole("button", { name: title }).first().waitFor({ timeout: 15_000 })), title);
  await web.getByRole("button", { name: title }).first().click();
  await web.getByLabel("채팅 검색").fill("").catch(() => undefined);
  await web.getByRole("button", { name: "채팅 설정" }).click();
  await dialog("채팅 설정").getByRole("button", { name: "보관", exact: true }).click();
  check("archive reaches the desktop app", await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => l.find((c) => c.id === id)?.archived === true), newest.id, { timeout: 15_000 })));
  await dialog("채팅 설정").getByRole("button", { name: "보관 해제" }).click();
  check("unarchive reaches the desktop app", await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => l.find((c) => c.id === id)?.archived === false), newest.id, { timeout: 15_000 })));

  // Delete with the title confirmation; the desktop list drops it at once (chat:deleted).
  await dialog("채팅 설정").getByRole("button", { name: /삭제…/ }).click();
  check("the delete confirmation says remote uploads go too", await ok(dialog("채팅 설정").getByText(/원격 웹으로 올린 첨부 파일도/).waitFor({ timeout: 5_000 })));
  await web.getByLabel("삭제 확인용 채팅 이름").fill(title);
  await dialog("채팅 설정").getByRole("button", { name: /영구 삭제/ }).click();
  check("delete removes the chat", await ok(page.waitForFunction((id) => window.chatterbox.listChats().then((l) => !l.some((c) => c.id === id)), newest.id, { timeout: 15_000 })));
  check("the desktop sidebar drops the deleted chat", await ok(page.getByText(title, { exact: true }).first().waitFor({ state: "detached", timeout: 10_000 })));
  check("deleting the chat removed its remote upload file (sent too)", !existsSync(sentPaths[0]) && pendingFiles().length === 0, JSON.stringify(pendingFiles()));

  // Projects: a new folder under the temporary allowed root (D1), then settings.
  await web.getByRole("button", { name: "프로젝트" }).first().click();
  await dialog("프로젝트").getByRole("button", { name: /새 프로젝트/ }).click();
  await web.locator("#project-name").fill("원격 새 프로젝트");
  await web.locator("#project-folder").fill("e2e-new");
  await dialog("프로젝트").getByRole("button", { name: "만들기" }).click();
  check("a project is created under the allowed root", await ok(page.waitForFunction(() => window.chatterbox.listProjects().then((l) => l.some((p) => p.name === "원격 새 프로젝트")), null, { timeout: 15_000 })) && existsSync(join(roots, "e2e-new")));
  check("the desktop sidebar shows the new project", await ok(page.getByText("원격 새 프로젝트").first().waitFor({ timeout: 10_000 })));
  await dialog("프로젝트").getByRole("button", { name: "원격 새 프로젝트 설정" }).click();
  await web.locator("#ps-name").fill("원격 새 프로젝트 수정");
  await web.getByRole("dialog").getByRole("button", { name: "저장" }).last().click();
  check("project settings change reaches the desktop app", await ok(page.waitForFunction(() => window.chatterbox.listProjects().then((l) => l.some((p) => p.name === "원격 새 프로젝트 수정")), null, { timeout: 15_000 })));
  check("the desktop sidebar shows the renamed project", await ok(page.getByText("원격 새 프로젝트 수정").first().waitFor({ timeout: 10_000 })));
  await web.keyboard.press("Escape");
  await web.getByRole("dialog").getByRole("button", { name: "닫기" }).first().click().catch(() => undefined);

  // Usage (read-only).
  await web.getByRole("button", { name: "사용량" }).first().click();
  check("the usage window opens", await ok(dialog(/사용량/).waitFor({ timeout: 10_000 })));
  check("the usage rows load", await ok(dialog(/사용량/).locator('[data-testid="remote-usage-row"]').first().waitFor({ timeout: 15_000 })));
  const usageText = await dialog(/사용량/).textContent();
  check("usage shows no emails or local folders", !/@|\\\.claude|AppData/.test(usageText ?? ""));
  const accountCount = (await page.evaluate(() => window.chatterbox.cliAccounts.list())).length;
  check("the web usage rows are exactly ChatterBox's CLI accounts", (await dialog(/사용량/).locator('[data-testid="remote-usage-row"]').count()) === accountCount, String(accountCount));
  await dialog(/사용량/).getByRole("button", { name: "닫기" }).first().click();
  // Add, rename and disable an account in ChatterBox: the web and the desktop panel follow without any other setting.
  const added = (await page.evaluate(() => window.chatterbox.cliAccounts.create("claude", "E2E 둘째"))).find((a) => a.label === "E2E 둘째");
  await page.evaluate((id) => window.chatterbox.cliAccounts.update(id, { label: "E2E 이름변경", enabled: false }), added.accountId);
  await web.getByRole("button", { name: "사용량" }).first().click();
  const sheet = dialog(/사용량/);
  check("an added, renamed and disabled account shows on the web under its new label", await ok(sheet.getByText("E2E 이름변경").waitFor({ timeout: 10_000 })) && /배정 제외/.test((await sheet.textContent()) ?? ""));
  await sheet.getByRole("button", { name: "닫기" }).first().click();
  await page.getByRole("button", { name: "사용량·잔고 새로고침" }).click();
  check("the desktop usage panel shows the same account", await ok(page.locator('[data-testid="cli-usage-claude"]').getByText("E2E 이름변경").waitFor({ timeout: 60_000 })));
  const removed = await page.evaluate((id) => window.chatterbox.cliAccounts.remove(id).then((l) => l.map((a) => a.accountId), (e) => `ERR ${e.message}`), added.accountId);
  await web.getByRole("button", { name: "사용량" }).first().click();
  await dialog(/사용량/).locator('[data-testid="remote-usage-row"]').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("a removed account disappears from the web usage", await ok(dialog(/사용량/).getByText("E2E 이름변경").waitFor({ state: "detached", timeout: 10_000 })) && (await dialog(/사용량/).locator('[data-testid="remote-usage-row"]').count()) === accountCount, JSON.stringify({ removed, rows: await dialog(/사용량/).locator('[data-testid="remote-usage-row"]').count() }));
  await dialog(/사용량/).getByRole("button", { name: "닫기" }).first().click();
  await web.screenshot({ path: join(data, "remote-features-mobile.png") });

  await web.getByRole("button", { name: "로그아웃" }).first().click();
  check("logout after the feature tour", await ok(web.waitForSelector("#remote-password", { timeout: 10_000 })));

  const off = await page.evaluate(() => window.chatterbox.remoteWeb("update", { enabled: false }));
  const closed = await fetch(`${base}/`).then(() => false, () => true);
  check("disabling stops the server", !off.running && closed);
} finally {
  await browser?.close().catch(() => undefined);
  await app.close().catch(() => undefined);
}
finish();

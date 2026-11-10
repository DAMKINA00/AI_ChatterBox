// Streaming responsiveness, the "new responses" jump button and the polite status line.
// Isolated: scratch data dir, synthetic events sent over IPC from the test (no model, no CLI, no user DB).
// E2E_BASELINE=1 runs only the measurements, for comparing a build without these changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

/** Resolves with { ok } or { ok: false, error } within `ms`; never rejects, always clears its timer. */
async function bounded(label, fn, ms, log) {
  const started = Date.now();
  log(`[shutdown] ${label} start ${new Date(started).toISOString()}`);
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(fn).then(() => ({ ok: true }), (error) => ({ ok: false, error: error?.message ?? String(error) })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `timeout after ${ms}ms` }), ms); }),
  ]);
  clearTimeout(timer);
  log(`[shutdown] ${label} end (${Date.now() - started}ms) ${result.ok ? "ok" : result.error}`);
  return result;
}

/**
 * Closes the app this script launched and records two checks: the app's own process exiting with
 * code 0 ('exit'), and Playwright's close resolving (which also waits for the stdio pipes: 'close').
 * A timeout or rejection of either is a FAIL, so the run exits nonzero. Cleanup is bounded: the same
 * pending close is awaited once more, then only this app's own process handle is killed.
 */
export async function closeApp(app, check, { ms = 30_000, log = console.log } = {}) {
  const proc = app.process();
  const started = Date.now();
  const nativeExit = proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve({ code: proc.exitCode, signal: proc.signalCode, at: started })
    : new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  const closing = Promise.resolve().then(() => app.close());
  closing.catch(() => undefined); // Observed through bounded(); avoid an unhandled rejection after a timeout.
  let exit;
  const [exitWait, closeWait] = await Promise.all([
    bounded(`native exit pid=${proc.pid}`, async () => { exit = await nativeExit; }, ms, log),
    bounded(`playwright close pid=${proc.pid}`, () => closing, ms, log),
  ]);
  const exitedNormally = exitWait.ok && exit.code === 0 && exit.signal === null;
  check(`[harness] app process exited with code 0 within ${ms / 1000}s`, exitedNormally, exit ? `code=${exit.code} signal=${exit.signal} +${exit.at - started}ms` : `not observed: ${exitWait.error}`);
  check(`[harness] Playwright close completed within ${ms / 1000}s`, closeWait.ok, closeWait.ok ? "" : `${closeWait.error}; native exit ${exit ? `code=${exit.code}` : "not observed"}`);
  if (!closeWait.ok) {
    const again = await bounded(`cleanup: pending playwright close pid=${proc.pid}`, () => closing, ms, log);
    if (!again.ok && proc.exitCode === null && proc.signalCode === null) {
      log(`[shutdown] cleanup: killing own app handle pid=${proc.pid} (already counted as FAIL)`);
      proc.kill();
    }
  }
  return { exitedNormally, closed: closeWait.ok };
}

async function main() {
const BASELINE = !!process.env.E2E_BASELINE;
const base = join(root, ".scratch", "ui-responsiveness-20261110", "implementation", "e2e", `${BASELINE ? "baseline" : "after"}-${Date.now()}`);
const data = join(base, "data");
mkdirSync(data, { recursive: true });

// The core reads CLI usage on its own (chats.refreshUsage: Claude/Codex/Grok credentials under the
// user's home, CLIs found on PATH or under LOCALAPPDATA) and pushes it to the window. Stubbing the
// usage:get IPC in the main process does not reach it, so the launched app gets empty homes and a
// PATH with only Windows itself: no real CLI, credential or account usage is found or queried.
const home = join(base, "home");
for (const dir of ["", "AppData/Roaming", "AppData/Local", ".claude", ".codex", ".grok"]) mkdirSync(join(home, dir), { recursive: true });
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
Object.assign(process.env, {
  USERPROFILE: home,
  HOME: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  GROK_HOME: join(home, ".grok"),
  PATH: [join(systemRoot, "System32"), systemRoot, join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
});
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|XAI|DEEPSEEK|GEMINI|GOOGLE)_/i.test(key)) delete process.env[key];
const { check, finish } = makeChecks();

// A reply that grows to ~16k characters with unlabeled code blocks: the costly case for highlighting.
const CHUNK = "결과를 정리합니다. `src/a.ts`를 **유지**합니다.\n\n```\nfunction add(a, b) {\n  const total = a + b;\n  return total;\n}\n```\n\n";
const STREAM_TICKS = 160; // 25 ms apart = 4 s
const FINAL = CHUNK.repeat(6) + "끝.";

const history = (chatId) => {
  const events = [];
  let id = 1;
  const at = Date.now() - 600_000;
  events.push({ id: id++, chatId, node: "orch", role: "orch", at, event: { type: "user", text: "합성 지시", attachments: [] } });
  for (let i = 0; i < 40; i++) {
    events.push({ id: id++, chatId, node: "orch", role: "orch", at: at + i * 1000, event: { type: "text", text: `합성 기록 ${i}\n\n${"긴 문단입니다. ".repeat(40)}` } });
  }
  return events;
};

const send = (app, channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => BrowserWindow.getAllWindows()[0].webContents.send(c, p), [channel, payload]);
const event = (chatId, id, ev) => ({ id, chatId, node: "orch", role: "orch", at: Date.now(), event: ev });

let app;
let page;
try {
  ({ app, page } = await launch(data));
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ["cli:info", "models:list", "usage:get"]) ipcMain.removeHandler(channel);
    ipcMain.handle("cli:info", () => [{ agent: "claude", path: "fixture-claude" }]);
    ipcMain.handle("models:list", () => []);
    ipcMain.handle("usage:get", () => ({}));
  });
  const ids = await page.evaluate(async (folder) => {
    const project = await window.chatterbox.createProject({ name: "반응성 fixture", folder, settings: {} });
    const a = await window.chatterbox.createChat(project.id);
    const b = await window.chatterbox.createChat(project.id);
    await window.chatterbox.updateChat(a.id, { title: "스트림 fixture" });
    await window.chatterbox.updateChat(b.id, { title: "빈 fixture" });
    return { a: a.id, b: b.id };
  }, data);
  await app.evaluate(({ ipcMain }, payload) => {
    ipcMain.removeHandler("chats:events");
    ipcMain.handle("chats:events", (_e, id) => (id === payload.chatId ? payload.events : []));
    globalThis.__fixtureChatId = payload.chatId;
  }, { chatId: ids.a, events: history(ids.a) });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.evaluate(() => { globalThis.__usage = []; window.chatterbox.onUsage((u) => globalThis.__usage.push(u)); });
  const noAccountUsage = async (label) => {
    const pushed = JSON.stringify(await page.evaluate(() => globalThis.__usage));
    const sidebar = await page.getByTestId("sidebar").innerText();
    check(`[Isolation] no real account usage reaches the fixture (${label})`, !/percent"?\s*:\s*\d/i.test(pushed) && !/\d+\s*%/.test(sidebar), `pushes=${pushed.slice(0, 160)} sidebarPercents=${sidebar.match(/\d+\s*%/g) ?? []}`);
  };

  const select = async (chatId) => {
    await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
    await page.waitForSelector('[data-testid="timeline"]');
  };
  const chatOf = (id) => page.evaluate(async (chatId) => (await window.chatterbox.listChats()).find((c) => c.id === chatId), id);
  const setStatus = async (id, status) => send(app, "chat:updated", { ...(await chatOf(id)), status });
  const timeline = page.getByTestId("timeline");
  const toTop = () => timeline.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  const jump = page.getByTestId("new-responses");

  await select(ids.a);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-message"]').length > 0);
  await setStatus(ids.a, "working");
  await page.waitForSelector('[data-testid="working"]');

  if (!BASELINE) {
    check("[UI] no new-response mark after the first snapshot loads", (await jump.count()) === 0);
    const announcer = page.getByTestId("chat-status-announcer");
    check("[A11y] status line is mounted, polite and empty on load", (await announcer.getAttribute("aria-live")) === "polite" && (await announcer.textContent()) === "");
  }

  // ---------- streaming: long tasks while a code-heavy reply grows
  await page.evaluate(() => {
    globalThis.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) globalThis.__long.push(e.duration); }).observe({ type: "longtask" });
  });
  await app.evaluate(({ BrowserWindow }, p) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    let n = 0;
    globalThis.__stream = setInterval(() => {
      contents.send("chat:event", { id: 0, chatId: p.chatId, node: "orch", role: "orch", at: Date.now(), event: { type: "text_delta", text: p.chunk.slice(0, 20) + p.chunk.slice(20) } });
      if (++n >= p.ticks) clearInterval(globalThis.__stream);
    }, 25);
  }, { chatId: ids.a, chunk: CHUNK, ticks: STREAM_TICKS });
  await page.waitForTimeout(800);
  const box = page.getByLabel("메시지 입력");
  let t = Date.now();
  await box.fill("스트림 중 입력");
  const fillMs = Date.now() - t;
  await page.waitForTimeout(1200);
  const mid = await page.evaluate(() => {
    const last = [...document.querySelectorAll('[data-testid="agent-message"]')].at(-1);
    return { codeBlocks: last?.querySelectorAll("pre").length ?? 0, highlighted: last?.querySelectorAll('[class*="hljs"]').length ?? 0, chars: last?.textContent?.length ?? 0 };
  });
  if (!BASELINE) check("[UI] a streaming reply shows its code blocks without highlighting", mid.codeBlocks > 0 && mid.highlighted === 0, JSON.stringify(mid));

  // Scrolling up while the same reply keeps streaming.
  if (!BASELINE) {
    await toTop();
    await page.waitForTimeout(400);
    await jump.waitFor({ state: "visible", timeout: 3000 });
    check("[UI] a reply that keeps streaming while reading above is marked", /새 응답/.test(await jump.textContent()));
  }
  await page.waitForTimeout(STREAM_TICKS * 25);
  const long = await page.evaluate(() => globalThis.__long);
  const totalLong = long.reduce((a, b) => a + b, 0);
  const metrics = { mode: BASELINE ? "baseline" : "after", fillMs, longTasks: long.length, longTaskMs: Math.round(totalLong), maxLongTaskMs: Math.round(Math.max(0, ...long)), streamedChars: mid.chars };
  console.log(`[metrics] ${JSON.stringify(metrics)}`);
  writeFileSync(join(base, "metrics.json"), JSON.stringify(metrics, null, 2));

  // ---------- completion: highlighting returns
  await send(app, "chat:event", event(ids.a, 5001, { type: "text", text: FINAL }));
  await send(app, "chat:event", event(ids.a, 5002, { type: "turn_end", ok: true }));
  await page.waitForFunction(() => /끝\./.test([...document.querySelectorAll('[data-testid="agent-message"]')].at(-1)?.textContent ?? ""));
  const done = await page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-message"]')].at(-1).querySelectorAll('[class*="hljs"]').length);
  check("[UI] the finished reply is highlighted as before", done > 0, `hljs nodes=${done}`);
  if (!BASELINE) {
    // The saved text replaces the preview read above (here shorter than the streamed fixture text):
    // it may still read as "continued", never as a counted new reply.
    const after = (await jump.count()) ? (await jump.textContent()).trim() : "";
    check("[UI] the read reply being saved is not a new reply", !/\d/.test(after), after || "(no mark)");
  }

  if (!BASELINE) {
    // Back at the bottom the mark clears; a new reply while reading above counts by message.
    await page.getByTestId(await jump.count() ? "new-responses" : "scroll-bottom").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="new-responses"]') && !document.querySelector('[data-testid="scroll-bottom"]'));
    check("[UI] jumping to the bottom clears the mark", (await jump.count()) === 0);
    await toTop();
    await send(app, "chat:event", event(ids.a, 5003, { type: "text", text: "새로 도착한 첫 응답" }));
    await send(app, "chat:event", event(ids.a, 5004, { type: "text", text: "새로 도착한 둘째 응답" }));
    await send(app, "chat:event", event(ids.a, 5004, { type: "text", text: "새로 도착한 둘째 응답" }));
    await jump.waitFor({ state: "visible", timeout: 3000 });
    const label = await jump.textContent();
    check("[UI] two new replies read as 새 응답 2", /새 응답\s*2/.test(label), label);
    await noAccountUsage("before the screenshot");
    await page.screenshot({ path: join(base, "new-responses-button.png") });
    await jump.screenshot({ path: join(base, "new-responses-button-crop.png") });
    const before = await timeline.evaluate((el) => el.scrollTop);
    await jump.click();
    await page.waitForFunction(() => { const el = document.querySelector('[data-testid="timeline"]'); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 80; });
    check("[UI] the button jumps to the newest reply", (await timeline.evaluate((el) => el.scrollTop)) > before);

    // Switching chats resets it.
    await toTop();
    await send(app, "chat:event", event(ids.a, 5005, { type: "text", text: "전환 전 응답" }));
    await jump.waitFor({ state: "visible", timeout: 3000 });
    await select(ids.b);
    await select(ids.a);
    await page.waitForTimeout(300);
    check("[UI] switching chats clears the mark", (await jump.count()) === 0);

    // ---------- status line: transitions only, once each (ChatView remounted with the switch above)
    await page.getByTestId("chat-status-announcer").evaluate((el) => { globalThis.__announcements = []; new MutationObserver(() => globalThis.__announcements.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
    check("[A11y] reopening a working chat announces nothing", (await page.getByTestId("chat-status-announcer").textContent()) === "");
    await setStatus(ids.a, "approval");
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-status-announcer"]')?.textContent?.includes("승인"));
    await setStatus(ids.a, "approval"); // a replayed update
    // The main process's order: the master's turn_end event, then the status it maps to.
    await send(app, "chat:event", event(ids.a, 6001, { type: "turn_end", ok: true }));
    await setStatus(ids.a, "done");
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-status-announcer"]')?.textContent?.includes("완료"));
    await setStatus(ids.a, "done");
    await setStatus(ids.a, "working");
    await send(app, "chat:event", event(ids.a, 6002, { type: "turn_end", ok: false, interrupted: true }));
    await setStatus(ids.a, "idle"); // a user stop ends in idle (chats.ts orchTurnEnded)
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-status-announcer"]')?.textContent?.includes("중단"));
    await page.waitForTimeout(300);
    const said = await page.evaluate(() => globalThis.__announcements.filter(Boolean));
    check("[A11y] approval, completion and the stop are each announced once", said.filter((s) => s.includes("승인")).length === 1 && said.filter((s) => s.includes("완료")).length === 1 && said.filter((s) => s.includes("중단")).length === 1, JSON.stringify(said));
    check("[A11y] a user stop is not announced as completed", said.at(-1)?.includes("중단") && !said.at(-1)?.includes("완료"), JSON.stringify(said));
    check("[A11y] no reply text is read out", said.every((s) => !s.includes("결과를 정리") && !s.includes("새로 도착")), JSON.stringify(said));
    await select(ids.b);
    check("[A11y] another chat starts with an empty status line", (await page.getByTestId("chat-status-announcer").textContent()) === "");
    await setStatus(ids.a, "error"); // a chat not on screen is not announced here
    await page.waitForTimeout(300);
    check("[A11y] a background chat's change is not announced", (await page.getByTestId("chat-status-announcer").textContent()) === "");
  }
} catch (error) {
  console.error(error);
  check("ui responsiveness flow completed", false, error.stack ?? error.message);
} finally {
  // A missing final screenshot is not a result; the shutdown below is.
  await page?.screenshot({ path: join(base, "final.png"), timeout: 10_000 }).catch(() => undefined);
  if (app) await closeApp(app, check);
}
finish();
}

// Module constants above are initialized before main runs; importing (the shutdown self-test) runs nothing.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

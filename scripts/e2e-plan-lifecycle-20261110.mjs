// Plan lifecycle display in the built app: a cancelled plan's reason after a new instruction (read-only
// history), an incomplete plan's state/reason/counts/open steps/cancelled step, the switch to a new /plan
// moving the old one into history, and run/cancel offered only on an idle proposal. Desktop and remote.
// Isolated: seeded scratch SQLite, empty homes, Windows-only PATH, no AI API keys, own app and headless
// Edge only (no model, no CLI, no user DB, no account lookup). Plan buttons are never clicked.
// Run after the final build:  node scripts/e2e-plan-lifecycle-20261110.mjs
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root } from "./e2e-lib.mjs";
import { closeApp } from "./e2e-ui-responsiveness-20261110.mjs";

const base = join(root, ".scratch", "plan-lifecycle-20261110", "e2e", `run-${Date.now()}`);
const data = join(base, "data");
const workspace = join(base, "workspace");
mkdirSync(data, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Same isolation as e2e-ui-responsiveness-20261110.mjs: the core reads CLI usage on its own from the
// user's home and PATH, so the launched app (and Edge) get empty homes and only Windows on PATH.
const home = join(base, "home");
for (const dir of ["", "AppData/Roaming", "AppData/Local", ".claude", ".codex", ".grok"]) mkdirSync(join(home, dir), { recursive: true });
const tmp = join(base, "tmp");
mkdirSync(tmp, { recursive: true });
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
Object.assign(process.env, {
  USERPROFILE: home, HOME: home,
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), GROK_HOME: join(home, ".grok"),
  TEMP: tmp, TMP: tmp,
  PATH: [join(systemRoot, "System32"), systemRoot, join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
});
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|XAI|DEEPSEEK|GEMINI|GOOGLE)_/i.test(key)) delete process.env[key];

const { check, finish } = makeChecks();
const ok = (p) => p.then(() => true, () => false);

// ---------- seed (all chats idle: nothing for the app to resume)
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
const t0 = Date.now() - 600_000;
db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)").run("계획 fixture", workspace, JSON.stringify(DEFAULTS), t0);
const chat = db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)");
const insert = db.prepare("INSERT INTO chat_events (chat_id, node, role, ts, type, payload_json) VALUES (?, 'orch', ?, ?, ?, ?)");
let tick = 0;
const event = (chatId, role, value) => Number(insert.run(chatId, role, t0 + ++tick * 1000, value.type, JSON.stringify(value)).lastInsertRowid);
const user = (chatId, text) => event(chatId, null, { type: "user", text, attachments: [] });
const master = (chatId, value) => event(chatId, "orch", value);

const STEPS = [
  { id: "a", title: "API 정리", status: "completed" },
  { id: "b", title: "화면 연결", status: "cancelled", cancelReason: "범위에서 제외" },
  { id: "c", title: "문서 갱신", status: "pending", dependsOn: ["b"] },
  { id: "d", title: "검증", status: "inProgress" },
];
const CANCEL_REASON = "사용자가 제안을 취소했습니다.";
const INCOMPLETE_REASON = "끝나지 않은 단계 2개: c 문서 갱신, d 검증(진행 중)";

// 1: a cancelled proposal, then an ordinary instruction → only the read-only history keeps it.
chat.run(1, "취소 후 새 지시", t0, t0 + 1);
const plan1 = user(1, "/plan 취소될 계획");
master(1, { type: "plan_update", steps: STEPS, planId: plan1, instructionId: plan1 });
master(1, { type: "plan_state", state: "proposed", planId: plan1 });
master(1, { type: "plan_state", state: "cancelled", planId: plan1, reason: CANCEL_REASON });
user(1, "다른 일반 지시");
master(1, { type: "text", text: "일반 지시 처리 완료" });

// 2: an incomplete plan still on the panel.
chat.run(2, "미완료 계획", t0, t0 + 2);
const plan2 = user(2, "/plan 미완료될 계획");
master(2, { type: "plan_update", steps: STEPS, planId: plan2, instructionId: plan2 });
master(2, { type: "plan_state", state: "proposed", planId: plan2 });
master(2, { type: "plan_state", state: "running", planId: plan2 });
master(2, { type: "plan_state", state: "incomplete", planId: plan2, reason: INCOMPLETE_REASON });

// 3: a proposal waiting for approval.
chat.run(3, "제안 대기", t0, t0 + 3);
const plan3 = user(3, "/plan 제안 계획");
master(3, { type: "plan_update", steps: [{ id: "x", title: "제안 단계", status: "pending" }], planId: plan3, instructionId: plan3 });
master(3, { type: "plan_state", state: "proposed", planId: plan3 });
db.close();
if (process.env.E2E_SEED_ONLY) { console.log(JSON.stringify({ data, plan1, plan2, plan3 })); process.exit(0); }

let app;
let page;
let browser;
try {
  ({ app, page } = await launch(data));
  console.log(`[harness] app launched pid=${app.process().pid}`);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const open = async (id) => { await page.locator(`[data-chat-id="${id}"] [role="treeitem"]`).click(); await page.getByTestId("timeline").waitFor(); };
  const send = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => BrowserWindow.getAllWindows()[0].webContents.send(c, p), [channel, payload]);
  const chatOf = (id) => page.evaluate(async (chatId) => (await window.chatterbox.listChats()).find((c) => c.id === chatId), id);
  const panel = page.getByTestId("plan-panel");
  const history = page.getByTestId("plan-history");

  // ---------- 1 cancelled proposal → read-only history after a new instruction [UI desktop]
  await open(1);
  check("[UI] the pinned panel moves on after a new instruction", (await panel.count()) === 0);
  check("[UI] the cancelled plan stays in the collapsed history", await ok(history.waitFor({ timeout: 5_000 })) && /이전 계획 1개/.test(await history.innerText()));
  await history.locator("summary").first().click();
  const entry = history.getByTestId("plan-history-entry");
  check("[UI] history entry: cancelled, reason, counts", (await entry.getAttribute("data-state")) === "cancelled" && (await entry.innerText()).includes(`사유: ${CANCEL_REASON}`) && (await entry.innerText()).includes("완료 1 · 취소 1 · 남음 2"), await entry.innerText());
  await entry.locator("summary").click();
  const entryText = await entry.innerText();
  check("[UI] history keeps each step's state and the cancelled step's reason", entryText.includes("취소 사유: 범위에서 제외") && entryText.includes("미진행") && entryText.includes("진행 중이었음"), entryText);
  check("[UI] history is read-only (no buttons)", (await history.locator("button").count()) === 0);
  await page.screenshot({ path: join(base, "desktop-cancelled-history-dark.png") });

  // ---------- 2 incomplete plan on the panel [UI desktop]
  await open(2);
  await panel.waitFor();
  check("[UI] incomplete plan: state badge and counts (취소 not counted as 완료)", (await panel.getAttribute("data-state")) === "incomplete" && (await page.getByTestId("plan-state").innerText()) === "미완료" && (await page.getByTestId("plan-progress").innerText()).includes("완료 1 · 취소 1 · 남음 2"));
  check("[UI] the reason line is shown", (await page.getByTestId("plan-reason").innerText()).includes(INCOMPLETE_REASON));
  check("[UI] open steps are listed", /진행되지 않은 단계 2개/.test(await page.getByTestId("plan-open-steps").innerText()));
  check("[UI] cancelled step: label and reason", (await page.getByTestId("plan-step-cancelled").count()) === 1 && (await page.getByTestId("plan-step-cancel-reason").innerText()).includes("범위에서 제외"));
  check("[UI] a cancelled prerequisite reads as unfinished", (await page.getByTestId("plan-step-blockers").innerText()).includes("화면 연결(취소됨)"));
  check("[UI] an ended plan offers no run/cancel", (await page.getByTestId("plan-run").count()) === 0 && (await page.getByTestId("plan-cancel").count()) === 0);
  await panel.locator("button").first().click(); // collapse
  check("[UI] the reason stays visible when the card is collapsed", (await page.getByTestId("plan-step-cancelled").count()) === 0 && (await page.getByTestId("plan-reason").innerText()).includes(INCOMPLETE_REASON));
  await panel.locator("button").first().click();
  await page.getByLabel("테마 전환").click();
  await page.screenshot({ path: join(base, "desktop-incomplete-light.png") });

  // A new /plan replaces it on the panel; the incomplete plan moves to history (renderer-only events).
  const NEW = 900_001;
  const live = (id, role, value) => send("chat:event", { id, chatId: 2, node: "orch", role, at: Date.now(), event: value });
  await live(NEW, null, { type: "user", text: "/plan 새 계획", attachments: [] });
  await live(NEW + 1, "orch", { type: "plan_update", steps: [{ id: "n", title: "새 단계", status: "pending" }], planId: NEW });
  await live(NEW + 2, "orch", { type: "plan_state", state: "proposed", planId: NEW });
  await page.waitForFunction(() => document.querySelector('[data-testid="plan-panel"]')?.getAttribute("data-state") === "proposed", null, { timeout: 5_000 }).catch(() => undefined);
  check("[UI] a new /plan replaces the panel without mixing steps", (await panel.getAttribute("data-state")) === "proposed" && !(await panel.innerText()).includes("API 정리") && (await panel.innerText()).includes("새 단계"));
  check("[UI] the replaced incomplete plan is in history", /이전 계획 1개/.test(await history.innerText()) && (await history.getByTestId("plan-history-entry").getAttribute("data-state")) === "incomplete");

  // ---------- 3 run/cancel only on an idle proposal [UI desktop]
  await open(3);
  await panel.waitFor();
  check("[UI] an idle proposal offers run and cancel", (await page.getByTestId("plan-run").count()) === 1 && (await page.getByTestId("plan-cancel").count()) === 1);
  const idleChat = await chatOf(3);
  for (const status of ["working", "approval", "paused"]) {
    await send("chat:updated", { ...idleChat, status });
    await page.waitForFunction(() => !document.querySelector('[data-testid="plan-run"]'), null, { timeout: 5_000 }).catch(() => undefined);
    check(`[UI] a ${status} chat hides run/cancel and says why`, (await page.getByTestId("plan-run").count()) === 0 && (await page.getByTestId("plan-cancel").count()) === 0 && (await page.getByTestId("plan-actions-wait").count()) === 1);
  }
  await page.screenshot({ path: join(base, "desktop-busy-proposal-light.png") });
  await send("chat:updated", idleChat);
  await page.getByTestId("plan-run").waitFor({ timeout: 5_000 }).catch(() => undefined);
  check("[UI] back to idle, the buttons return", (await page.getByTestId("plan-run").count()) === 1);
  check("[UI] desktop renderer completed without errors", errors.length === 0, errors.join("\n"));

  // ---------- remote web (seeded data only; the live-only steps above are desktop checks)
  const PORT = 47923;
  const PASSWORD = "plan-lifecycle-e2e-pass-1";
  const remoteBase = `http://127.0.0.1:${PORT}`;
  const status = await page.evaluate(async ({ port, password }) => {
    await window.chatterbox.remoteWeb("set-password", { password });
    return window.chatterbox.remoteWeb("update", { enabled: true, port, publicOrigin: `http://127.0.0.1:${port}` });
  }, { port: PORT, password: PASSWORD });
  check("[IPC] remote server starts on loopback", status.running && status.port === PORT, status.error);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const web = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const remoteErrors = [];
  web.on("pageerror", (e) => remoteErrors.push(e.message));
  await web.goto(remoteBase);
  await web.fill("#remote-password", PASSWORD);
  await web.click('button[type="submit"]');
  await web.getByRole("button", { name: /제안 대기/ }).first().waitFor({ timeout: 15_000 });
  const openRemote = async (id, text) => { await web.goto(`${remoteBase}/#chat=${id}`); await web.reload(); await web.getByText(text).first().waitFor({ timeout: 15_000 }); };
  const team = web.locator("details").filter({ has: web.locator("summary", { hasText: /작업자/ }) }).first();

  await openRemote(1, "일반 지시 처리 완료");
  const remoteHistory = web.locator('details[aria-label="이전 계획"]');
  if (!(await team.getAttribute("open").catch(() => null))) await team.locator("summary").first().click();
  await remoteHistory.locator("summary").first().click();
  const remoteEntry = remoteHistory.locator("[data-plan-history]");
  await remoteEntry.locator("summary").click();
  const remoteEntryText = await remoteEntry.innerText();
  check("[UI remote] cancelled plan in history with reason, counts and the step's reason", (await remoteEntry.getAttribute("data-plan-history")) === "cancelled" && remoteEntryText.includes(`사유: ${CANCEL_REASON}`) && remoteEntryText.includes("완료 1 · 취소 1 · 남음 2") && remoteEntryText.includes("취소 사유: 범위에서 제외"), remoteEntryText);
  check("[UI remote] history is read-only (no buttons)", (await remoteHistory.locator("button").count()) === 0);
  await web.screenshot({ path: join(base, "remote-cancelled-history.png") });

  await openRemote(2, "/plan 미완료될 계획");
  const summary = await team.locator("summary").first().innerText();
  check("[UI remote] summary: incomplete state, counts and reason", summary.includes("계획 미완료 · 완료 1 · 취소 1 · 남음 2") && summary.includes(`미완료 사유: ${INCOMPLETE_REASON}`), summary);
  if (!(await team.getAttribute("open").catch(() => null))) await team.locator("summary").first().click();
  const teamText = await team.innerText();
  check("[UI remote] open steps, cancelled step and its reason, unfinished prerequisite", /진행되지 않은 단계 2개/.test(teamText) && teamText.includes("취소 사유: 범위에서 제외") && teamText.includes("화면 연결(취소됨)"), teamText);
  check("[UI remote] an ended plan offers no run/cancel", (await web.getByRole("button", { name: /계획 실행|계획 취소/ }).count()) === 0);
  await web.screenshot({ path: join(base, "remote-incomplete.png") });

  await openRemote(3, "/plan 제안 계획");
  check("[UI remote] an idle proposal offers run and cancel", (await web.getByRole("button", { name: "계획 실행" }).count()) === 1 && (await web.getByRole("button", { name: "계획 취소" }).count()) === 1);
  check("[UI remote] no renderer errors", remoteErrors.length === 0, remoteErrors.join("\n"));
  console.log(`Screenshots: ${base}`);
} catch (error) {
  console.error(error);
  check("plan lifecycle flow completed", false, error.stack ?? error.message);
} finally {
  if (browser) {
    let timer;
    const closed = await Promise.race([browser.close().then(() => true, () => false), new Promise((r) => { timer = setTimeout(() => r(false), 30_000); })]);
    clearTimeout(timer);
    check("[harness] remote Edge closed within 30s", closed);
  }
  if (app) await closeApp(app, check);
}
finish();

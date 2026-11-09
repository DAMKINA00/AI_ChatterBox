// Isolated UI checks for the checklist dependencies, structured review results and team total, run
// statistics, and user conversation fork (desktop + remote web). Seeded scratch SQLite only: no model
// turns, no production data, no AI accounts. The remote part uses a loopback server and headless Edge
// like e2e-remote-web.mjs. Run after the app is built:  node scripts/e2e-improvements-1447.mjs
// Checks are labelled [UI] (driven through the rendered page), [IPC]/[API] (contract calls only), [DB]/[FS].
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const ok = (p) => p.then(() => true, () => false);
const base = join(root, ".scratch", "improve-1447-ui", "e2e", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });
// Attachments live where the app keeps them: <data>/attachments/<chatId>/.
const sourceFiles = join(data, "attachments", "1");
mkdirSync(sourceFiles, { recursive: true });
const ATTACH_1 = { id: 1, name: "원본 첨부.txt", text: "원본 첨부 내용 · 분기 복사 확인" };
const ATTACH_2 = { id: 2, name: "후속 첨부.txt", text: "후속 첨부 내용 · 분기에서 제외" };
for (const a of [ATTACH_1, ATTACH_2]) { a.path = join(sourceFiles, a.name); a.size = Buffer.byteLength(a.text); writeFileSync(a.path, a.text); }
const ref = (a) => ({ id: a.id, name: a.name, path: a.path, mime: "text/plain", size: a.size });

// ---------- seed
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
const t0 = Date.now() - 600_000;
const SOURCE_TITLE = "분기 원본";
db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)").run("개선 확인", workspace, JSON.stringify(DEFAULTS), t0);
db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (1, 1, ?, 'idle', 0, 0, ?, ?)").run(SOURCE_TITLE, t0, t0 + 1);
const agent = db.prepare("INSERT INTO agents (id, chat_id, kind, number, nickname, job, status, created_at) VALUES (?, 1, ?, ?, ?, '', 'active', ?)");
agent.run(1, "claude", 1, "클로드 1호", t0);
agent.run(2, "gpt", 1, "지피티 1호", t0);
const consult = db.prepare("INSERT INTO consults (id, chat_id, seq, from_role, to_role, kind, request, status, started_at, ended_at, response_summary) VALUES (?, 1, ?, 'orch', ?, ?, ?, ?, ?, ?, ?)");
consult.run(1, 1, "w1", "implement", "API 구현", "error", t0 + 10_000, t0 + 20_000, "중단");
consult.run(2, 2, "w2", "review", "변경 리뷰", "done", t0 + 30_000, t0 + 60_000, "자유문장 리뷰 요약");
consult.run(3, 3, "w1", "review", "이전 리뷰", "done", t0 + 70_000, t0 + 80_000, "구조화 없이 끝난 리뷰");
consult.run(4, 4, "w2", "review", "실패한 리뷰", "error", t0 + 85_000, t0 + 90_000, "오류");
// Record-only review: the verdict exists on the consult row and no review_result/consult_end event was stored.
// review_json comes from a migration, not SCHEMA; the app's migration skips a column that already exists.
db.exec("ALTER TABLE consults ADD COLUMN review_json TEXT");
consult.run(5, 5, "w1", "review", "기록만 있는 리뷰", "done", t0 + 90_100, t0 + 90_900, "기록 전용 자유문장");
const RECORD_ONLY_SUMMARY = "기록 전용 판정 요약";
db.prepare("UPDATE consults SET review_json = ? WHERE id = 5").run(JSON.stringify({ verdict: "inconclusive", revision: "r-record", summary: RECORD_ONLY_SUMMARY, findings: [], tests: [] }));
// Crash/restart: the store marked a running review stopped without writing consult_end (timeline still says running).
consult.run(6, 6, "w2", "review", "재시작으로 중지된 리뷰", "stopped", t0 + 90_300, t0 + 90_700, null);
db.prepare("UPDATE consults SET review_json = ? WHERE id = 6").run(JSON.stringify({ verdict: "pass", revision: "r-stopped", summary: "중지 전 통과 보고", findings: [], tests: [] }));
const attachment = db.prepare("INSERT INTO attachments (id, chat_id, event_id, name, path, mime, size) VALUES (?, 1, NULL, ?, ?, 'text/plain', ?)");
for (const a of [ATTACH_1, ATTACH_2]) attachment.run(a.id, a.name, a.path, a.size);
const insert = db.prepare("INSERT INTO chat_events (chat_id, node, role, ts, type, payload_json) VALUES (1, ?, ?, ?, ?, ?)");
const event = (at, role, value, node = "orch") => Number(insert.run(node, role, t0 + at, value.type, JSON.stringify(value)).lastInsertRowid);
const pass = { verdict: "pass", revision: "r-old", summary: "이전 통과", findings: [], tests: [] };
const changes = { verdict: "changes_requested", revision: "abc123", summary: "수정 필요",
  findings: [{ severity: "high", message: "널 검사 누락", path: "src/a.ts", line: 12 }, { severity: "low", message: "이름 다듬기" }],
  tests: [{ name: "unit", status: "failed", detail: "1건 실패" }, { name: "e2e", status: "not_run" }] };
const TEXT = { user1: "분기 기준 첫 지시", master1: "마스터 첫 응답", user2: "후속 지시", masterLast: "마스터 마지막 응답", workerText: "작업자 본문 메시지", workerRoom: "작업자 그룹 발언", masterRoom: "마스터 그룹 공지" };
const ids = {};
ids.user1 = event(0, null, { type: "user", text: TEXT.user1, attachments: [ref(ATTACH_1)] });
ids.master1 = event(1_000, "orch", { type: "text", text: TEXT.master1 });
event(10_000, "orch", { type: "consult_start", consultId: 1, kind: "implement", from: "orch", to: "w1", request: "API 구현", attachments: [] });
event(11_000, "w1", { type: "tool_call", id: "t1", name: "Bash", input: "npm test" }, "consult:1");
event(12_000, "w1", { type: "text", text: TEXT.workerText }, "consult:1");
event(14_000, "w1", { type: "tool_result", id: "t1", ok: false, output: "실패" }, "consult:1");
event(15_000, "w1", { type: "approval_request", request: { id: "a1", role: "w1", title: "명령 실행", detail: "rm x", risk: "low" } }, "orch");
event(18_000, "orch", { type: "approval_resolved", id: "a1", decision: "deny" });
event(20_000, "orch", { type: "consult_end", consultId: 1, status: "error", summary: "중단", files: [] });
event(30_000, "orch", { type: "consult_start", consultId: 2, kind: "review", from: "orch", to: "w2", request: "변경 리뷰", attachments: [] });
event(40_000, "w2", { type: "review_result", consultId: 2, review: pass }, "consult:2");
event(50_000, "w2", { type: "review_result", consultId: 2, review: changes }, "consult:2");
event(60_000, "orch", { type: "consult_end", consultId: 2, status: "done", summary: "자유문장 리뷰 요약", files: [] });
event(70_000, "orch", { type: "consult_start", consultId: 3, kind: "review", from: "orch", to: "w1", request: "이전 리뷰", attachments: [] });
event(80_000, "orch", { type: "consult_end", consultId: 3, status: "done", summary: "구조화 없이 끝난 리뷰", files: [] });
event(85_000, "orch", { type: "consult_start", consultId: 4, kind: "review", from: "orch", to: "w2", request: "실패한 리뷰", attachments: [] });
event(86_000, "w2", { type: "review_result", consultId: 4, review: pass }, "consult:4");
// A call whose turn ended without a result: closed work, reported as unconfirmed rather than running.
event(86_500, "w2", { type: "tool_call", id: "t4", name: "Bash", input: "npm run lint" }, "consult:4");
event(88_000, "w2", { type: "turn_end", ok: true }, "consult:4");
event(90_000, "orch", { type: "consult_end", consultId: 4, status: "error", summary: "오류", files: [] });
event(90_100, "orch", { type: "consult_start", consultId: 5, kind: "review", from: "orch", to: "w1", request: "기록만 있는 리뷰", attachments: [] });
event(90_300, "orch", { type: "consult_start", consultId: 6, kind: "review", from: "orch", to: "w2", request: "재시작으로 중지된 리뷰", attachments: [] });
event(90_400, "w2", { type: "text", text: "중지 전 작업 기록" }, "consult:6");
event(91_200, "w1", { type: "room_message", from: "w1", text: TEXT.workerRoom }, "orch");
event(91_400, "orch", { type: "room_message", from: "orch", text: TEXT.masterRoom }, "orch");
ids.user2 = event(92_000, null, { type: "user", text: TEXT.user2, attachments: [ref(ATTACH_2)] });
// A new ordinary instruction starts a fresh checklist (planOf), so the current checklist follows the last one.
event(93_000, "orch", { type: "plan_update", steps: [
  { id: "api", title: "API 구현", status: "inProgress", owner: "클로드 1호", consultIds: [1] },
  { id: "ui", title: "UI 연결", status: "pending", owner: "지피티 1호", dependsOn: ["api"] },
  { id: "docs", title: "문서", status: "pending", dependsOn: [], consultIds: [99] },
] });
ids.masterLast = event(95_000, "orch", { type: "text", text: TEXT.masterLast });
event(96_000, "orch", { type: "turn_end", ok: true });
db.close();
// Seed check without launching the app (static preparation): prints the data dir and anchor ids.
if (process.env.E2E_SEED_ONLY) { console.log(JSON.stringify({ data, ids })); process.exit(0); }

const forkContextOf = (events) => events.find((e) => e.event.type === "fork_context")?.event;
const includesAll = (text, list) => list.every((t) => text.includes(t));
const includesNone = (text, list) => list.every((t) => !text.includes(t));

// Shutdown steps are bounded and logged: a hung close is a FAIL (nonzero exit), never a pass.
const SHUTDOWN_MS = 30_000;
async function bounded(label, fn, ms = SHUTDOWN_MS) {
  const started = Date.now();
  console.log(`[shutdown] ${label} start ${new Date(started).toISOString()}`);
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(fn).then(() => ({ ok: true }), (error) => ({ ok: false, error: error?.message ?? String(error) })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `timeout after ${ms}ms` }), ms); }),
  ]);
  clearTimeout(timer);
  console.log(`[shutdown] ${label} end ${new Date().toISOString()} (${Date.now() - started}ms) ${result.ok ? "ok" : result.error}`);
  return result;
}

let app;
let appPid;
let browser;
let closing; // Playwright close promise, kept so cleanup waits on the same call
try {
  const launched = await launch(data);
  app = launched.app;
  appPid = app.process().pid;
  console.log(`[harness] app launched pid=${appPid} ${new Date().toISOString()}`);
  const page = launched.page;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = (fn, arg) => page.evaluate(fn, arg);
  const openChat = async (id) => { await page.locator(`[data-chat-id="${id}"] [role="treeitem"]`).click(); await page.getByTestId("timeline").waitFor(); };
  await openChat(1);

  // ---------- 1 checklist [UI]
  const steps = page.getByTestId("plan-step");
  check("[UI] checklist shows owners", (await page.getByTestId("plan-step-owner").allInnerTexts()).join("|") === "[클로드 1호]|[지피티 1호]");
  check("[UI] dependent step shows its unfinished prerequisite", (await steps.nth(1).getAttribute("data-blocked")) === "true" && (await page.getByTestId("plan-step-blockers").innerText()).includes("API 구현"));
  check("[UI] step without prerequisites is ready; the app does not change its status", (await steps.nth(2).getAttribute("data-ready")) === "true" && (await steps.nth(2).getAttribute("data-status")) === "pending");
  check("[UI] failed consult link is shown on its step", (await page.getByTestId("plan-step-consult").first().innerText()).includes("오류"));

  // ---------- 2 structured review [UI]
  const totals = page.getByTestId("review-totals");
  const totalsText = await totals.innerText();
  check("[UI] team total counts only finished verdicts; a pass before an error is not a pass", (await totals.getAttribute("data-pass")) === "0" && (await totals.getAttribute("data-changes")) === "1" && totalsText.includes("실행 미완료 2"), totalsText);
  check("[UI] missing structured result is listed apart", (await totals.getAttribute("data-missing")) === "1" && totalsText.includes("구조화 결과 없음 1"), totalsText);
  const reviews = page.getByTestId("consult-review");
  const reviewCard2 = page.getByTestId("consult-card").filter({ has: page.getByTestId("consult-request-brief").filter({ hasText: "변경 리뷰" }) });
  check("[UI] latest report wins on the card and the free-text summary stays", (await reviewCard2.getByTestId("consult-review").getAttribute("data-verdict")) === "changes_requested" && (await reviewCard2.getByTestId("consult-summary").innerText()).includes("자유문장 리뷰 요약"));
  check("[UI] findings and tests are listed", (await page.getByTestId("review-findings").first().innerText()).includes("src/a.ts:12") && (await page.getByTestId("review-tests").first().innerText()).includes("실패"));
  check("[UI] review without a report says so", (await reviews.nth(1).innerText()).includes("구조화 결과 없음"));
  check("[UI] errored review shows its run state next to the verdict", (await page.getByTestId("review-run-note").first().innerText()).includes("오류"));
  check("[UI] record-only review shows the record's verdict and run state", (await reviews.nth(3).getAttribute("data-verdict")) === "inconclusive" && (await reviews.nth(3).getAttribute("data-run")) === "done" && (await reviews.nth(3).innerText()).includes(RECORD_ONLY_SUMMARY), await reviews.nth(3).innerText());
  // Without consult_end the timeline copy stays running; header, icon, progress and review block follow the record.
  const card = (request) => page.getByTestId("consult-card").filter({ has: page.getByTestId("consult-request-brief").filter({ hasText: request }) });
  const cardState = async (request) => {
    const c = card(request);
    return { card: await c.getAttribute("data-status"), header: await c.getByTestId("consult-status").innerText(), review: await c.getByTestId("consult-review").getAttribute("data-run"),
      working: await c.getByTestId("working-indicator").count(), starting: await c.getByText("작업 시작 중").count(),
      progress: await c.getByTestId("consult-progress-toggle").count() ? await c.getByTestId("consult-progress-toggle").getAttribute("aria-expanded") : null };
  };
  const recordOnly = await cardState("기록만 있는 리뷰");
  check("[UI] record-only review: header and review block both say done", recordOnly.card === "done" && recordOnly.header.includes("완료") && recordOnly.review === "done" && recordOnly.working === 0 && recordOnly.starting === 0, JSON.stringify(recordOnly));
  const stoppedCard = await cardState("재시작으로 중지된 리뷰");
  check("[UI] review stopped by a restart: header, review block and progress agree it is not running", stoppedCard.card === "stopped" && stoppedCard.header.includes("중지됨") && stoppedCard.review === "stopped" && stoppedCard.working === 0 && stoppedCard.progress === "false", JSON.stringify(stoppedCard));
  check("[UI] stopped review keeps its report with the stop note", (await card("재시작으로 중지된 리뷰").getByTestId("review-run-note").innerText()).includes("중지"));

  // ---------- 3 run statistics [UI]
  await page.getByTestId("run-stats-open").click();
  await page.getByTestId("run-stats").waitFor();
  const note = await page.getByTestId("run-stats-note").innerText();
  check("[UI] stats note: recorded span incl. idle, overlap, not model time", /기록 구간/.test(note) && /유휴/.test(note) && /겹칠 수/.test(note) && /모델 추론 시간/.test(note), note);
  const w1 = await page.locator('[data-testid="run-stats-row"][data-key="w1"]').innerText();
  check("[UI] worker row shows tool time and failures", w1.includes("3초") && w1.includes("도구 실패 1"), w1);
  const w2 = await page.locator('[data-testid="run-stats-row"][data-key="w2"]').innerText();
  check("[UI] a call whose turn ended reads as unconfirmed, not running", w2.includes("결과 미확인") && !w2.includes("진행 중"), w2);
  await page.screenshot({ path: join(base, "stats-dark.png") });
  await page.keyboard.press("Escape");

  // ---------- 7 fork A: master message, "through", attachments included [UI]
  const master1 = page.getByTestId("agent-message").filter({ hasText: TEXT.master1 });
  await master1.hover();
  await master1.getByTestId("fork-message").click();
  const dialog = page.getByTestId("fork-dialog");
  check("[UI] fork dialog states that only the conversation forks", (await dialog.innerText()).includes("대화만 분기되며 작업 폴더는 공유됩니다"));
  await page.getByTestId("fork-range-through").check();
  await page.getByTestId("fork-attachments").check();
  await page.screenshot({ path: join(base, "fork-dialog-dark.png") });
  await page.getByTestId("fork-submit").click();
  await page.getByTestId("fork-origin").waitFor({ timeout: 15_000 });
  const chatsAfterA = await api(() => window.chatterbox.listChats());
  const forkA = chatsAfterA.find((c) => c.fork?.sourceEventId === ids.master1);
  check("[IPC] fork A records its origin", forkA?.fork?.sourceChatId === 1 && forkA.fork.sourceTitle === SOURCE_TITLE && forkA.fork.range === "through" && forkA.fork.includeAttachments === true, JSON.stringify(forkA?.fork));
  check("[IPC] fork A starts idle in the same project", forkA?.status === "idle" && forkA.projectId === 1);
  const [agentsA, consultsA, eventsA] = forkA ? await api((id) => Promise.all([window.chatterbox.listAgents(id), window.chatterbox.listConsults(id), window.chatterbox.loadEvents(id)]), forkA.id) : [[], [], []];
  check("[IPC] workers, consults and approvals are not copied", agentsA.length === 0 && consultsA.length === 0 && !eventsA.some((e) => /^approval|^consult|^plan_|^tool_/.test(e.event.type)), eventsA.map((e) => e.event.type).join(","));
  const ctxA = forkContextOf(eventsA);
  check("[IPC] 'through' snapshot holds the anchor and everything before it", ctxA && includesAll(ctxA.text, [TEXT.user1, `마스터: ${TEXT.master1}`]), ctxA?.text.slice(0, 300));
  check("[IPC] 'through' snapshot stops at the anchor", ctxA && includesNone(ctxA.text, [TEXT.user2, TEXT.masterLast]), ctxA?.text.slice(-300));
  const copy = ctxA?.attachments?.[0];
  check("[IPC] included attachment gets a new id and path", ctxA?.attachments?.length === 1 && copy.id !== ATTACH_1.id && copy.path !== ATTACH_1.path && copy.name === ATTACH_1.name, JSON.stringify(copy));
  check("[FS] the copy has the same content in the new chat's storage", !!copy && existsSync(copy.path) && readFileSync(copy.path, "utf8") === ATTACH_1.text && copy.path.includes(join("attachments", String(forkA.id))), copy?.path);
  check("[UI] forked chat opens with its origin and anchor", (await page.getByTestId("fork-origin").innerText()).includes(SOURCE_TITLE) && (await page.getByTestId("fork-origin").innerText()).includes(`#${ids.master1}`));
  check("[UI] forked chat shows only the read-only transcript", await page.getByTestId("fork-context").count() === 1 && await page.getByTestId("approval").count() === 0 && await page.getByTestId("consult-card").count() === 0 && await page.getByTestId("plan-panel").count() === 0);
  await page.getByTestId("fork-context-toggle").click();
  check("[UI] transcript keeps the source speaker names", (await page.getByTestId("fork-context").innerText()).includes(`마스터: ${TEXT.master1}`));
  check("[UI] copied attachment is shown with the transcript", await page.locator('[data-testid="fork-context-attachments"] [data-testid="attachment"]').count() === 1);
  await page.keyboard.press("Control+f");
  await page.getByLabel("대화에서 찾을 내용").fill(TEXT.master1);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('[data-testid="chat-search-count"]')?.textContent ?? ""), null, { timeout: 5_000 }).catch(() => undefined);
  check("[UI] chat search finds text inside the fork transcript", /^[1-9]/.test(await page.getByTestId("chat-search-count").innerText()), await page.getByTestId("chat-search-count").innerText());
  await page.keyboard.press("Escape");

  // ---------- 7 fork B: user message, "from", attachments left out; opened with the keyboard [UI]
  await openChat(1);
  const user2 = page.getByTestId("user-message").filter({ hasText: TEXT.user2 });
  await user2.getByTestId("fork-message").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("fork-dialog").waitFor();
  check("[UI] the fork action opens from the keyboard", true);
  await page.getByTestId("fork-range-from").check();
  check("[UI] attachments are left out by default", !(await page.getByTestId("fork-attachments").isChecked()));
  await page.getByTestId("fork-submit").click();
  await page.getByTestId("fork-origin").waitFor({ timeout: 15_000 });
  const forkB = (await api(() => window.chatterbox.listChats())).find((c) => c.fork?.sourceEventId === ids.user2);
  const ctxB = forkB ? forkContextOf(await api((id) => window.chatterbox.loadEvents(id), forkB.id)) : undefined;
  check("[IPC] 'from' snapshot holds the anchor and everything after it", ctxB && includesAll(ctxB.text, [TEXT.user2, TEXT.masterLast]), ctxB?.text.slice(0, 300));
  check("[IPC] 'from' snapshot starts at the anchor", ctxB && includesNone(ctxB.text, [TEXT.user1, TEXT.master1]), ctxB?.text.slice(0, 300));
  check("[IPC] left-out attachments are neither copied nor quoted", ctxB?.attachments?.length === 0 && !ctxB.text.includes(ATTACH_2.text) && /첨부 1개 제외/.test(ctxB.text), ctxB?.text);
  await page.getByLabel("테마 전환").click();
  await page.setViewportSize({ width: 720, height: 800 });
  await page.screenshot({ path: join(base, "fork-light-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 860 });

  const sourceEvents = await api(() => window.chatterbox.loadEvents(1));
  check("[IPC] the source chat is unchanged by forking", sourceEvents.length === ids.masterLast + 1 && sourceEvents.at(-1)?.id === ids.masterLast + 1 && !sourceEvents.some((e) => e.event.type === "fork_context"), sourceEvents.length);

  // ---------- fork points: group messages and worker messages [UI]
  await openChat(1);
  const noFork = (text) => page.getByTestId("agent-message").filter({ hasText: text }).getByTestId("fork-message").count();
  check("[UI] group messages (worker and master) offer no fork", await page.getByTestId("agent-message").filter({ hasText: TEXT.masterRoom }).count() === 1 && await noFork(TEXT.workerRoom) === 0 && await noFork(TEXT.masterRoom) === 0);
  await page.getByTestId("consult-card").first().getByRole("button", { name: "열기" }).click();
  await page.getByTestId("agent-message").filter({ hasText: TEXT.workerText }).waitFor({ timeout: 5_000 });
  check("[UI] a worker's own message in the consult view offers no fork", await noFork(TEXT.workerText) === 0);

  // ---------- remote web smoke (same patterns as e2e-remote-web.mjs)
  const PORT = 47913;
  const PASSWORD = "improvements-e2e-pass-1";
  const remoteBase = `http://127.0.0.1:${PORT}`;
  const status = await api(async ({ port, password }) => {
    await window.chatterbox.remoteWeb("set-password", { password });
    return window.chatterbox.remoteWeb("update", { enabled: true, port, publicOrigin: `http://127.0.0.1:${port}` });
  }, { port: PORT, password: PASSWORD });
  check("[IPC] remote server starts on loopback", status.running && status.port === PORT, status.error);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const web = await context.newPage();
  const remoteErrors = [];
  web.on("pageerror", (e) => remoteErrors.push(e.message));
  await web.goto(remoteBase);
  await web.fill("#remote-password", PASSWORD);
  await web.click('button[type="submit"]');
  await web.getByRole("button", { name: new RegExp(SOURCE_TITLE) }).first().waitFor({ timeout: 15_000 });
  await web.goto(`${remoteBase}/#chat=1`);
  await web.reload();
  await web.getByText(TEXT.masterLast).first().waitFor({ timeout: 15_000 });
  const forkButtons = web.getByRole("button", { name: "이 메시지에서 대화 분기" });
  check("[UI remote] only user and master messages offer a fork; group messages and tool/approval cards do not", await ok(web.getByText(TEXT.masterRoom).first().waitFor({ timeout: 5_000 })) && await forkButtons.count() === 4, await forkButtons.count());
  const remoteCard = (id) => web.locator(`#consult-card-${id}`);
  const remoteState = async (id) => {
    const progress = remoteCard(id).locator("details").filter({ hasText: /작업 과정/ });
    return { card: await remoteCard(id).getAttribute("data-status"), header: await remoteCard(id).getByTestId("remote-consult-status").innerText(), text: await remoteCard(id).innerText(),
      progressOpen: await progress.count() ? await progress.evaluate((d) => d.open) : null };
  };
  check("[UI remote] record-only review shows the record's verdict without a stale run note", await ok(web.getByText(RECORD_ONLY_SUMMARY).first().waitFor({ timeout: 5_000 })) && (await remoteState(5)).text.includes("판단 보류") && !/리뷰 실행 중지|리뷰 진행 중/.test((await remoteState(5)).text));
  const remote5 = await remoteState(5);
  check("[UI remote] record-only review: header and review block both say done", remote5.card === "done" && remote5.header === "완료", JSON.stringify(remote5));
  const remote6 = await remoteState(6);
  check("[UI remote] review stopped by a restart: header, review note and progress agree", remote6.card === "stopped" && remote6.header === "중지" && remote6.text.includes("리뷰 실행 중지") && remote6.progressOpen === false, JSON.stringify(remote6));
  const remote2 = await remoteCard(2).innerText();
  const remote3 = await remoteCard(3).innerText();
  check("[UI remote] review cards show verdicts and the missing result", remote2.includes("수정 요청") && remote2.includes("src/a.ts:12") && remote3.includes("구조화 결과 없음 (통과로 간주하지 않음)"), `${remote2} | ${remote3}`);
  await web.locator("details summary").filter({ hasText: /리뷰 5건/ }).click();
  check("[UI remote] team panel shows the review total and checklist prerequisites", await ok(web.getByText(/실행 미완료 2/).first().waitFor({ timeout: 5_000 })) && await ok(web.getByText(/선행 미완료: API 구현/).waitFor({ timeout: 5_000 })));
  await web.getByRole("button", { name: "협의 1 카드로 이동" }).click();
  check("[UI remote] a checklist consult link moves to and focuses its card", await ok(web.waitForFunction(() => document.activeElement?.id === "consult-card-1", null, { timeout: 5_000 })));
  check("[UI remote] a link to a consult that is not on the page stays disabled", await web.getByRole("button", { name: "협의 99 카드로 이동" }).isDisabled());
  await web.getByRole("button", { name: "실행 통계" }).click();
  const stats = web.getByRole("dialog", { name: "실행 통계" });
  check("[UI remote] run statistics open with the recorded-span note", await ok(stats.waitFor({ timeout: 5_000 })) && /기록 구간/.test(await stats.innerText()) && /모델 추론 시간/.test(await stats.innerText()));
  check("[UI remote] a call whose turn ended reads as unconfirmed, not running", /\+결과 미확인/.test(await stats.innerText()) && !/\+진행 중|도구 진행 중/.test(await stats.innerText()));
  await stats.getByRole("button", { name: "닫기" }).click();
  await forkButtons.last().click();
  const remoteDialog = web.getByRole("dialog", { name: "대화 분기" });
  check("[UI remote] fork dialog states that only the conversation forks", (await remoteDialog.innerText()).includes("대화만 분기되며 작업 폴더는 공유됩니다"));
  await remoteDialog.getByLabel("처음부터 이 메시지까지").check();
  await web.screenshot({ path: join(base, "remote-fork-dialog.png") });
  await remoteDialog.getByRole("button", { name: "새 채팅으로 분기" }).click();
  check("[UI remote] the new chat opens with its origin", await ok(web.getByText(/작업 폴더는 원본과 공유/).waitFor({ timeout: 15_000 })));
  const forkC = (await api(() => window.chatterbox.listChats())).find((c) => c.fork?.sourceEventId === ids.masterLast);
  check("[IPC] the remote fork reached the desktop app", forkC?.fork?.range === "through" && forkC.fork.includeAttachments === false);
  await web.locator("details summary").filter({ hasText: "분기 원문" }).click();
  check("[UI remote] the transcript opens read-only", await ok(web.getByText(`마스터: ${TEXT.masterLast}`).first().waitFor({ timeout: 5_000 })));
  // API-only checks (not UI): CSRF-protected route, validation, local paths removed from snapshots.
  const apiResult = await web.evaluate(async ({ anchor }) => {
    const { csrf } = await (await fetch("/api/session")).json();
    const post = (body) => fetch("/api/chats/1/fork", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
    const bad = await post({ eventId: anchor, range: "sideways", includeAttachments: false });
    const noCsrf = await fetch("/api/chats/1/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: anchor, range: "through", includeAttachments: false }) });
    const good = await post({ eventId: anchor, range: "through", includeAttachments: true });
    const created = await good.json().catch(() => ({}));
    const snapshot = created.chat ? await (await fetch(`/api/chats/${created.chat.id}`)).json() : {};
    const ctx = snapshot.events?.find((e) => e.event.type === "fork_context")?.event;
    return { bad: bad.status, noCsrf: noCsrf.status, good: good.status, fork: created.chat?.fork, paths: (ctx?.attachments ?? []).map((a) => a.path ?? null) };
  }, { anchor: ids.master1 });
  check("[API remote] invalid range is rejected", apiResult.bad === 400, apiResult.bad);
  check("[API remote] fork without the CSRF token is rejected", apiResult.noCsrf >= 400, apiResult.noCsrf);
  check("[API remote] fork returns 201 with its origin", apiResult.good === 201 && apiResult.fork?.sourceChatId === 1, JSON.stringify(apiResult));
  check("[API remote] local attachment paths are not sent to the browser", apiResult.paths.length === 1 && apiResult.paths.every((p) => !p), JSON.stringify(apiResult.paths));
  check("[UI remote] no renderer errors", remoteErrors.length === 0, remoteErrors.join("\n"));

  // ---------- parent deleted: forks keep their snapshot, copies and origin title
  // Deleted through the sidebar menu (the desktop store path), as a user would.
  await page.locator('[data-chat-id="1"] [role="treeitem"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "삭제" }).click();
  await page.getByRole("button", { name: "삭제" }).click();
  await page.locator('[data-chat-id="1"]').waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
  check("[UI] the source chat is deleted from the sidebar menu", await page.locator('[data-chat-id="1"]').count() === 0);
  const ctxAfter = forkA ? forkContextOf(await api((id) => window.chatterbox.loadEvents(id), forkA.id)) : undefined;
  check("[IPC] snapshot survives the source being deleted", !!ctxA && ctxAfter?.text === ctxA.text && ctxAfter.attachments?.[0]?.path === copy?.path);
  check("[FS] copied attachment survives the source being deleted", !!copy && existsSync(copy.path) && readFileSync(copy.path, "utf8") === ATTACH_1.text);
  const forkAAfter = (await api(() => window.chatterbox.listChats())).find((c) => c.id === forkA?.id);
  check("[IPC] origin title and id stay after the source is deleted", forkAAfter?.fork?.sourceTitle === SOURCE_TITLE && forkAAfter.fork.sourceChatId === 1);
  if (forkA) await openChat(forkA.id);
  check("[UI] origin shows '원본 없음' instead of a broken link", await ok(page.getByTestId("fork-source-missing").waitFor({ timeout: 5_000 })) && (await page.getByTestId("fork-origin").innerText()).includes(SOURCE_TITLE));
  if (forkC) { await web.goto(`${remoteBase}/#chat=${forkC.id}`); await web.reload(); }
  check("[UI remote] origin shows '원본 없음' after the source is deleted", await ok(web.getByText("원본 없음(삭제됨)").waitFor({ timeout: 15_000 })));
  await page.screenshot({ path: join(base, "fork-source-deleted-light.png") });
  check("[UI] renderer completed without errors", errors.length === 0, errors.join("\n"));

  console.log(`Screenshots: ${base}`);

  // ---------- shutdown: remote browser first (it holds connections to the app's server), then the app
  const browserClosed = await bounded("remote browser close", () => browser.close());
  check("[harness] remote Edge closed within 30s", browserClosed.ok, browserClosed.error);
  if (browserClosed.ok) browser = undefined;
  // Two different endings: the app's own process exiting ('exit'), and Playwright's close resolving,
  // which also waits for the process's stdio pipes to close ('close'). Each is checked on its own.
  const appProcess = app.process();
  const closeStarted = Date.now();
  const nativeExit = appProcess.exitCode !== null || appProcess.signalCode !== null
    ? Promise.resolve({ code: appProcess.exitCode, signal: appProcess.signalCode, at: closeStarted, before: true })
    : new Promise((resolve) => appProcess.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  void nativeExit.then((e) => console.log(`[shutdown] native exit pid=${appPid} at ${new Date(e.at).toISOString()} (+${e.at - closeStarted}ms after close start${e.before ? ", already exited" : ""}) code=${e.code} signal=${e.signal}`));
  closing = app.close();
  let exit;
  const [exitWait, closeWait] = await Promise.all([
    bounded(`native exit pid=${appPid}`, async () => { exit = await nativeExit; }),
    bounded(`playwright close pid=${appPid}`, () => closing),
  ]);
  const exitedNormally = exitWait.ok && exit.code === 0 && exit.signal === null;
  check("[harness] app process exited with code 0 within 30s", exitedNormally, exit ? `code=${exit.code} signal=${exit.signal} +${exit.at - closeStarted}ms` : `not observed: ${exitWait.error}`);
  // A timeout here stays a FAIL even when the app exited: something still held its output pipes.
  check("[harness] Playwright close completed within 30s", closeWait.ok, closeWait.ok ? "" : `${closeWait.error}; native exit ${exit ? `code=${exit.code} signal=${exit.signal}` : "not observed"}`);
  if (closeWait.ok) closing = undefined;
  if (closeWait.ok && exitedNormally) app = undefined;

  // ---------- database after the app's own process exited normally (the core closed it on the way out)
  if (!exitedNormally) {
    const why = `not run: no normal exit observed (${exit ? `code=${exit.code} signal=${exit.signal}` : "no exit event"})`;
    check("[DB] the copy is registered to the forked chat", false, why);
    check("[DB] no attachment row still points at the deleted source chat", false, why);
  } else {
    const after = new DatabaseSync(join(data, "chatterbox.db"), { readOnly: true });
    const rows = after.prepare("SELECT id, chat_id, path FROM attachments ORDER BY id").all();
    after.close();
    const copyRow = rows.find((r) => r.id === copy?.id);
    check("[DB] the copy is registered to the forked chat", copyRow?.chat_id === forkA?.id && copyRow.path === copy?.path, JSON.stringify(rows));
    check("[DB] no attachment row still points at the deleted source chat", rows.every((r) => r.chat_id !== 1), JSON.stringify(rows));
  }
} catch (error) {
  console.error(error);
  check("improvements UI flow completed", false, error.stack ?? error.message);
} finally {
  // Cleanup after a failure or hang: bounded, and only through the handles this script launched.
  if (browser) await bounded("finally: remote browser close", () => browser.close());
  if (app) {
    // Wait again on the close already in progress rather than starting another one: a second call can
    // resolve without saying anything about the first.
    const closed = await bounded(`finally: ${closing ? "pending playwright close" : "app close"} pid=${appPid}`, () => closing ?? app.close());
    const proc = app.process();
    if (!closed.ok && proc.exitCode === null && proc.signalCode === null) {
      console.log(`[shutdown] finally: killing own app handle pid=${appPid} (already counted as FAIL)`);
      proc.kill();
    }
  }
}
finish();

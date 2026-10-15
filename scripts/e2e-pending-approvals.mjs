// Pending approval placement and history verification for the timeline UI.
// Uses a disposable SQLite fixture plus synthetic renderer events; no real CLI or account is used.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "pending-approvals-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const screenshots = join(base, "screenshots");
const dbFile = join(data, "chatterbox.db");

const settings = {
  claudeStrengths: "e2e",
  claudeCautions: "e2e",
  gptStrengths: "e2e",
  gptCautions: "e2e",
  geminiStrengths: "e2e",
  geminiCautions: "e2e",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  geminiModel: "",
  orchestratorEffort: "xhigh",
  claudeEffort: "auto",
  codexEffort: "auto",
  geminiEffort: "auto",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  maxGeminiWorkers: 1,
  approvalMode: "user",
  delegateHighRisk: false,
};

const REQUESTS = {
  master: {
    id: "e2e-master-bottom-approval",
    role: "orch",
    title: "마스터 선행 승인",
    detail: "Write master-fixture.txt",
    reason: "마스터 요청은 후속 기록 아래의 승인 영역에 남아야 합니다.",
    risk: "low",
  },
  worker: {
    id: "e2e-worker-bottom-approval",
    role: "w1",
    title: "작업자 선행 승인",
    detail: "Write worker-fixture.txt",
    reason: "작업자 요청도 원래 요청 순서를 유지해야 합니다.",
    risk: "low",
  },
  other: {
    id: "e2e-other-chat-approval",
    role: "orch",
    title: "다른 채팅 승인",
    detail: "Write other-fixture.txt",
    risk: "low",
  },
  expired: {
    id: "e2e-expired-history-approval",
    role: "orch",
    title: "만료된 기록 승인",
    detail: "Write expired-fixture.txt",
    risk: "low",
  },
};

function addColumn(db, table, column, ddl) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function seedDatabase() {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(screenshots, { recursive: true });
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    for (const [table, column, ddl] of [
      ["chats", "approval_mode_override", "approval_mode_override TEXT"],
      ["chats", "orchestrator_model_override", "orchestrator_model_override TEXT"],
      ["chats", "goal_json", "goal_json TEXT"],
      ["chats", "gemini_model_override", "gemini_model_override TEXT"],
      ["chats", "orchestrator_effort_override", "orchestrator_effort_override TEXT"],
      ["chats", "claude_effort_override", "claude_effort_override TEXT"],
      ["chats", "codex_effort_override", "codex_effort_override TEXT"],
      ["chats", "gemini_effort_override", "gemini_effort_override TEXT"],
      ["consults", "scope_json", "scope_json TEXT"],
      ["consults", "instruction_id", "instruction_id INTEGER"],
      ["consults", "reason", "reason TEXT"],
      ["consults", "supersedes", "supersedes INTEGER"],
      ["consults", "requested_effort", "requested_effort TEXT"],
      ["consults", "effort", "effort TEXT"],
    ]) addColumn(db, table, column, ddl);

    const now = Date.now();
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', 'dark')").run();
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)").run(
      "Pending approvals E2E",
      workspace,
      JSON.stringify(settings),
      now,
    );
    const insertChat = db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)");
    insertChat.run(1, "승인 배치 대화", now, now + 1);
    insertChat.run(2, "다른 채팅", now, now + 2);
    insertChat.run(3, "이전 기록", now, now + 3);

    db.prepare("INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (1, 1, 'claude', 1, '클로드 1호', 'approval fixture', 'e2e-worker', 'active', ?)").run(now + 1);

    db.prepare(
      "INSERT INTO consults (id, chat_id, seq, from_role, to_role, kind, request, requested_effort, effort, response_summary, files_changed_json, status, started_at, ended_at, scope_json, instruction_id, reason, supersedes) VALUES (1, 1, 1, 'orch', 'w1', 'implement', ?, NULL, NULL, NULL, '[]', 'running', ?, NULL, '[]', 1, ?, NULL)",
    ).run("작업자 승인 흐름을 확인합니다.", now + 3, "격리된 승인 UI 검증 요청");

    const insertEvent = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const event = (id, chatId, node, role, payload) => insertEvent.run(id, chatId, node, role, now + id, payload.type, JSON.stringify(payload));
    event(1, 1, "orch", null, { type: "user", text: "승인 카드 배치 검증을 시작합니다.", attachments: [] });
    event(2, 1, "orch", "orch", { type: "text", text: "초기 마스터 메시지" });
    event(3, 1, "orch", "orch", {
      type: "consult_start",
      consultId: 1,
      kind: "implement",
      from: "orch",
      to: "w1",
      request: "작업자 승인 흐름을 확인합니다.",
      attachments: [],
      instructionId: 1,
      reason: "격리된 승인 UI 검증 요청",
    });
    event(4, 1, "consult:1", "w1", { type: "text", text: "작업자 협의 기록" });
    event(5, 1, "orch", "orch", { type: "approval_request", request: REQUESTS.master });
    event(6, 1, "consult:1", "w1", { type: "approval_request", request: REQUESTS.worker });
    for (let i = 1; i <= 12; i++) event(6 + i, 1, "orch", "orch", { type: "text", text: `후속 메시지 ${String(i).padStart(2, "0")}` });
    event(19, 1, "orch", "orch", { type: "text_delta", text: "후속 스트림 조각 1" });
    event(20, 1, "orch", "orch", { type: "text_delta", text: "후속 스트림 조각 2" });

    event(101, 2, "orch", null, { type: "user", text: "다른 채팅 기록", attachments: [] });
    event(102, 2, "orch", "orch", { type: "approval_request", request: REQUESTS.other });
    event(201, 3, "orch", null, { type: "user", text: "이전 실행 기록", attachments: [] });
    event(202, 3, "orch", "orch", { type: "approval_request", request: REQUESTS.expired });
  } finally {
    db.close();
  }
}

async function installStubs(app) {
  return app.evaluate(({ ipcMain }) => {
    const models = {
      claude: [{ id: "opus", label: "E2E Claude", isDefault: true, reasoningEfforts: ["auto"], defaultReasoningEffort: "auto" }],
      codex: [{ id: "gpt-6-astra", label: "E2E GPT", isDefault: true, reasoningEfforts: ["xhigh"], defaultReasoningEffort: "xhigh" }],
      gemini: [{ id: "e2e-gemini", label: "E2E Gemini", isDefault: true, reasoningEfforts: ["auto"], defaultReasoningEffort: "auto" }],
    };
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => [
      { agent: "claude", path: "e2e-claude" },
      { agent: "codex", path: "e2e-codex" },
      { agent: "gemini", path: "e2e-gemini" },
    ]);
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, agent) => models[agent] ?? []);
    ipcMain.removeHandler("usage:get");
    ipcMain.handle("usage:get", () => ({}));
    globalThis.__e2eApprovalCalls = [];
    ipcMain.removeHandler("chats:approve");
    ipcMain.handle("chats:approve", async (_event, chatId, approvalId, decision) => {
      globalThis.__e2eApprovalCalls.push({ chatId, approvalId, decision });
      return true;
    });
    return true;
  });
}

async function publishEvent(app, chatId, node, role, event, id) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:event", payload);
  }, { id, chatId, node, role, at: Date.now() + id, event });
}

async function openChat(page, chatId) {
  const chat = page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"]`);
  const toggle = chat.getByRole("button", { name: "펼치기", exact: true });
  if (await toggle.count()) await toggle.click();
  await chat.locator('[role="treeitem"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="chat-node"][data-chat-id="${id}"] [role="treeitem"]`)?.getAttribute("aria-selected") === "true", chatId);
  await page.waitForSelector('[data-testid="timeline"]');
}

async function openNode(page, chatId, label) {
  const chat = page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"]`);
  const toggle = chat.getByRole("button", { name: "펼치기", exact: true });
  if (await toggle.count()) await toggle.click();
  await chat.getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction((value) => document.querySelector('[data-testid="chat-title"]')?.parentElement?.textContent?.includes(value), label);
}

async function pendingTitles(page) {
  return page.locator('[data-testid="pending-approvals"] [data-testid="approval"]').evaluateAll((cards) => cards.map((card) => card.textContent ?? ""));
}

async function cardPosition(page, title, lateMarker = "후속 메시지 12") {
  return page.evaluate(({ title: wanted, lateMarker: marker }) => {
    const card = [...document.querySelectorAll('[data-testid="approval"]')].find((element) => element.textContent?.includes(wanted));
    const late = [...document.querySelectorAll('[data-testid="agent-message"]')].find((element) => element.textContent?.includes(marker));
    if (!card || !late) return null;
    return {
      cardTop: card.getBoundingClientRect().top,
      lateTop: late.getBoundingClientRect().top,
      section: card.closest('[data-testid="pending-approvals"]') ? "pending-approvals" : "history",
    };
  }, { title, lateMarker });
}

let app;
let page;
let eventId = 100;
try {
  seedDatabase();
  ({ app, page } = await launch(data));
  await installStubs(app);
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.setViewportSize({ width: 1420, height: 1000 });

  await page.evaluate(async () => {
    await window.chatterbox.updateChat(1, { status: "working" });
    await window.chatterbox.updateChat(2, { status: "approval" });
  });
  await openChat(page, 1);
  await page.waitForSelector('[data-testid="working"]');
  const pending = page.locator('[data-testid="pending-approvals"]');
  await pending.waitFor({ state: "visible" });
  const initialTitles = await pendingTitles(page);
  const lateMessage = page.locator('[data-testid="agent-message"]').filter({ hasText: "후속 메시지 12" });
  const streamMessage = page.locator('[data-testid="agent-message"]').filter({ hasText: "후속 스트림 조각 1" });
  check(
    "unified view puts both pending requests in one bottom section in request order",
    initialTitles.length === 2 && initialTitles[0].includes(REQUESTS.master.title) && initialTitles[1].includes(REQUESTS.worker.title),
    initialTitles.join(" | "),
  );
  check(
    "pending requests are not duplicated in chronological history",
    (await page.locator('[data-testid="approval"]').count()) === 2 && (await pending.locator('[data-testid="approval"]').count()) === 2,
  );
  check(
    "pending section follows the working indicator and later messages stay above it",
    await page.evaluate(() => {
      const working = document.querySelector('[data-testid="working"]');
      const section = document.querySelector('[data-testid="pending-approvals"]');
      return !!working && !!section && !!(working.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING);
    }) && (await cardPosition(page, REQUESTS.worker.title))?.section === "pending-approvals",
  );
  check("many later messages remain before the pending worker card", (await lateMessage.count()) === 1 && ((await cardPosition(page, REQUESTS.worker.title))?.cardTop ?? 0) > ((await cardPosition(page, REQUESTS.worker.title))?.lateTop ?? Number.MAX_SAFE_INTEGER));
  check("streaming deltas remain visible above the pending section", (await streamMessage.count()) === 1 && (await streamMessage.locator(".animate-pulse-dot").count()) === 1);
  await page.screenshot({ path: join(screenshots, "pending-dark-unified.png"), fullPage: true });

  await publishEvent(app, 1, "orch", "orch", { type: "text_delta", text: "즉시 수신한 추가 스트림" }, eventId++);
  await page.waitForFunction(() => document.querySelector('[data-testid="timeline"]')?.textContent?.includes("즉시 수신한 추가 스트림"));
  check("new live output still renders above pending requests", await page.evaluate(() => {
    const output = [...document.querySelectorAll('[data-testid="agent-message"]')].find(el => el.textContent?.includes("즉시 수신한 추가 스트림"));
    const pending = document.querySelector('[data-testid="pending-approvals"]');
    return !!output && !!pending && !!(output.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));

  await openNode(page, 1, "마스터 대화");
  const orchPending = page.locator('[data-testid="pending-approvals"]');
  await orchPending.waitFor({ state: "visible" });
  check("orch view keeps the same pending order and bottom section", (await pendingTitles(page)).join("|") === initialTitles.join("|") && (await orchPending.locator('[data-testid="approval"]').count()) === 2);
  await page.screenshot({ path: join(screenshots, "pending-dark-orch.png"), fullPage: true });

  await page.getByRole("button", { name: "테마 전환" }).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  check("light theme keeps pending section and both cards readable", (await page.locator('[data-testid="pending-approvals"]').count()) === 1 && (await page.locator('[data-testid="pending-approvals"] [data-testid="approval"]').count()) === 2);
  await page.screenshot({ path: join(screenshots, "pending-light-orch.png"), fullPage: true });
  await page.getByRole("button", { name: "테마 전환" }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));

  await openNode(page, 1, "클로드 1호");
  const workerPendingCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.worker.title });
  check("pending worker history is readonly and links to master", (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
    (await workerPendingCard.locator('[data-testid="approve-once"], [data-testid="approve-chat"], [data-testid="approve-deny"]').count()) === 0 &&
    (await workerPendingCard.locator('[data-testid="approval-open-master"]').count()) === 1);
  await workerPendingCard.locator('[data-testid="approval-open-master"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-title"]')?.parentElement?.textContent?.includes("마스터 대화"));
  check("worker navigation opens master with both pending requests", (await pendingTitles(page)).length === 2);

  await openChat(page, 1);
  await page.locator('[data-testid="consult-card"]').first().getByRole("button", { name: "열기" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-title"]')?.parentElement?.textContent?.includes("협의 1"));
  const consultPendingCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.worker.title });
  check("pending consult history is readonly and links to master", (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
    (await consultPendingCard.locator('[data-testid="approve-once"], [data-testid="approve-chat"], [data-testid="approve-deny"]').count()) === 0 &&
    (await consultPendingCard.locator('[data-testid="approval-open-master"]').count()) === 1);
  await consultPendingCard.locator('[data-testid="approval-open-master"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-title"]')?.parentElement?.textContent?.includes("마스터 대화"));

  await page.setViewportSize({ width: 900, height: 560 });
  const timeline = page.locator('[data-testid="timeline"]');
  await timeline.evaluate(el => el.scrollTo({ top: 0 }));
  const toBottom = page.getByRole("button", { name: "맨 아래로", exact: true });
  await toBottom.waitFor({ state: "visible" });
  await toBottom.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="timeline"]');
    return el && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  check("narrow layout can return to pending approval buttons at bottom", await page.locator('[data-testid="pending-approvals"] [data-testid="approval"]').last().evaluate(el => {
    const button = el.querySelector('[data-testid="approve-once"]');
    const timeline = el.closest('[data-testid="timeline"]');
    if (!button || !timeline) return false;
    const box = button.getBoundingClientRect();
    const frame = timeline.getBoundingClientRect();
    return box.top >= frame.top && box.bottom <= frame.bottom && timeline.scrollWidth <= timeline.clientWidth;
  }));
  await page.screenshot({ path: join(screenshots, "pending-narrow-bottom.png"), fullPage: true });
  await page.setViewportSize({ width: 1420, height: 1000 });

  await openChat(page, 1);
  const workerCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.worker.title });
  await workerCard.locator('[data-testid="approve-once"]').click();
  const approvalCalls = await app.evaluate(() => globalThis.__e2eApprovalCalls ?? []);
  check(
    "worker approval button sends the original request id",
    approvalCalls.some((call) => call.chatId === 1 && call.approvalId === REQUESTS.worker.id && call.decision === "once"),
    JSON.stringify(approvalCalls),
  );
  await publishEvent(app, 1, "consult:1", "w1", { type: "approval_resolved", id: REQUESTS.worker.id, decision: "once" }, eventId++);
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-testid="pending-approvals"]');
    return section?.querySelectorAll('[data-testid="approval"]').length === 1 && !section.textContent?.includes("작업자 선행 승인");
  });
  const resolvedWorkerPosition = await cardPosition(page, REQUESTS.worker.title);
  const masterPendingPosition = await cardPosition(page, REQUESTS.master.title);
  check(
    "resolving one request removes only that card from pending",
    (await page.locator('[data-testid="pending-approvals"] [data-testid="approval"]').count()) === 1 &&
      (await page.locator('[data-testid="pending-approvals"]').textContent())?.includes(REQUESTS.master.title) &&
      !((await page.locator('[data-testid="pending-approvals"]').textContent())?.includes(REQUESTS.worker.title)),
  );
  check(
    "resolved worker request returns to its historical position",
    resolvedWorkerPosition?.section !== "pending-approvals" && resolvedWorkerPosition?.cardTop < resolvedWorkerPosition?.lateTop,
    JSON.stringify({ resolvedWorkerPosition, masterPendingPosition }),
  );

  const masterCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.master.title });
  await masterCard.locator('[data-testid="approve-deny"]').click();
  const callsAfterMaster = await app.evaluate(() => globalThis.__e2eApprovalCalls ?? []);
  check("master approval button sends its original request id", callsAfterMaster.some((call) => call.chatId === 1 && call.approvalId === REQUESTS.master.id && call.decision === "deny"));
  await publishEvent(app, 1, "orch", "orch", { type: "approval_resolved", id: REQUESTS.master.id, decision: "deny" }, eventId++);
  await page.waitForFunction(() => !document.querySelector('[data-testid="pending-approvals"]'));
  const resolvedMasterPosition = await cardPosition(page, REQUESTS.master.title);
  const resolvedWorkerAgain = await cardPosition(page, REQUESTS.worker.title);
  check(
    "resolving the second request removes the bottom section and restores both historical cards",
    (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
      resolvedMasterPosition?.section !== "pending-approvals" &&
      resolvedWorkerAgain?.section !== "pending-approvals" &&
      resolvedMasterPosition?.cardTop < resolvedWorkerAgain?.cardTop &&
      resolvedWorkerAgain?.cardTop < resolvedWorkerAgain?.lateTop,
    JSON.stringify({ resolvedMasterPosition, resolvedWorkerAgain }),
  );

  await openChat(page, 1);
  await openNode(page, 1, "클로드 1호");
  const workerHistoryCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.worker.title });
  check(
    "resolved worker history remains chronological and readonly",
    (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
      (await workerHistoryCard.locator('[data-testid="approve-once"], [data-testid="approve-chat"], [data-testid="approve-deny"]').count()) === 0 &&
      (await workerHistoryCard.getByRole("button", { name: "마스터 대화에서 확인" }).count()) === 0,
  );

  await openChat(page, 1);
  const consultCard = page.locator('[data-testid="consult-card"]').first();
  await consultCard.getByRole("button", { name: "열기" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-title"]')?.parentElement?.textContent?.includes("협의 1"));
  const consultApproval = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.worker.title });
  check(
    "resolved consult history remains readonly without approval buttons",
    (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
      (await consultApproval.locator('[data-testid="approve-once"], [data-testid="approve-chat"], [data-testid="approve-deny"]').count()) === 0 &&
      (await consultApproval.getByRole("button", { name: "마스터 대화에서 확인" }).count()) === 0,
  );

  await openChat(page, 1);
  const otherCardInMain = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.other.title });
  check("approval from another chat does not leak into the selected chat", (await otherCardInMain.count()) === 0);
  await openChat(page, 2);
  await page.locator('[data-testid="pending-approvals"]').waitFor({ state: "visible" });
  check("other chat keeps only its own pending request", (await pendingTitles(page)).length === 1 && (await pendingTitles(page))[0].includes(REQUESTS.other.title));
  await openChat(page, 3);
  const expiredCard = page.locator('[data-testid="approval"]').filter({ hasText: REQUESTS.expired.title });
  await expiredCard.waitFor({ state: "visible" });
  check(
    "idle history converts unanswered approval into an expired historical card",
    (await page.locator('[data-testid="pending-approvals"]').count()) === 0 &&
      (await expiredCard.getAttribute("data-state")) === "done" &&
      (await expiredCard.locator('[data-testid="approve-once"], [data-testid="approve-chat"], [data-testid="approve-deny"]').count()) === 0,
  );

} catch (error) {
  console.error(error);
  check("pending approval E2E completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

const files = readdirSync(screenshots, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".png")).map((entry) => join(screenshots, entry.name));
console.log(`Screenshots (${files.length}):`);
for (const file of files) console.log(file);
console.log(`Scratch data and screenshots: ${base}`);
finish();

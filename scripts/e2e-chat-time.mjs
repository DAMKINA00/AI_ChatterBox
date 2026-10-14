// Isolated UI smoke for busy elapsed time and sidebar relative timestamps.
// Run after the production build: node scripts/e2e-chat-time.mjs
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "chat-time-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");
const clockNow = Date.now();
const instructionAt = clockNow - 3_723_000;
const sidebarAt = clockNow - 59_000;
mkdirSync(workspace, { recursive: true });

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const settings = {
      ...DEFAULTS,
      geminiModel: "",
      orchestratorEffort: "xhigh",
      claudeEffort: "auto",
      codexEffort: "auto",
      geminiEffort: "auto",
      maxGeminiWorkers: 1,
      approvalMode: "orchestrator",
      delegateHighRisk: false,
    };
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "시간 표시 확인",
      workspace,
      JSON.stringify(settings),
      clockNow,
    );
    const chat = db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)",
    );
    chat.run(1, "작업 시간 확인", instructionAt, sidebarAt);
    chat.run(2, "다른 채팅", clockNow, clockNow);
    db.prepare(
      "INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (?, 1, 'claude', 1, ?, ?, ?, 'active', ?)",
    ).run(1, "클로드 1호", "시간 표시 확인", "e2e-chat-time-worker", clockNow);
    db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, 'orch', NULL, ?, 'user', ?)").run(
      1,
      instructionAt,
      JSON.stringify({ type: "user", text: "시간 표시를 확인합니다", attachments: [] }),
    );
  } finally {
    db.close();
  }
}

async function waitUntil(read, predicate, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await read();
}

function elapsedSeconds(text) {
  const hours = Number(text.match(/(\d+)시간/)?.[1] ?? 0);
  const minutes = Number(text.match(/(\d+)분/)?.[1] ?? 0);
  const seconds = Number(text.match(/(\d+)초/)?.[1] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

async function sendChatUpdate(app, chat) {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:updated", value);
  }, chat);
}

async function sendEvents(app, events) {
  await app.evaluate(({ BrowserWindow }, values) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (const value of values) contents.send("chat:event", value);
  }, events);
}

let app;
try {
  seedDatabase();
  ({ app } = await launch(data));
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 900 });

  // Install the page clock before the reload so the production timers are controlled.
  await page.clock.install({ time: new Date(clockNow) });
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');

  const chat1 = page.locator('[data-testid="chat-node"][data-chat-id="1"]');
  const chat2 = page.locator('[data-testid="chat-node"][data-chat-id="2"]');
  const age = chat1.locator("span[title]");
  check("sidebar initially shows recent activity", (await age.textContent()) === "방금", await age.textContent());
  check("sidebar relative time title contains a full local date", /\d{4}/.test((await age.getAttribute("title")) ?? ""), await age.getAttribute("title"));

  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="timeline"]');
  const initialChat = await page.evaluate((id) => window.chatterbox.listChats(1).then((list) => list.find((chat) => chat.id === id)), 1);
  await sendChatUpdate(app, { ...initialChat, status: "working" });
  await page.waitForSelector('[data-testid="working"]');

  const working = page.locator('[data-testid="working"]');
  const firstText = await working.innerText();
  const firstElapsed = elapsedSeconds(firstText);
  check("busy indicator includes elapsed time with hours", /작업 중… · 1시간 \d+분 \d+초/.test(firstText), firstText);
  check("busy elapsed starts from the persisted user instruction", firstElapsed >= 3_600, firstText);

  await page.clock.fastForward(2_100);
  await page.waitForTimeout(50);
  const incrementedText = await working.innerText();
  const incrementedElapsed = elapsedSeconds(incrementedText);
  check("busy elapsed increments with the page clock", incrementedElapsed > firstElapsed, `${firstText} → ${incrementedText}`);

  await sendEvents(app, [
    {
      id: 101,
      chatId: 1,
      node: "orch",
      role: null,
      at: clockNow + 2_000,
      event: { type: "user", text: "즉시 전달 대기", attachments: [], queued: true, delivery: "now" },
    },
    {
      id: 102,
      chatId: 1,
      node: "orch",
      role: null,
      at: clockNow + 2_001,
      event: { type: "user", text: "다음 단계 대기", attachments: [], queued: true, delivery: "next" },
    },
    {
      id: 103,
      chatId: 1,
      node: "w1",
      role: "w1",
      at: clockNow + 2_002,
      event: { type: "text_delta", text: "작업자 활동" },
    },
  ]);
  const queuedRows = await waitUntil(() => page.locator('[data-testid="user-message"]').count(), (count) => count >= 3);
  check("queued now/next messages render without becoming the timer start", queuedRows >= 3);
  await page.waitForTimeout(50);
  const afterActivityText = await working.innerText();
  const afterActivityElapsed = elapsedSeconds(afterActivityText);
  check("queued input and worker activity do not reset elapsed time", afterActivityElapsed >= incrementedElapsed - 1, `${incrementedText} → ${afterActivityText}`);

  await chat1.getByRole("button", { name: "펼치기" }).click();
  await chat1.locator('[data-testid="tree-node"]').filter({ hasText: "클로드 1호" }).click();
  const workerVisible = await waitUntil(() => page.locator('[data-testid="working"]').count(), (count) => count === 1);
  const workerElapsed = elapsedSeconds(await working.innerText());
  check("switching to the worker view preserves the timer", workerVisible === 1 && workerElapsed >= afterActivityElapsed - 1);

  await chat2.locator('[role="treeitem"]').click();
  const idleChatVisible = await waitUntil(() => page.locator('[data-testid="working"]').count(), (count) => count === 0);
  check("switching to another idle chat hides its timer", idleChatVisible === 0);
  await chat1.locator('[role="treeitem"]').click();
  const restoredVisible = await waitUntil(() => page.locator('[data-testid="working"]').count(), (count) => count === 1);
  const restoredElapsed = elapsedSeconds(await working.innerText());
  check("returning to the original chat preserves the instruction start", restoredVisible === 1 && restoredElapsed >= workerElapsed - 1);

  await page.clock.fastForward(30_000);
  await page.waitForTimeout(50);
  const refreshedAge = await waitUntil(() => age.textContent(), (value) => value === "1분 전");
  check("sidebar age refreshes after 30 seconds without new events", refreshedAge === "1분 전", refreshedAge);

  const fakeNow = await page.evaluate(() => Date.now());
  const currentChat = await page.evaluate((id) => window.chatterbox.listChats(1).then((list) => list.find((chat) => chat.id === id)), 1);
  await sendChatUpdate(app, { ...currentChat, status: "working", lastActiveAt: fakeNow });
  const pushedAge = await waitUntil(() => age.textContent(), (value) => value === "방금");
  check("sidebar age updates from a pushed chat.lastActiveAt", pushedAge === "방금", pushedAge);
  check("pushed sidebar timestamp keeps its full local date title", /\d{4}/.test((await age.getAttribute("title")) ?? ""), await age.getAttribute("title"));

  await page.screenshot({ path: join(base, "chat-time-working.png") });
  await sendChatUpdate(app, { ...currentChat, status: "idle", lastActiveAt: fakeNow });
  const hidden = await waitUntil(() => page.locator('[data-testid="working"]').count(), (count) => count === 0);
  check("idle status hides the elapsed timer", hidden === 0);
  await page.screenshot({ path: join(base, "chat-time-idle.png") });
  console.log("Screenshot:", join(base, "chat-time-working.png"));
  console.log("Evidence:", base);
} catch (error) {
  check("chat time e2e completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

finish();

// Stored timeline layout verification. Seeded events use fixed historical timestamps;
// no model or worker is started. Run after the production build.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root, scratchDir } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = scratchDir("e2e-chat-layout");
const data = join(base, "data");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");
const artifactPath = join(workspace, "결과 폴더", "layout-result.txt");
const userAt = Date.UTC(2024, 1, 3, 4, 5, 6);
const agentAt = Date.UTC(2024, 1, 3, 4, 6, 7);

mkdirSync(join(data), { recursive: true });
mkdirSync(join(workspace, "결과 폴더"), { recursive: true });
writeFileSync(artifactPath, "chat layout artifact\n");

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const settings = {
      ...DEFAULTS,
      claudeStrengths: "layout test",
      claudeCautions: "layout test",
      gptStrengths: "layout test",
      gptCautions: "layout test",
      geminiStrengths: "layout test",
      geminiCautions: "layout test",
      geminiModel: "",
      orchestratorEffort: "xhigh",
      claudeEffort: "auto",
      codexEffort: "auto",
      geminiEffort: "auto",
      approvalMode: "orchestrator",
      delegateHighRisk: false,
      maxClaudeWorkers: 2,
      maxGptWorkers: 2,
      maxGeminiWorkers: 1,
    };
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "채팅 레이아웃",
      workspace,
      JSON.stringify(settings),
      userAt,
    );
    db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)").run(
      1,
      "기록 시간 확인",
      userAt,
      agentAt,
    );
    const event = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, 'orch', ?, ?, ?, ?)");
    event.run(1, null, userAt, "user", JSON.stringify({ type: "user", text: "과거 사용자 메시지", attachments: [] }));
    event.run(2, "orch", agentAt, "text", JSON.stringify({ type: "text", text: "과거 마스터 응답" }));
    event.run(3, "orch", agentAt + 1, "artifacts", JSON.stringify({ type: "artifacts", paths: [artifactPath] }));
  } finally {
    db.close();
  }
}

function localClock(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

let app;
try {
  seedDatabase();
  const launched = await launch(data);
  app = launched.app;
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="timeline"]');
  await page.waitForSelector('[data-testid="agent-message"]');

  const userTime = page.locator('[data-testid="user-message"] [data-testid="item-time"]');
  const agentTime = page.locator('[data-testid="agent-message"] [data-testid="item-time"]');
  check("user row keeps the stored local HH:mm", (await userTime.textContent()) === localClock(userAt));
  check("agent row keeps the stored local HH:mm", (await agentTime.textContent()) === localClock(agentAt));
  check("times expose full local dates in title", (await userTime.getAttribute("title"))?.includes("2024") && (await agentTime.getAttribute("title"))?.includes("2024"));
  check("chat rows use a 36px avatar column", (await page.locator('[data-testid="agent-message"] img[data-testid="agent-avatar"]').getAttribute("class"))?.includes("size-9"));
  check("user messages use the same plain row layout", (await page.locator('[data-testid="user-message"]').getAttribute("class"))?.includes("grid-cols-[36px_minmax(0,1fr)_auto]"));
  check("role dots are absent from rendered timeline rows", (await page.locator('[data-testid="timeline"] .bg-orch, [data-testid="timeline"] .bg-claude, [data-testid="timeline"] .bg-gpt, [data-testid="timeline"] .bg-gemini').count()) === 0);
  check("artifact paths remain visible as file links", (await page.locator('[data-testid="artifacts"]').count()) === 1 && (await page.getByRole("button", { name: "layout-result.txt" }).count()) === 1);
  check("role dots are absent from header and sidebar", await page.locator('.size-2.rounded-full.bg-orch, .size-2.rounded-full.bg-claude, .size-2.rounded-full.bg-gpt, .size-2.rounded-full.bg-gemini').count() === 0);
  const row = await page.locator('[data-testid="agent-message"]').boundingBox(), time = await agentTime.boundingBox();
  check("saved time is at the right edge of the message row", row && time && row.x + row.width - (time.x + time.width) < 12);
  await page.screenshot({ path: join(base, "discord-dark.png") });
  await page.getByRole("button", { name: "테마 전환" }).click();
  await page.screenshot({ path: join(base, "discord-light.png") });
  const chat = await page.evaluate(async () => (await window.chatterbox.listChats(1))[0]);
  await app.evaluate(({ ipcMain, BrowserWindow }, chat) => {
    globalThis.layoutSends = [];
    ipcMain.removeHandler("chats:send");
    ipcMain.handle("chats:send", (_e, id, text, attachments, delivery) => { globalThis.layoutSends.push({ id, text, attachments, delivery }); });
    BrowserWindow.getAllWindows()[0].webContents.send("chat:updated", { ...chat, status: "working" });
  }, chat);
  await page.getByRole("textbox", { name: "메시지 입력" }).fill("immediate click");
  await page.locator('[data-testid="send-now"]').click();
  await page.getByRole("textbox", { name: "메시지 입력" }).fill("next step");
  await page.locator('[data-testid="send"]').click();
  await page.getByRole("textbox", { name: "메시지 입력" }).fill("immediate keyboard");
  await page.getByRole("textbox", { name: "메시지 입력" }).press("Control+Enter");
  const sends = await app.evaluate(() => globalThis.layoutSends);
  check("composer sends immediate, next-step and Ctrl+Enter modes", JSON.stringify(sends.map((s) => s.delivery)) === JSON.stringify(["now", "next", "now"]));
  await page.setViewportSize({ width: 900, height: 900 });
  check("compact window keeps both send controls visible", await page.locator('[data-testid="send-now"]').isVisible() && await page.locator('[data-testid="send"]').isVisible());
  check("compact window has no horizontal document overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(base, "discord-compact.png") });
  await app.close();
  app = undefined;
  const reopened = await launch(data);
  app = reopened.app;
  await reopened.page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  check("restart retains historical message time", await reopened.page.locator('[data-testid="agent-message"] [data-testid="item-time"]').getAttribute("datetime") === new Date(agentAt).toISOString());
} catch (error) {
  check("chat layout e2e completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

finish();

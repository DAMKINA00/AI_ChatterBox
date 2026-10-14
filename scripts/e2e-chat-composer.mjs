// Focused composer interaction verification. All chat sends are mocked in the
// Electron main process; the database and attachment responses live in scratch data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root, scratchDir } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = scratchDir("e2e-chat-composer");
const data = join(base, "data");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");

mkdirSync(data, { recursive: true });
mkdirSync(workspace, { recursive: true });

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const settings = {
      ...DEFAULTS,
      claudeStrengths: "composer test",
      claudeCautions: "composer test",
      gptStrengths: "composer test",
      gptCautions: "composer test",
      geminiStrengths: "composer test",
      geminiCautions: "composer test",
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
      "컴포저 키 테스트",
      workspace,
      JSON.stringify(settings),
      Date.now(),
    );
    db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)").run(
      1,
      "전달 키 확인",
      Date.now(),
      Date.now(),
    );
    db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, 'orch', ?, ?, ?, ?)").run(
      1,
      null,
      Date.now(),
      "user",
      JSON.stringify({ type: "user", text: "기존 사용자 기록", attachments: [] }),
    );
  } finally {
    db.close();
  }
}

async function waitForSends(app, count) {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    const sends = await app.evaluate(() => globalThis.composerSends ?? []);
    if (sends.length >= count) return sends;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return app.evaluate(() => globalThis.composerSends ?? []);
}

async function setChatStatus(app, chat, status) {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:updated", value);
  }, { ...chat, status });
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
  await page.waitForSelector('[data-testid="user-message"]');
  const adminAvatar = page.locator('[data-testid="user-message"] img[data-kind="admin"]');
  const adminAvatarLoaded = await page
    .waitForFunction(() => document.querySelector('[data-testid="user-message"] img[data-kind="admin"]')?.naturalWidth > 0, undefined, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const userRow = page.locator('[data-testid="user-message"]').first();
  check("historical user rows use the admin label and loaded avatar", (await userRow.textContent())?.includes("관리자") && (await adminAvatar.count()) === 1 && adminAvatarLoaded);
  const box = page.getByRole("textbox", { name: "메시지 입력" });
  await box.waitFor({ state: "visible" });
  const chat = await page.evaluate(async () => (await window.chatterbox.listChats())[0]);

  await app.evaluate(({ ipcMain }) => {
    globalThis.composerSends = [];
    ipcMain.removeHandler("chats:send");
    ipcMain.handle("chats:send", (_event, id, text, attachments, delivery) => {
      globalThis.composerSends.push({ id, text, attachments, delivery });
    });
  });

  const send = page.locator('[data-testid="send"]');
  check("idle composer has one normal send button", (await send.count()) === 1 && (await page.locator('[data-testid="send-next"]').count()) === 0);
  check("idle send button keeps Enter hint", (await send.getAttribute("aria-label")) === "보내기" && (await send.getAttribute("title")) === "Enter");
  await page.screenshot({ path: join(base, "composer-idle.png") });

  await box.fill("idle Enter");
  await box.press("Enter");
  let sends = await waitForSends(app, 1);
  check("idle Enter sends immediately", sends[0]?.delivery === "now" && sends[0]?.text === "idle Enter" && sends[0]?.attachments?.length === 0);

  await box.fill("shift line");
  const beforeShift = sends.length;
  await box.press("Shift+Enter");
  check("Shift+Enter inserts a newline without sending", (await box.inputValue()) === "shift line\n" && (await app.evaluate(() => globalThis.composerSends.length)) === beforeShift);

  await box.fill("composing");
  await box.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
  });
  check("IME Enter does not send", (await box.inputValue()) === "composing" && (await app.evaluate(() => globalThis.composerSends.length)) === beforeShift);

  await setChatStatus(app, chat, "working");
  await page.locator('[data-testid="send-next"]').waitFor({ state: "visible" });
  const immediate = page.locator('[data-testid="send"]');
  const next = page.locator('[data-testid="send-next"]');
  const immediateClass = await immediate.getAttribute("class") ?? "";
  const nextClass = await next.getAttribute("class") ?? "";
  check(
    "busy composer exposes filled immediate and outline next buttons",
    (await immediate.getAttribute("aria-label")) === "마스터에게 즉시 전달" &&
      (await immediate.getAttribute("title")) === "Enter" &&
      (await immediate.textContent())?.includes("즉시 전달") &&
      immediateClass.includes("bg-primary") &&
      (await next.getAttribute("aria-label")) === "다음 단계로 전달" &&
      (await next.getAttribute("title")) === "Alt+Enter" &&
      (await next.textContent())?.includes("다음 단계 전달") &&
      nextClass.includes("bg-transparent"),
  );
  const hint = await page.locator('[data-testid="send"]').locator("xpath=../..").textContent();
  check("busy composer explains Enter, Alt+Enter, Shift+Enter and paste", ["Enter", "Alt+Enter", "Shift+Enter", "Ctrl+V"].every((key) => hint?.includes(key)));
  check("busy placeholder names immediate and next delivery", (await box.getAttribute("placeholder"))?.includes("Enter") && (await box.getAttribute("placeholder"))?.includes("Alt+Enter"));
  await page.screenshot({ path: join(base, "composer-busy.png") });

  await box.fill("busy Enter");
  await box.press("Enter");
  sends = await waitForSends(app, 2);
  check("busy Enter still sends immediately", sends[1]?.delivery === "now" && sends[1]?.text === "busy Enter");

  await box.fill("busy Alt+Enter");
  await box.press("Alt+Enter");
  sends = await waitForSends(app, 3);
  check("busy Alt+Enter sends to the next stage", sends[2]?.delivery === "next" && sends[2]?.text === "busy Alt+Enter");

  await box.fill("button immediate");
  await immediate.click();
  sends = await waitForSends(app, 4);
  await box.fill("button next");
  await next.click();
  sends = await waitForSends(app, 5);
  check("busy buttons preserve immediate and next delivery", sends[3]?.delivery === "now" && sends[4]?.delivery === "next");

  await setChatStatus(app, chat, "idle");
  await page.locator('[data-testid="send-next"]').waitFor({ state: "detached" });
  await box.fill("");
  await app.evaluate(({ ipcMain }, attachmentPath) => {
    ipcMain.removeHandler("att:bytes");
    ipcMain.handle("att:bytes", (_event, _chatId, name, mime, bytes) => ({
      id: 901,
      name,
      mime,
      size: bytes.byteLength,
      path: attachmentPath,
    }));
  }, join(workspace, "only.txt"));
  await box.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["attachment-only"], "only.txt", { type: "text/plain" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('[data-testid="pending-attachments"] [data-testid="attachment"]');
  check("attachment paste keeps the pending attachment visible", (await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').count()) === 1);
  await send.click();
  sends = await waitForSends(app, 6);
  check("idle attachment-only send preserves attachment ids", sends[5]?.delivery === "now" && sends[5]?.text === "" && JSON.stringify(sends[5]?.attachments) === JSON.stringify([901]));
  check("attachment-only send clears the pending chip", (await page.locator('[data-testid="pending-attachments"]').count()) === 0);
} catch (error) {
  check("composer e2e completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

finish();

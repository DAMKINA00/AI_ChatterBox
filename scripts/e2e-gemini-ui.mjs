// Isolated Gemini worker UI verification. Seeds only normalized app data; it never sends a model turn.
// Usage: node scripts/e2e-gemini-ui.mjs
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "gemini-ui", String(Date.now()));
const data = join(base, "data");
const screenshots = join(base, "screenshots");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");
mkdirSync(workspace, { recursive: true });
mkdirSync(screenshots, { recursive: true });

const settings = {
  claudeStrengths: "Claude UI 테스트 강점",
  claudeCautions: "Claude UI 테스트 주의점",
  gptStrengths: "GPT UI 테스트 강점",
  gptCautions: "GPT UI 테스트 주의점",
  geminiStrengths: "Gemini UI 테스트 강점",
  geminiCautions: "Gemini UI 테스트 주의점",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  geminiModel: "",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  maxGeminiWorkers: 2,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const chatColumns = db.prepare("PRAGMA table_info(chats)").all();
    if (!chatColumns.some((column) => column.name === "gemini_model_override")) db.exec("ALTER TABLE chats ADD COLUMN gemini_model_override TEXT");

    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "Gemini UI 점검",
      workspace,
      JSON.stringify(settings),
      now,
    );
    db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)",
    ).run(1, "Gemini 작업자 기록", now, now + 1);

    const insertAgent = db.prepare(
      "INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (?, 1, 'gemini', ?, ?, ?, ?, ?, ?)",
    );
    insertAgent.run(1, 1, "제미나이 1호", "활성 UI 작업", "gemini-active-session", "active", now + 1);
    insertAgent.run(2, 2, "제미나이 2호", "이전 UI 작업", "gemini-released-session", "released", now + 2);

    const insertEvent = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, ?, ?, ?, ?, ?)");
    const event = (id, node, role, payload) => insertEvent.run(id, node, role, now + id, payload.type, JSON.stringify(payload));
    event(1, "orch", "orch", { type: "text", text: "Gemini 작업자 UI를 확인하는 대화입니다." });
    event(2, "w1", "w1", { type: "expression", expression: "speaking" });
    event(3, "w1", "w1", { type: "text", text: "활성 제미나이 작업자의 메시지입니다." });
    event(4, "w1", "w1", {
      type: "agent_usage",
      metrics: { turnId: "gemini-active-turn", inputTokens: 120, outputTokens: 45, cachedInputTokens: 12, cacheWriteInputTokens: 3, elapsedMs: 12_000, model: "gemini-pro" },
    });
    event(5, "w1", "w1", { type: "turn_end", ok: true });
    event(6, "w2", "w2", { type: "expression", expression: "thinking" });
    event(7, "w2", "w2", { type: "text", text: "해제된 제미나이 작업자의 이전 기록입니다." });
    event(8, "w2", "w2", {
      type: "agent_usage",
      metrics: { turnId: "gemini-released-turn", inputTokens: 80, outputTokens: 20, cachedInputTokens: 4, cacheWriteInputTokens: 1, elapsedMs: 8_000, model: "gemini-pro" },
    });
    event(9, "w2", "w2", { type: "turn_end", ok: true });
  } finally {
    db.close();
  }
}

function persistedProject() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT name, folder, settings_json FROM projects WHERE id = 1").get();
    return { ...row, settings: JSON.parse(row.settings_json) };
  } finally {
    db.close();
  }
}

async function isolateModelListing(app) {
  // Model pickers still render their controls and Gemini's automatic option, but no CLI listing or model turn is allowed.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", async () => []);
  });
}

async function openSettings(page) {
  const project = page.locator('[data-testid="project-node"]', { hasText: "Gemini UI 점검" });
  await project.getByRole("button", { name: "Gemini UI 점검 메뉴" }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "프로젝트 설정" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function openChat(page) {
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-chip"]').length === 2);
}

let app;
let page;
try {
  seedDatabase();
  ({ app, page } = await launch(data));
  await isolateModelListing(app);
  await page.setViewportSize({ width: 1420, height: 1000 });
  await openChat(page);

  const chips = page.locator('[data-testid="team-chip"]');
  const roles = await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-role")));
  check("Gemini active and released workers are seeded", roles.length === 2 && roles[0] === "w1" && roles[1] === "w2", roles.join(", "));
  check("released Gemini worker is grouped separately", (await page.locator('[data-testid="released-workers"] [data-role="w2"]').count()) === 1);
  check(
    "released Gemini worker uses gray treatment",
    (await page.locator('[data-testid="released-workers"] [data-role="w2"]').evaluate((el) => el.className.includes("grayscale"))) &&
      (await page.locator('[data-testid="released-workers"] [data-role="w2"] [data-kind="gemini"]').evaluate((el) => el.className.includes("grayscale"))),
  );
  check(
    "Gemini avatars preserve kind and expression metadata",
    (await page.locator('[data-testid="agent-message"][data-role="w1"][data-expression="speaking"] [data-testid="agent-avatar"][data-kind="gemini"][data-expression="speaking"]').count()) === 1 &&
      (await page.locator('[data-testid="agent-message"][data-role="w2"][data-expression="thinking"] [data-testid="agent-avatar"][data-kind="gemini"][data-expression="thinking"]').count()) === 1,
  );
  check(
    "active and released Gemini messages are rendered",
    (await page.locator('[data-testid="agent-message"][data-role="w1"]').textContent())?.includes("활성 제미나이") &&
      (await page.locator('[data-testid="agent-message"][data-role="w2"]').textContent())?.includes("해제된 제미나이"),
  );

  const usage = page.locator('[data-testid="agent-usage-w1"]');
  await usage.click();
  const usageMenu = page.getByRole("menu");
  await usageMenu.waitFor({ state: "visible" });
  const usageText = await usageMenu.textContent();
  check("Gemini usage row shows token counts", usageText?.includes("입력 120") && usageText.includes("출력 45") && usageText.includes("캐시 읽기 12"), usageText);
  await page.keyboard.press("Escape");

  const released = page.locator('[data-testid="released-workers"] [data-testid="team-chip"][data-role="w2"]');
  await released.click();
  await page.waitForFunction(() => document.querySelector("header")?.textContent?.includes("제미나이 2호"));
  check(
    "released Gemini worker opens its history",
    (await page.locator('[data-testid="agent-message"][data-role="w2"]').textContent())?.includes("해제된 제미나이 작업자의 이전 기록"),
  );

  const geminiPicker = page.getByLabel("이 채팅의 제미나이 모델");
  check("Gemini header model picker renders Pro automatic selection", (await geminiPicker.textContent())?.includes("Pro 자동 선택"));
  await geminiPicker.click();
  const automatic = page.getByRole("menuitem", { name: "Pro 자동 선택", exact: true });
  check("Gemini model list includes the automatic selection item", (await automatic.count()) === 1);
  await automatic.click();

  await page.evaluate(async () => {
    await window.chatterbox.updateChat(1, { geminiModelOverride: "gemini-test-model" });
  });
  await page.waitForFunction(() => document.querySelector('[aria-label="이 채팅의 제미나이 모델"]')?.textContent?.includes("gemini-test-model"));
  await geminiPicker.click();
  const reset = page.getByRole("menuitem", { name: /프로젝트 값 사용/ });
  check("Gemini chat override can return to the project value", (await reset.count()) === 1);
  await reset.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="이 채팅의 제미나이 모델"]')?.textContent?.includes("Pro 자동 선택"));

  const dialog = await openSettings(page);
  const projectGeminiPicker = dialog.getByLabel("제미나이 모델");
  check("project Gemini model picker uses the automatic selection label", (await projectGeminiPicker.textContent())?.includes("Pro 자동 선택"));
  await projectGeminiPicker.click();
  check("project Gemini model list can select automatic selection", (await page.getByRole("menuitem", { name: "Pro 자동 선택", exact: true }).count()) === 1);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("제미나이가 잘 맡는 작업").fill("저장된 Gemini 강점");
  await dialog.getByLabel("제미나이 작업자 주의점").fill("저장된 Gemini 주의점");
  const maxGemini = dialog.locator("label").filter({ hasText: "동시 제미나이 작업자" }).locator("input");
  await maxGemini.fill("0");
  check("Gemini worker limit accepts zero as disabled", (await maxGemini.inputValue()) === "0");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const saved = persistedProject();
  check(
    "Gemini preferences and disabled worker limit persist",
    saved.settings.geminiStrengths === "저장된 Gemini 강점" && saved.settings.geminiCautions === "저장된 Gemini 주의점" && saved.settings.maxGeminiWorkers === 0,
    JSON.stringify(saved.settings),
  );
  await page.screenshot({ path: join(screenshots, "gemini-workers.png"), fullPage: true });
  check("Gemini UI screenshot is kept inside scratch", existsSync(join(screenshots, "gemini-workers.png")));

  await app.close();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 500));
  ({ app, page } = await launch(data));
  await isolateModelListing(app);
  await page.setViewportSize({ width: 1420, height: 1000 });
  await openChat(page);
  check(
    "Gemini messages and released gray treatment survive restart",
    (await page.locator('[data-testid="agent-message"][data-role="w1"]').textContent())?.includes("활성 제미나이") &&
      (await page.locator('[data-testid="agent-message"][data-role="w2"]').textContent())?.includes("해제된 제미나이") &&
      (await page.locator('[data-testid="released-workers"] [data-role="w2"]').evaluate((el) => el.className.includes("grayscale"))),
  );
  const restartedProjects = await page.evaluate(() => window.chatterbox.listProjects());
  const restartedSettings = restartedProjects.find((project) => project.id === 1)?.settings;
  check(
    "Gemini settings survive restart",
    restartedSettings?.geminiStrengths === "저장된 Gemini 강점" && restartedSettings.geminiCautions === "저장된 Gemini 주의점" && restartedSettings.maxGeminiWorkers === 0,
  );
  await page.locator('[data-testid="agent-usage-w1"]').click();
  const restartedUsage = page.getByRole("menu");
  await restartedUsage.waitFor({ state: "visible" });
  check("Gemini token metrics replay after restart", (await restartedUsage.textContent())?.includes("출력 45"));
  await page.keyboard.press("Escape");
} catch (error) {
  console.error(error);
  check("Gemini UI verification completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Scratch data and screenshots: ${base}`);
finish();

// Isolated reasoning-effort UI verification. It stubs model metadata and never starts a CLI turn.
// Run after the production build: node scripts/e2e-effort-ui.mjs
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "effort-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const screenshots = join(base, "screenshots");
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
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

const oldSettings = { ...settings };
for (const key of ["orchestratorEffort", "claudeEffort", "codexEffort", "geminiEffort"]) delete oldSettings[key];

const modelMetadata = {
  claude: [
    { id: "opus", label: "Claude Opus", isDefault: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "xhigh" },
    { id: "limited", label: "Claude Limited", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" },
  ],
  codex: [
    { id: "gpt-6-astra", label: "GPT Astra", reasoningEfforts: ["medium", "high", "xhigh"], defaultReasoningEffort: "high" },
    { id: "gpt-5-limited", label: "GPT Limited", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "high" },
  ],
  gemini: [
    { id: "gemini-pro", label: "Gemini Pro", isDefault: true, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high" },
  ],
};

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "추론 수준 UI",
      workspace,
      JSON.stringify(settings),
      now,
    );
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      2,
      "이전 기록 UI",
      workspace,
      JSON.stringify(oldSettings),
      now,
    );
    db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, ?, ?, 'idle', 0, 0, ?, ?)",
    ).run(1, 1, "추론 배지 기록", now, now + 1);
    db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, ?, ?, 'idle', 0, 0, ?, ?)",
    ).run(2, 2, "이전 협의 기록", now, now + 2);

    const insertEvent = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const event = (id, chatId, node, role, payload) => insertEvent.run(id, chatId, node, role, now + id, payload.type, JSON.stringify(payload));
    event(1, 1, "orch", "orch", { type: "text", text: "실제 적용된 추론 수준을 표시합니다." });
    event(2, 1, "orch", "orch", { type: "consult_start", consultId: 101, kind: "opinion", from: "orch", to: "w1", request: "실제 수준을 확인해 주세요.", attachments: [], reason: "UI 확인" });
    event(3, 1, "consult:101", "w1", { type: "text", text: "xhigh로 처리했습니다." });
    event(4, 1, "orch", "orch", { type: "consult_end", consultId: 101, status: "done", summary: "완료", files: [] });
    event(5, 2, "orch", "orch", { type: "text", text: "이전 버전의 협의 기록입니다." });
    event(6, 2, "orch", "orch", { type: "consult_start", consultId: 201, kind: "implement", from: "orch", to: "w1", request: "이전 기록", attachments: [] });
    event(7, 2, "orch", "orch", { type: "consult_end", consultId: 201, status: "done", summary: "예전 결과", files: [] });

    db.prepare(
      "INSERT INTO consults (id, chat_id, seq, from_role, to_role, kind, request, requested_effort, effort, response_summary, files_changed_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(101, 1, 1, "orch", "w1", "opinion", "실제 수준을 확인해 주세요.", "auto", "xhigh", "완료", "[]", "done", now + 2, now + 4);
    db.prepare(
      "INSERT INTO consults (id, chat_id, seq, from_role, to_role, kind, request, response_summary, files_changed_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(201, 2, 1, "orch", "w1", "implement", "이전 기록", "예전 결과", "[]", "done", now + 6, now + 7);
  } finally {
    db.close();
  }
}

function persistedProject() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id = 1").get();
    return JSON.parse(row.settings_json);
  } finally {
    db.close();
  }
}

async function stubModels(app) {
  await app.evaluate(({ ipcMain }, lists) => {
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", async (_event, agent) => lists[agent] ?? []);
  }, modelMetadata);
}

async function openSettings(page) {
  const project = page.locator('[data-testid="project-node"]', { hasText: "추론 수준 UI" });
  await project.getByRole("button", { name: "추론 수준 UI 메뉴" }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "프로젝트 설정" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

let app;
let page;
try {
  seedDatabase();
  ({ app, page } = await launch(data));
  await stubModels(app);
  await page.setViewportSize({ width: 1280, height: 900 });

  // A new project keeps the worker-count defaults and no longer exposes a time limit.
  await page.getByLabel("새 프로젝트").first().click();
  const newProjectDialog = page.getByRole("dialog").filter({ hasText: "새 프로젝트" });
  await newProjectDialog.waitFor({ state: "visible" });
  const defaultClaudeWorkers = newProjectDialog.locator("label").filter({ hasText: "동시 클로드 작업자" }).locator("input");
  const defaultGptWorkers = newProjectDialog.locator("label").filter({ hasText: "동시 지피티 작업자" }).locator("input");
  const defaultGeminiWorkers = newProjectDialog.locator("label").filter({ hasText: "동시 제미나이 작업자" }).locator("input");
  check(
    "new projects use the default worker counts",
    (await defaultClaudeWorkers.inputValue()) === "3" && (await defaultGptWorkers.inputValue()) === "3" && (await defaultGeminiWorkers.inputValue()) === "1",
  );
  check(
    "project settings have no time-limit field and explain manual stopping",
    (await newProjectDialog.locator("label").filter({ hasText: "지시당 시간" }).count()) === 0 &&
      (await newProjectDialog.getByText("작업 시간은 무제한입니다. 필요하면 중지 버튼으로 멈출 수 있습니다.", { exact: true }).count()) === 1,
  );
  await newProjectDialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  // Project defaults and metadata-driven option filtering.
  let dialog = await openSettings(page);
  await page.waitForFunction(() => document.querySelector('[aria-label="마스터 추론 수준"]')?.getAttribute("data-effort") === "xhigh");
  check("project master defaults to xhigh", (await dialog.getByLabel("마스터 추론 수준").textContent())?.includes("xhigh"));
  check("project workers default to automatic assignment", (await dialog.getByLabel("Claude 작업자 추론 수준").textContent())?.includes("자동 배정") && (await dialog.getByLabel("GPT 작업자 추론 수준").textContent())?.includes("자동 배정"));

  const masterModelPicker = dialog.getByLabel("마스터 모델");
  await masterModelPicker.click();
  await page.getByRole("menuitem", { name: /Claude Limited/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="마스터 추론 수준"]')?.getAttribute("data-effort") === "");
  check("master model change falls back when xhigh is unsupported", (await dialog.getByLabel("마스터 추론 수준").textContent())?.includes("CLI 기본값"));
  await masterModelPicker.click();
  await page.getByRole("menuitem", { name: /Claude Opus/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="마스터 추론 수준"]')?.getAttribute("data-effort") === "xhigh");
  check("master model change restores xhigh when supported", (await dialog.getByLabel("마스터 추론 수준").textContent())?.includes("xhigh"));

  const codexModelPicker = dialog.getByLabel("GPT 모델");
  await codexModelPicker.click();
  await page.getByRole("menuitem", { name: /GPT Limited/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="GPT 작업자 추론 수준"]')?.getAttribute("data-effort") === "auto");
  check("worker model change resets to automatic assignment", (await dialog.getByLabel("GPT 작업자 추론 수준").textContent())?.includes("자동 배정"));
  await codexModelPicker.click();
  await page.getByRole("menuitem", { name: /GPT Astra/ }).click();

  const codexEffort = dialog.getByLabel("GPT 작업자 추론 수준");
  await codexEffort.click();
  const codexMenuText = await page.getByRole("menu").textContent();
  check("worker menu excludes low when metadata does not allow it", !codexMenuText?.includes("low") && codexMenuText?.includes("medium") && codexMenuText.includes("high") && codexMenuText.includes("xhigh"), codexMenuText);
  await page.getByRole("menuitem", { name: "high", exact: true }).click();
  const geminiPicker = dialog.getByLabel("Gemini 모델");
  check("empty Gemini model uses the metadata default", (await geminiPicker.textContent())?.includes("Pro 자동 선택"));
  const geminiEffort = dialog.getByLabel("Gemini 작업자 추론 수준");
  await geminiEffort.click();
  const geminiMenuText = await page.getByRole("menu").textContent();
  check("Gemini worker keeps low out of the manual levels", geminiMenuText?.includes("자동 배정") && geminiMenuText.includes("medium") && geminiMenuText.includes("high") && !geminiMenuText.includes("low"), geminiMenuText);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  check("project effort changes persist", persistedProject().codexEffort === "high", JSON.stringify(persistedProject()));

  await app.close();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 500));
  ({ app, page } = await launch(data));
  await stubModels(app);
  await page.setViewportSize({ width: 1280, height: 900 });
  dialog = await openSettings(page);
  await page.waitForFunction(() => document.querySelector('[aria-label="GPT 작업자 추론 수준"]')?.getAttribute("data-effort") === "high");
  check("saved project effort reloads after restart", (await dialog.getByLabel("GPT 작업자 추론 수준").textContent())?.includes("high"));
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  // Chat-level override and a distinct inheritance reset.
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="consult-card"]');
  const chatClaudeEffort = page.getByLabel("이 채팅의 Claude 추론 수준");
  check("chat header keeps the inherited worker effort visible", (await chatClaudeEffort.textContent())?.includes("자동 배정"));
  await chatClaudeEffort.click();
  await page.getByRole("menuitem", { name: "high", exact: true }).click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1)?.claudeEffortOverride === "high");
  check("chat effort override saves independently", (await page.evaluate(() => window.chatterbox.listChats())).find((chat) => chat.id === 1)?.claudeEffortOverride === "high");
  await chatClaudeEffort.click();
  const reset = page.getByRole("menuitem", { name: /프로젝트 값 사용/ });
  check("chat effort reset is a separate action", (await reset.count()) === 1);
  await reset.click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1)?.claudeEffortOverride === null);

  await page.evaluate(async () => {
    await window.chatterbox.updateChat(1, { claudeModelOverride: "unknown-claude-model", claudeEffortOverride: "xhigh" });
  });
  await page.waitForFunction(() => document.querySelector('[aria-label="이 채팅의 Claude 모델"]')?.textContent?.includes("unknown-claude-model"));
  await page.waitForFunction(() => document.querySelector('[aria-label="이 채팅의 Claude 추론 수준"]')?.getAttribute("data-effort") === "xhigh");
  check(
    "unsupported saved effort remains visible while model metadata is unavailable",
    (await chatClaudeEffort.textContent())?.includes("xhigh") && (await chatClaudeEffort.getAttribute("title"))?.includes("지원"),
    await chatClaudeEffort.getAttribute("title"),
  );
  await chatClaudeEffort.click();
  const unknownMenuText = await page.getByRole("menu").textContent();
  check("unknown models expose no manual effort levels", unknownMenuText?.includes("자동 배정") && !/\b(?:low|medium|high|xhigh)\b/.test(unknownMenuText), unknownMenuText);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    await window.chatterbox.updateChat(1, { claudeModelOverride: null, claudeEffortOverride: null });
  });

  // Actual consult level is shown only when Consult.effort exists, with the request as a tooltip.
  const badge = page.locator('[data-testid="consult-effort"][data-effort="xhigh"]');
  check("consult card shows the actual applied effort", (await badge.count()) === 1 && (await badge.textContent())?.includes("xhigh"));
  check("different requested effort is available as a tooltip", (await badge.getAttribute("title")) === "마스터 요청: auto");

  // Old records keep rendering without a fabricated actual effort badge.
  await page.locator('[data-testid="chat-node"][data-chat-id="2"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="consult-card"]');
  check("old consult history has no fabricated effort badge", (await page.locator('[data-testid="consult-effort"]').count()) === 0);
  check("old settings receive safe display defaults", (await page.getByLabel("이 채팅의 마스터 추론 수준").textContent())?.includes("xhigh"));

  // A narrow header must remain usable with the controls wrapping inside its bounds.
  await page.setViewportSize({ width: 760, height: 900 });
  const headerLayout = await page.locator("header").evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, controls: el.querySelectorAll('[data-testid="effort-picker"]').length }));
  check("responsive header keeps all effort controls inside its width", headerLayout.controls === 4 && headerLayout.scrollWidth <= headerLayout.clientWidth + 1, JSON.stringify(headerLayout));
  await page.screenshot({ path: join(screenshots, "effort-ui.png"), fullPage: true });
  check("effort UI screenshot is kept in scratch", existsSync(join(screenshots, "effort-ui.png")));
} catch (error) {
  console.error(error);
  check("reasoning effort UI verification completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Scratch data and screenshots: ${base}`);
finish();

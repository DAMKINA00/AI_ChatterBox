// Settings dialog + worker history UI verification against the built app.
// Usage: node scripts/e2e-settings-workers.mjs
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "ui-verification", String(Date.now()));
const data = join(base, "data");
const screenshots = join(base, "screenshots");
const workspace = join(base, "workspace");
const missingFolder = join(base, "missing-folder-for-save");
const dbFile = join(data, "chatterbox.db");
mkdirSync(workspace, { recursive: true });
mkdirSync(screenshots, { recursive: true });

const settings = {
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "UI 상태 점검",
      workspace,
      JSON.stringify(settings),
      now,
    );
    db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, ?, ?, 'idle', 0, 0, ?, ?)",
    ).run(1, 1, "작업자 기록 확인", now, now + 1);
    db.prepare(
      "INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, ?, ?, 'idle', 0, 0, ?, ?)",
    ).run(2, 1, "작업자 없는 채팅", now, now);

    const insertAgent = db.prepare(
      "INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let id = 1; id <= 12; id++) {
      const kind = id % 2 === 1 ? "claude" : "gpt";
      const number = Math.ceil(id / 2);
      const nickname = `${kind === "claude" ? "클로드" : "지피티"} ${number}호`;
      const status = id <= 8 ? "active" : "released";
      insertAgent.run(id, kind, number, nickname, id <= 8 ? "활성 작업" : "이전 작업", `${kind}-session-${id}`, status, now + id);
    }

    const insertEvent = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, ?, ?, ?, ?, ?)");
    const event = (id, node, role, type, payload) => insertEvent.run(id, node, role, now + id, type, JSON.stringify(payload));
    event(1, "orch", "orch", "text", { type: "text", text: "작업자 기록과 표정을 확인하는 대화입니다." });
    event(2, "w1", "w1", "expression", { type: "expression", expression: "happy" });
    event(3, "w1", "w1", "text", { type: "text", text: "활성 작업자의 메시지입니다." });
    event(4, "w1", "w1", "turn_end", { type: "turn_end", ok: true });
    event(5, "w9", "w9", "expression", { type: "expression", expression: "thinking" });
    event(6, "w9", "w9", "text", { type: "text", text: "해제된 작업자의 이전 기록입니다." });
    event(7, "w9", "w9", "turn_end", { type: "turn_end", ok: true });
  } finally {
    db.close();
  }
}

function projectNode(page, name) {
  return page.locator('[data-testid="project-node"]', { hasText: name });
}

async function openSettings(page, name) {
  const node = projectNode(page, name);
  await node.getByRole("button", { name: `${name} 메뉴` }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "프로젝트 설정" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function setSwitch(locator, value) {
  if ((await locator.getAttribute("aria-checked")) !== String(value)) await locator.click();
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

let app;
let page;
try {
  seedDatabase();
  ({ app, page } = await launch(data));

  // Open the seeded worker chat and verify the active/released team presentation.
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-chip"]').length === 12);
  const chips = page.locator('[data-testid="team-chip"]');
  const roles = await chips.evaluateAll((els) => els.map((el) => el.getAttribute("data-role")));
  check("active workers precede released workers", roles.slice(0, 8).every((r) => /^w[1-8]$/.test(r)) && roles.slice(8).every((r) => /^w(?:9|10|11|12)$/.test(r)), roles.join(", "));
  check("released workers are grouped at the trailing edge", (await page.locator('[data-testid="released-workers"] [data-testid="team-chip"]').count()) === 4);
  check(
    "released worker chips use the gray treatment",
    await page.locator('[data-testid="released-workers"] [data-testid="team-chip"]').evaluateAll((els) => els.every((el) => el.className.includes("grayscale"))),
  );
  check(
    "worker chips overflow horizontally when the team is large",
    await page.locator('[data-testid="team-chips"] > div:not([data-testid="agent-usage-list"])').evaluate((el) => el.scrollWidth > el.clientWidth),
  );

  // Expression metadata reaches messages and the role avatars.
  check(
    "expression data is rendered on the active worker message and avatar",
    (await page.locator('[data-testid="agent-message"][data-role="w1"][data-expression="happy"]').count()) === 1 &&
      (await page.locator('[data-testid="agent-message"][data-role="w1"] [data-testid="agent-avatar"][data-expression="happy"]').count()) === 1,
  );
  check("role avatars render for the worker team", (await page.locator('[data-testid="team-chip"] [data-testid="agent-avatar"]').count()) === 12);

  // A chat with no agents must not show an empty team strip.
  await page.locator('[data-testid="chat-node"][data-chat-id="2"] [role="treeitem"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="timeline"]') && !document.querySelector('[data-testid="team-chips"]'));
  check("team strip is hidden when the chat has no workers", (await page.locator('[data-testid="team-chips"]').count()) === 0);

  // Return to the worker chat and open a released worker's history.
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="team-chips"]');
  const released = page.locator('[data-testid="released-workers"] [data-testid="team-chip"]').first();
  await released.click();
  await page.waitForFunction(() => document.querySelector("header")?.textContent?.includes("클로드 5호"));
  check(
    "clicking a released worker opens its history",
    (await page.locator('[data-testid="agent-message"][data-role="w9"]').count()) === 1 &&
      (await page.locator('[data-testid="agent-message"][data-role="w9"]').textContent()).includes("해제된 작업자의 이전 기록"),
  );

  // Settings dialog: repeated switch toggles must not submit or close it.
  let dialog = await openSettings(page, "UI 상태 점검");
  const highRisk = dialog.getByRole("switch", { name: "고위험 요청도 맡기기" });
  const reviewGate = dialog.getByRole("switch", { name: "교차 리뷰" });
  const originalName = await dialog.locator("#proj-name").inputValue();
  const originalFolder = await dialog.locator("#proj-folder").inputValue();
  const originalHighRisk = await highRisk.getAttribute("aria-checked");
  const originalReviewGate = await reviewGate.getAttribute("aria-checked");
  for (let i = 0; i < 3; i++) {
    await highRisk.click();
    await reviewGate.click();
    check(`repeated switch toggle ${i + 1} keeps settings dialog open`, await dialog.isVisible());
  }
  await dialog.locator("#proj-name").fill("취소하면 사라질 입력");
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const afterCancel = persistedProject();
  check("cancel leaves project values unchanged", afterCancel.name === originalName && afterCancel.folder === originalFolder && String(afterCancel.settings.delegateHighRisk) === originalHighRisk && String(afterCancel.settings.reviewGate) === originalReviewGate);

  // Save both switch values and the project name, then verify the persisted record.
  dialog = await openSettings(page, "UI 상태 점검");
  await dialog.locator("#proj-name").fill("UI 저장 완료");
  await setSwitch(dialog.getByRole("switch", { name: "고위험 요청도 맡기기" }), true);
  await setSwitch(dialog.getByRole("switch", { name: "교차 리뷰" }), false);
  await dialog.getByRole("button", { name: "저장" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const saved = persistedProject();
  check("settings save persists name and switch values", saved.name === "UI 저장 완료" && saved.settings.delegateHighRisk === true && saved.settings.reviewGate === false);

  // A bad folder must keep the dialog and all edited inputs open after the error.
  dialog = await openSettings(page, "UI 저장 완료");
  const invalidName = "실패해도 입력 유지";
  await dialog.locator("#proj-name").fill(invalidName);
  await dialog.locator("#proj-folder").fill(missingFolder);
  await dialog.getByRole("button", { name: "저장" }).click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent?.trim() === "저장");
    return !!button && !(button instanceof HTMLButtonElement && button.disabled);
  });
  await page.waitForTimeout(250);
  const failedDialogVisible = await dialog.isVisible();
  const failedNameValue = await dialog.locator("#proj-name").inputValue();
  const failedFolderValue = await dialog.locator("#proj-folder").inputValue();
  check(
    "invalid folder keeps the settings dialog and edited inputs",
    failedDialogVisible && failedNameValue === invalidName && failedFolderValue === missingFolder,
    `visible=${failedDialogVisible}; name=${failedNameValue}; folder=${failedFolderValue}`,
  );
  const directError = await page.evaluate(async (folder) => {
    try {
      await window.chatterbox.updateProject(1, { folder });
      return "";
    } catch (e) {
      return String(e);
    }
  }, missingFolder);
  check("invalid folder is rejected by the project API", directError.includes("작업 폴더가 없습니다."), directError);
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  check("failed save did not overwrite the stored project", persistedProject().name === "UI 저장 완료" && persistedProject().folder === workspace);

  // Capture the worker UI in both supported themes.
  await page.screenshot({ path: join(screenshots, "workers-dark.png"), fullPage: true });
  await page.getByLabel("테마 전환").click();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.screenshot({ path: join(screenshots, "workers-light.png"), fullPage: true });
  check("dark and light verification screenshots were written", existsSync(join(screenshots, "workers-dark.png")) && existsSync(join(screenshots, "workers-light.png")));

  await app.close();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  ({ app, page } = await launch(data));
  await page.waitForFunction(() => document.querySelector('[data-testid="sidebar"]'));
  const restarted = await page.evaluate(() => window.chatterbox.listProjects());
  const restartedProject = restarted.find((p) => p.id === 1);
  check("saved project settings survive restart", restartedProject?.name === "UI 저장 완료" && restartedProject.settings.delegateHighRisk === true && restartedProject.settings.reviewGate === false);
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="team-chips"]');
  check("worker team history is available after restart", (await page.locator('[data-testid="team-chip"]').count()) === 12);
} catch (error) {
  console.error(error);
  check("GUI test run completed", false, error instanceof Error ? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Screenshots: ${screenshots}`);
finish();

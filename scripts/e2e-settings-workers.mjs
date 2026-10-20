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

async function fillProjectName(dialog, value) {
  const input = dialog.locator("#proj-name");
  await input.scrollIntoViewIfNeeded();
  await input.fill(value);
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
  const settingsLayout = await dialog.evaluate((dialogNode) => {
    const workerGrid = [...dialogNode.querySelectorAll("div")].find((el) => el.children.length === 4 && el.querySelector('textarea[aria-label="제미나이 작업자 주의점"]'));
    const textareas = [...dialogNode.querySelectorAll("textarea")];
    const dialogRect = dialogNode.getBoundingClientRect();
    const gridRect = workerGrid?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      dialogWidth: dialogRect.width,
      dialogClientWidth: dialogNode.clientWidth,
      dialogScrollWidth: dialogNode.scrollWidth,
      workerGridColumns: workerGrid ? getComputedStyle(workerGrid).gridTemplateColumns : null,
      workerGridClientWidth: workerGrid?.clientWidth ?? null,
      workerGridScrollWidth: workerGrid?.scrollWidth ?? null,
      workerGridRenderedWidth: gridRect?.width ?? null,
      textareaResize: textareas.map((textarea) => getComputedStyle(textarea).resize),
    };
  });
  console.log(`SETTINGS_LAYOUT  ${JSON.stringify(settingsLayout)}`);
  const expectedDialogWidth = Math.min(1000, settingsLayout.viewportWidth - 40);
  check(
    "settings dialog uses the available width without horizontal worker-card overflow",
    settingsLayout.dialogWidth >= expectedDialogWidth - 2 && settingsLayout.dialogScrollWidth <= settingsLayout.dialogClientWidth + 1 && settingsLayout.workerGridScrollWidth <= (settingsLayout.workerGridClientWidth ?? 0) + 1,
    JSON.stringify(settingsLayout),
  );
  check("settings textareas disable the native resize handle", settingsLayout.textareaResize.length === 10 && settingsLayout.textareaResize.every((resize) => resize === "none"), JSON.stringify(settingsLayout.textareaResize));
  await page.screenshot({ path: join(screenshots, "settings-dark.png") });
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const themeToggle = page.getByLabel("테마 전환");
  await themeToggle.click();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  dialog = await openSettings(page, "UI 상태 점검");
  await page.screenshot({ path: join(screenshots, "settings-light.png") });
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  await themeToggle.click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  check("dark and light settings screenshots were written", existsSync(join(screenshots, "settings-dark.png")) && existsSync(join(screenshots, "settings-light.png")));
  // Approval has exactly three presets and repeated toggles stay local.
  dialog = await openSettings(page, "UI 상태 점검");
  const reviewGate = dialog.getByRole("switch", { name: "교차 리뷰" });
  const approvalGroup = dialog.getByRole("radiogroup", { name: "승인 방식" });
  const fullApproval = approvalGroup.getByRole("radio", { name: "전체 위험 승인", exact: true });
  const orchestratorApproval = approvalGroup.getByRole("radio", { name: "마스터 자동 승인", exact: true });
  const userApproval = approvalGroup.getByRole("radio", { name: "관리자 직접 승인", exact: true });
  const approvalHelp = {
    "전체 위험 승인": "고위험도 마스터에게 위임합니다. 명시적 거부, 작업 범위, 계획 모드 제한은 유지합니다.",
    "마스터 자동 승인": "마스터가 판단하고, 고위험하거나 불확실한 요청은 관리자에게 확인합니다.",
    "관리자 직접 승인": "작업자가 파일을 고치거나 명령을 실행할 때마다 관리자가 직접 승인합니다.",
  };
  const approvalPresets = [
    [fullApproval, "전체 위험 승인"],
    [orchestratorApproval, "마스터 자동 승인"],
    [userApproval, "관리자 직접 승인"],
  ];
  const oldHighRiskSwitchCount = await dialog.getByRole("switch", { name: "고위험 요청도 맡기기", exact: true }).count();
  const originalName = await dialog.locator("#proj-name").inputValue();
  const originalFolder = await dialog.locator("#proj-folder").inputValue();
  const originalSettings = persistedProject().settings;
  const originalApprovalMode = originalSettings.approvalMode;
  const originalDelegateHighRisk = originalSettings.delegateHighRisk;
  const originalReviewGate = await reviewGate.getAttribute("aria-checked");
  check(
    "approval exposes three presets without the old high-risk switch",
    oldHighRiskSwitchCount === 0 && (await fullApproval.count()) === 1 && (await orchestratorApproval.count()) === 1 && (await userApproval.count()) === 1,
    JSON.stringify({ oldHighRiskSwitchCount }),
  );
  for (const [preset, label] of approvalPresets) {
    await preset.click();
    check(`approval preset ${label} shows its help`, (await preset.getAttribute("aria-checked")) === "true" && (await dialog.getByText(approvalHelp[label], { exact: true }).count()) === 1);
    await reviewGate.click();
    check(`approval preset ${label} keeps settings dialog open`, await dialog.isVisible());
  }
  const settingsViewport = await dialog.locator("#proj-name").evaluate((input) => {
    const dialogNode = input.closest('[role="dialog"]');
    const inputRect = input.getBoundingClientRect();
    const dialogRect = dialogNode?.getBoundingClientRect();
    const style = dialogNode ? getComputedStyle(dialogNode) : undefined;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      input: { top: inputRect.top, bottom: inputRect.bottom, left: inputRect.left, right: inputRect.right, width: inputRect.width, height: inputRect.height },
      dialog: dialogRect ? { top: dialogRect.top, bottom: dialogRect.bottom, left: dialogRect.left, right: dialogRect.right, clientHeight: dialogNode.clientHeight, scrollHeight: dialogNode.scrollHeight, scrollTop: dialogNode.scrollTop } : null,
      overflowY: style?.overflowY ?? null,
      inputInViewport: inputRect.top >= 0 && inputRect.bottom <= window.innerHeight && inputRect.left >= 0 && inputRect.right <= window.innerWidth,
      inputInDialogViewport: !!dialogRect && inputRect.top >= dialogRect.top && inputRect.bottom <= dialogRect.bottom,
    };
  });
  console.log(`SETTINGS_VIEWPORT  ${JSON.stringify(settingsViewport)}`);
  await page.screenshot({ path: join(screenshots, "settings-after-toggles.png") });
  await fillProjectName(dialog, "취소하면 사라질 입력");
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const afterCancel = persistedProject();
  check(
    "cancel leaves project values unchanged",
    afterCancel.name === originalName &&
      afterCancel.folder === originalFolder &&
      afterCancel.settings.approvalMode === originalApprovalMode &&
      afterCancel.settings.delegateHighRisk === originalDelegateHighRisk &&
      String(afterCancel.settings.reviewGate) === originalReviewGate,
  );

  // Save the full-risk preset and review switch, then verify the persisted record.
  dialog = await openSettings(page, "UI 상태 점검");
  await fillProjectName(dialog, "UI 저장 완료");
  await dialog.getByRole("radiogroup", { name: "승인 방식" }).getByRole("radio", { name: "전체 위험 승인", exact: true }).click();
  await setSwitch(dialog.getByRole("switch", { name: "교차 리뷰" }), false);
  await dialog.getByRole("button", { name: "저장" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const saved = persistedProject();
  check(
    "settings save persists approval preset and review switch",
    saved.name === "UI 저장 완료" && saved.settings.approvalMode === "orchestrator-all" && saved.settings.delegateHighRisk === true && saved.settings.reviewGate === false,
    JSON.stringify(saved.settings),
  );

  // A bad folder must keep the dialog and all edited inputs open after the error.
  dialog = await openSettings(page, "UI 저장 완료");
  const invalidName = "실패해도 입력 유지";
  await fillProjectName(dialog, invalidName);
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
  check(
    "saved project settings survive restart",
    restartedProject?.name === "UI 저장 완료" && restartedProject.settings.approvalMode === "orchestrator-all" && restartedProject.settings.delegateHighRisk === true && restartedProject.settings.reviewGate === false,
    JSON.stringify(restartedProject?.settings),
  );
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

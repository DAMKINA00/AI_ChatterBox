// Isolated chat-header layout regression; model and auth IPC are mocked and no agent runs.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "header-layout", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const title = "읽을 수 있어야 하는 긴 채팅 제목입니다. 프로젝트 경로와 모든 설정 행이 제목을 잘라내지 않고 함께 표시되는지 확인합니다.";
mkdirSync(data, { recursive: true });
mkdirSync(workspace, { recursive: true });

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  const db = new DatabaseSync(join(data, "chatterbox.db"));
  const now = Date.now();
  try {
    db.exec(schema);
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)").run(
      "Header layout",
      workspace,
      JSON.stringify({
        orchestratorModel: "claude:header-master",
        claudeModel: "claude-worker",
        codexModel: "codex-worker",
        geminiModel: "gemini-worker",
        grokModel: "grok-worker",
        orchestratorEffort: "xhigh",
        claudeEffort: "auto",
        codexEffort: "auto",
        geminiEffort: "auto",
        grokEffort: "auto",
        approvalMode: "orchestrator",
      }),
      now,
    );
    db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (1, 1, ?, 'idle', 0, 0, ?, ?)").run(title, now, now);
  } finally {
    db.close();
  }
}

async function isolate(app) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini", "grok", "deepseek"].map((agent) => ({ agent, path: agent === "deepseek" ? "DeepSeek API" : "mock-cli.exe", authStatus: "authenticated" })));
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, agent) => [{
      id: { claude: "claude-worker", codex: "codex-worker", gemini: "gemini-worker", grok: "grok-worker", deepseek: "deepseek-flash" }[agent],
      label: `${agent} header model`,
      isDefault: true,
      reasoningEfforts: ["medium", "high", "xhigh"],
    }, {
      id: `${agent}-alternate`,
      label: `${agent} alternate model`,
      reasoningEfforts: ["medium", "high"],
    }]);
  });
}

async function openChat(page) {
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.getByTestId("chat-header-title-row").waitFor();
  await page.getByLabel("이 채팅의 그록 모델", { exact: true }).waitFor();
}

async function savedChat(page) {
  return page.evaluate(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1));
}

function sameRow(a, b) {
  return a && b && Math.abs(a.y - b.y) <= 2;
}

let app, page;
try {
  seedDatabase();
  ({ app, page } = await launch(data));
  await isolate(app);
  await page.reload();
  await page.setViewportSize({ width: 1420, height: 1000 });
  await openChat(page);

  const titleRow = page.getByTestId("chat-header-title-row");
  const masterRow = page.getByTestId("chat-header-master-row");
  const agentsRow = page.getByTestId("chat-header-agents-row");
  check("header exposes exactly three logical rows", await page.locator('[data-testid^="chat-header-"]').count() === 3);
  const titleBox = await titleRow.boundingBox();
  const masterBox = await masterRow.boundingBox();
  const agentsBox = await agentsRow.boundingBox();
  check("header rows are full-width and ordered", titleBox && masterBox && agentsBox && Math.abs(titleBox.width - masterBox.width) <= 1 && Math.abs(masterBox.width - agentsBox.width) <= 1 && titleBox.y < masterBox.y && masterBox.y < agentsBox.y);

  const titleState = await page.getByTestId("chat-title").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      text: element.textContent,
      textOverflow: style.textOverflow,
      overflow: style.overflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  check("long chat title remains readable without ellipsis", titleState.text === title && titleState.textOverflow !== "ellipsis" && titleState.overflow !== "hidden" && titleState.whiteSpace !== "nowrap" && titleState.scrollWidth <= titleState.clientWidth, JSON.stringify(titleState));

  const providers = agentsRow.locator('[data-testid="provider-controls"]');
  check("third row has all five providers in order", await providers.count() === 5 && JSON.stringify(await providers.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-provider")))) === JSON.stringify(["claude", "codex", "gemini", "grok", "deepseek"]));
  const master = masterRow.getByTestId("orch-badge");
  const approval = masterRow.getByLabel("이 채팅의 승인 방식", { exact: true });
  const masterControlBox = await master.boundingBox();
  const approvalBox = await approval.boundingBox();
  check("approval mode sits beside the master controls", sameRow(masterControlBox, approvalBox) && approvalBox.x >= masterControlBox.x + masterControlBox.width - 1);

  await page.screenshot({ path: join(base, "header-wide.png"), fullPage: true });

  await page.getByLabel("이 채팅의 마스터 모델", { exact: true }).click();
  await page.getByRole("menuitem", { name: /grok header model/ }).click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1)?.orchestratorModelOverride === "grok:grok-worker");
  check("master model change remains functional", (await savedChat(page))?.orchestratorModelOverride === "grok:grok-worker");

  await approval.click();
  check("approval menu offers all three named modes", await page.getByRole("menuitem", { name: "전체 위험 승인", exact: true }).count() === 1
    && await page.getByRole("menuitem", { name: "마스터 자동 승인", exact: true }).count() === 1
    && await page.getByRole("menuitem", { name: "관리자 직접 승인", exact: true }).count() === 1);
  await page.screenshot({ path: join(base, "approval-menu.png"), fullPage: true });
  await page.getByRole("menuitem", { name: "전체 위험 승인", exact: true }).click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1)?.approvalModeOverride === "orchestrator-all");
  check("full-risk mode is saved for this chat", (await savedChat(page))?.approvalModeOverride === "orchestrator-all");
  await approval.click();
  await page.getByRole("menuitem", { name: "관리자 직접 승인", exact: true }).click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).find((chat) => chat.id === 1)?.approvalModeOverride === "user");
  check("approval mode change remains functional", (await savedChat(page))?.approvalModeOverride === "user");

  await page.setViewportSize({ width: 900, height: 800 });
  const narrowTitleRow = page.getByTestId("chat-header-title-row");
  const narrowMasterRow = page.getByTestId("chat-header-master-row");
  const narrowAgentsRow = page.getByTestId("chat-header-agents-row");
  check("narrow window keeps rows full-width and avoids document overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check("narrow window keeps provider controls in one horizontally scrollable row", await narrowAgentsRow.evaluate((element) => element.scrollWidth > element.clientWidth && element.querySelectorAll('[data-testid="provider-controls"]').length === 5));
  check("narrow window keeps master and approval in one row", await narrowMasterRow.evaluate((element) => element.scrollWidth >= element.clientWidth && !!element.querySelector('[data-testid="orch-badge"]') && !!element.querySelector('[aria-label="이 채팅의 승인 방식"]')));
  const narrowTitleState = await page.getByTestId("chat-title").evaluate((element) => ({ text: element.textContent, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, height: element.getBoundingClientRect().height }));
  check("narrow window still shows the complete wrapped title", narrowTitleState.text === title && narrowTitleState.scrollWidth <= narrowTitleState.clientWidth && narrowTitleState.height > 0, JSON.stringify(narrowTitleState));
  check("narrow rows remain vertically ordered", (await narrowTitleRow.boundingBox())?.y < (await narrowMasterRow.boundingBox())?.y && (await narrowMasterRow.boundingBox())?.y < (await narrowAgentsRow.boundingBox())?.y);
  await page.screenshot({ path: join(base, "header-narrow.png"), fullPage: true });
} catch (error) {
  check("header layout e2e completes", false, error instanceof Error ? error.stack ?? error.message : String(error));
  await page?.screenshot({ path: join(base, "failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Artifacts: ${base}`);
finish();

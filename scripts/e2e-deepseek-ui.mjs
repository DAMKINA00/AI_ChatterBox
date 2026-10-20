// DeepSeek renderer flow with a mocked IPC API. No network or paid completion is allowed.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "deepseek-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");
mkdirSync(workspace, { recursive: true });

function storedDeepSeekValue() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM settings WHERE key = ?").get("deepseekApiKey")?.value;
  } finally {
    db.close();
  }
}

const settings = {
  claudeStrengths: "",
  claudeCautions: "",
  gptStrengths: "",
  gptCautions: "",
  geminiStrengths: "",
  geminiCautions: "",
  grokStrengths: "",
  grokCautions: "",
  deepseekStrengths: "분석",
  deepseekCautions: "API 비용 확인",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  geminiModel: "",
  grokModel: "",
  deepseekModel: "deepseek-flash",
  orchestratorEffort: "xhigh",
  claudeEffort: "auto",
  codexEffort: "auto",
  geminiEffort: "auto",
  grokEffort: "auto",
  deepseekEffort: "auto",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  maxGeminiWorkers: 1,
  maxGrokWorkers: 3,
  maxDeepseekWorkers: 3,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

let app;
try {
  ({ app } = await launch(data));
  const page = await app.firstWindow();

  const fixtureKey = "sk-test-main-transport-fixture-9x7k";
  const savedStatus = await page.evaluate(async (apiKey) => window.chatterbox.deepSeek("save", { apiKey }), fixtureKey);
  const actualStatus = await page.evaluate(() => window.chatterbox.deepSeek("status"));
  check("real DeepSeek IPC saves a key without returning it", savedStatus.apiKeySet && actualStatus.apiKeySet && !JSON.stringify(savedStatus).includes(fixtureKey) && !JSON.stringify(actualStatus).includes(fixtureKey));
  const storedValue = storedDeepSeekValue();
  check("real DeepSeek IPC stores ciphertext rather than the fixture", typeof storedValue === "string" && storedValue.length > 0 && storedValue !== fixtureKey && !storedValue.includes(fixtureKey));
  const removedStatus = await page.evaluate(() => window.chatterbox.deepSeek("remove"));
  check("real DeepSeek IPC removes the saved key", !removedStatus.apiKeySet);

  await app.evaluate(({ ipcMain }) => {
    const state = globalThis.__deepseekUi = { apiKeySet: false, models: [], calls: [], paidCalls: 0 };
    const status = (stateOverride = {}) => ({
      apiKeySet: state.apiKeySet,
      state: stateOverride.state ?? (state.apiKeySet ? "configured" : "unconfigured"),
      models: state.models,
      ...(stateOverride.state === "ready" ? { checkedAt: Date.now() } : {}),
    });
    ipcMain.removeHandler("deepseek");
    ipcMain.handle("deepseek", (_event, action, input) => {
      state.calls.push({ action, hasInput: input !== undefined, hasApiKey: !!input?.apiKey });
      if (action === "save") {
        if (input?.apiKey) state.apiKeySet = true;
        return status();
      }
      if (action === "check") {
        if (input !== undefined) throw new Error("check must use the saved key");
        state.models = ["deepseek-flash", "deepseek-v4-pro"];
        return status({ state: "ready" });
      }
      if (action === "remove") {
        state.apiKeySet = false;
        state.models = [];
        return status();
      }
      if (action === "completion") state.paidCalls++;
      return status();
    });
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, provider) => ({
      claude: [{ id: "opus", label: "Claude Opus", reasoningEfforts: ["xhigh"] }],
      codex: [{ id: "gpt-6-astra", label: "GPT-6 Astra", reasoningEfforts: ["xhigh"] }],
      gemini: [{ id: "gemini-4-pro", label: "Gemini Pro", reasoningEfforts: ["high"] }],
      grok: [{ id: "grok-4", label: "Grok 4", reasoningEfforts: ["high"] }],
      deepseek: [
        { id: "deepseek-flash", label: "DeepSeek Flash", isDefault: true, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
      ],
    }[provider] ?? []));
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => [
      { agent: "claude", path: "C:\\mock\\claude.exe", authStatus: "authenticated" },
      { agent: "codex", path: "C:\\mock\\codex.exe", authStatus: "authenticated" },
      { agent: "gemini", path: "C:\\mock\\gemini.exe", authStatus: "authenticated" },
      { agent: "grok", path: "C:\\mock\\grok.exe", authStatus: "authenticated" },
      { agent: "deepseek", path: null, error: "DeepSeek API 설정에서 API 키를 저장하세요." },
    ]);
    ipcMain.removeHandler("usage:get");
    ipcMain.handle("usage:get", () => ({}));
    ipcMain.removeHandler("aistudio:usage");
    ipcMain.handle("aistudio:usage", () => ({ from: new Date().toISOString(), to: new Date().toISOString(), generatedAt: new Date().toISOString(), totals: { requests: 0, succeeded: 0, failed: 0, canceled: 0, rateLimited: 0, inputTokens: 0, cachedTokens: 0, reasoningTokens: 0, replyTokens: 0, totalTokens: 0 }, groups: { account: [], model: [], channel: [] } }));
  });

  const chatId = await page.evaluate(async ({ workspace, settings }) => {
    const project = await window.chatterbox.createProject({ name: "DeepSeek UI 검증", folder: workspace, settings });
    return (await window.chatterbox.createChat(project.id)).id;
  }, { workspace, settings });
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
  await page.getByTestId("deepseek-manage").click();
  const dialog = page.getByRole("dialog").filter({ hasText: "DeepSeek API" });
  await dialog.waitFor();
  await page.screenshot({ path: join(base, "deepseek-dialog.png") });
  check("DeepSeek API settings are exposed from usage", await page.getByTestId("deepseek-manage").count() === 1 && await dialog.getByTestId("deepseek-api-key").getAttribute("type") === "password");
  check("DeepSeek is not reported as a missing CLI", !(await page.getByTestId("cli-warning").count()) || !(await page.getByTestId("cli-warning").innerText()).includes("딥시크"));
  await dialog.getByTestId("deepseek-api-key").fill("sk-test-secret-never-rendered");
  check("entered key is not rendered as dialog text", !(await dialog.innerText()).includes("sk-test-secret-never-rendered"));
  await dialog.getByTestId("deepseek-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-status"]')?.textContent?.includes("키 저장됨"));
  check("saving clears the password field and never returns the key", await dialog.getByTestId("deepseek-api-key").inputValue() === "" && !(await dialog.innerText()).includes("sk-test-secret-never-rendered"));
  await dialog.getByTestId("deepseek-check").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-models"]')?.textContent?.includes("deepseek-v4-pro"));
  const deepseekCalls = await app.evaluate(() => globalThis.__deepseekUi.calls);
  check("model check uses the saved key and lists models", deepseekCalls.some(c => c.action === "check" && !c.hasInput && !c.hasApiKey) && (await dialog.getByTestId("deepseek-models").innerText()).includes("deepseek-flash"));
  await dialog.getByTestId("deepseek-remove").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-status"]')?.textContent?.includes("키 미설정"));
  check("key removal is explicit and leaves no key in the UI", await dialog.getByTestId("deepseek-api-key").inputValue() === "" && !(await dialog.innerText()).includes("sk-test-secret-never-rendered"));
  await dialog.getByText("닫기", { exact: true }).click();

  const chatPicker = page.getByLabel("이 채팅의 딥시크 모델");
  await chatPicker.click();
  check("DeepSeek API settings are exposed from the model picker", await page.getByTestId("deepseek-connect").count() === 1 && (await page.getByRole("menu").innerText()).includes("DeepSeek 모델 (API)"));
  await page.getByRole("menuitem", { name: "DeepSeek API 설정…" }).click();
  const pickerDialog = page.getByRole("dialog").filter({ hasText: "DeepSeek API" });
  await pickerDialog.waitFor();
  await pickerDialog.getByText("닫기", { exact: true }).click();

  const projectNode = page.locator('[data-testid="project-node"]', { hasText: "DeepSeek UI 검증" });
  await projectNode.getByRole("button", { name: "DeepSeek UI 검증 메뉴" }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const settingsDialog = page.getByRole("dialog").filter({ hasText: "프로젝트 설정" });
  await settingsDialog.waitFor();
  check("project settings expose DeepSeek model, role guidance, and worker cap", await settingsDialog.getByLabel("딥시크 모델").count() === 1 && await settingsDialog.getByLabel("딥시크가 잘 맡는 작업").count() === 1 && await settingsDialog.getByLabel("딥시크 작업자 주의점").count() === 1 && await settingsDialog.getByText("동시 딥시크 작업자 (0=사용 안 함)").count() === 1);
  await settingsDialog.getByLabel("딥시크가 잘 맡는 작업").fill("UI 분석");
  await settingsDialog.locator('input[type="number"]').nth(4).fill("2");
  await settingsDialog.getByLabel("딥시크 모델").click();
  await page.getByRole("menuitem", { name: /DeepSeek V4 Pro/ }).click();
  await settingsDialog.getByRole("button", { name: "저장" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  const savedProject = await page.evaluate(() => window.chatterbox.listProjects().then(list => list.find(p => p.name === "DeepSeek UI 검증")));
  check("project DeepSeek settings persist", savedProject?.settings.deepseekModel === "deepseek-v4-pro" && savedProject?.settings.deepseekStrengths === "UI 분석" && savedProject?.settings.maxDeepseekWorkers === 2);

  await chatPicker.click();
  await page.getByRole("menuitem", { name: /DeepSeek Flash/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-header-agents-row"]')?.textContent?.includes("DeepSeek Flash"));
  const savedChat = await page.evaluate((id) => window.chatterbox.listChats().then(list => list.find(chat => chat.id === id)), chatId);
  check("chat DeepSeek model override persists", savedChat?.deepseekModelOverride === "deepseek-flash");
  check("DeepSeek avatar is wired to the character path", await page.locator('[data-testid="agent-avatar"][data-kind="deepseek"]').count() >= 1 && await page.locator('[data-testid="provider-controls"][data-provider="deepseek"][data-state="api"]').count() === 1);
  check("UI flow made no paid completion calls", await app.evaluate(() => globalThis.__deepseekUi.paidCalls === 0));
} catch (error) {
  console.error(error);
  check("DeepSeek UI flow completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}
finish();

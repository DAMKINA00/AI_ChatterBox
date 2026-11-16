// Only fixture IPC responses change; the installed CLI and real user data are untouched.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "antigravity-availability", String(Date.now()));
const data = join(base, "data"), workspace = join(base, "workspace");
mkdirSync(data, { recursive: true }); mkdirSync(workspace, { recursive: true });
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
const now = Date.now();
db.prepare("INSERT INTO projects(id,name,folder,settings_json,created_at) VALUES(1,?,?,?,?)").run("Availability UI", workspace,
  JSON.stringify({ orchestratorModel: "gemini:gemini-4-argon-medium", geminiModel: "gemini-4-argon-medium", maxGeminiWorkers: 2 }), now);
db.prepare("INSERT INTO chats(id,project_id,title,created_at,last_active_at) VALUES(1,1,?,?,?)").run("CLI availability", now, now);
db.close();

async function cli(app, installed) {
  await app.evaluate(({ ipcMain }, installed) => {
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini", "grok"].map(agent => ({ agent,
      path: agent === "gemini" && !installed ? null : "fixture-cli.exe", authStatus: "authenticated" })));
  }, installed);
}

let app, page;
try {
  ({ app, page } = await launch(data));
  await cli(app, false);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__availabilitySends = 0;
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, agent) => [{ id: { claude: "opus", codex: "gpt-test", gemini: "gemini-4-argon-medium", grok: "grok-test", deepseek: "DeepSeek-Chat" }[agent], label: `${agent} fixture model`, isDefault: true, reasoningEfforts: ["medium", "high"] }]);
    ipcMain.removeHandler("chats:send");
    ipcMain.handle("chats:send", () => { globalThis.__availabilitySends++; throw new Error("No model turns in this fixture"); });
  });
  await page.reload();
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  const gemini = page.locator('[data-testid="provider-controls"][data-provider="gemini"]');
  const model = page.getByLabel("이 채팅의 제미나이 모델", { exact: true });
  const master = page.getByLabel("이 채팅의 마스터 모델", { exact: true });
  const effort = page.getByLabel("이 채팅의 마스터 추론 수준", { exact: true });
  const input = page.getByLabel("메시지 입력", { exact: true });
  await page.waitForFunction(() => document.querySelector('[data-provider="gemini"][data-testid="provider-controls"]')?.getAttribute("data-state") === "disabled");
  check("missing agy disables the Antigravity worker model", await model.isDisabled());
  check("missing agy disables Antigravity master effort", await effort.isDisabled());
  check("master model picker can still select another provider", await master.isEnabled());
  await input.fill("keep this draft");
  check("new Antigravity master work cannot be sent", await page.getByTestId("send").isDisabled());
  await input.press("Enter");
  check("Enter cannot bypass missing-CLI guard", await app.evaluate(() => globalThis.__availabilitySends) === 0);
  check("blocked send preserves draft", await input.inputValue() === "keep this draft");
  await master.click();
  check("Antigravity master choice is disabled", await page.getByTestId("antigravity-unavailable").getAttribute("data-disabled") !== null);
  await page.getByRole("menuitem", { name: /claude fixture model/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="send"]')?.disabled);
  check("other master remains usable without agy", await page.getByTestId("send").isEnabled());
  await page.evaluate(() => window.chatterbox.updateChat(1, { orchestratorModelOverride: null }));
  await page.getByTestId("antigravity-master-unavailable").waitFor();
  await cli(app, true);
  await page.getByRole("button", { name: "Antigravity 설치 다시 확인", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="이 채팅의 제미나이 모델"]')?.disabled);
  check("install and refresh re-enable worker model", await model.isEnabled());
  check("install and refresh re-enable master effort", await effort.isEnabled());
  check("install and refresh permit the preserved draft", await page.getByTestId("send").isEnabled() && await input.inputValue() === "keep this draft");
  await model.click();
  await page.getByRole("menuitem", { name: /gemini fixture model/ }).waitFor();
  check("model list reloads after installation", await page.getByRole("menuitem", { name: /gemini fixture model/ }).count() === 1);
  await page.keyboard.press("Escape");
  await cli(app, false);
  await model.click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="이 채팅의 제미나이 모델"]')?.disabled);
  check("removed CLI disables cached models again", await model.isDisabled());
  await page.keyboard.press("Escape");
  const saved = (await page.evaluate(() => window.chatterbox.listProjects()))[0];
  check("availability never overwrites saved worker count and model", saved.settings.maxGeminiWorkers === 2 && saved.settings.geminiModel === "gemini-4-argon-medium");
  check("availability checks never send a model prompt", await app.evaluate(() => globalThis.__availabilitySends) === 0);
} catch (error) {
  check("availability UI completes", false, error.stack ?? String(error));
} finally { await app?.close().catch(() => {}); }
console.log(`Artifacts: ${base}`);
finish();

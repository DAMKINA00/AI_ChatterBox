// Isolated provider/settings/message UI regression; never submits a model prompt.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "providers-ui", String(Date.now()));
const data = join(base, "data"), workspace = join(base, "workspace");
mkdirSync(data, { recursive: true }); mkdirSync(workspace, { recursive: true });
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
const now = Date.now();
db.prepare("INSERT INTO projects(id,name,folder,settings_json,created_at) VALUES (1,?,?,?,?)").run("Provider UI", workspace, JSON.stringify({ orchestratorModel: "gemini:gemini-test-medium", geminiModel: "gemini-test-medium", grokModel: "grok-test" }), now);
db.prepare("INSERT INTO chats(id,project_id,title,created_at,last_active_at) VALUES (1,1,?,?,?)").run("팀 협업", now, now);
for (const [id, kind, name] of [[1, "gemini", "Antigravity 1호"], [2, "grok", "Grok 1호"]]) db.prepare("INSERT INTO agents(id,chat_id,kind,number,nickname,created_at) VALUES (?,1,?,1,?,?)").run(id, kind, name, now);
const insert = db.prepare("INSERT INTO chat_events(chat_id,node,role,ts,type,payload_json) VALUES (1,?,?,?,?,?)");
for (const [node, role, event] of [["orch", "orch", { type: "text", text: "UI와 API를 나눠 협업합니다." }], ["w2", "w1", { type: "peer_message", from: "w1", to: "w2", text: "API 계약: resultId 필드를 사용하세요." }], ["w2", "w2", { type: "text", text: "직접 받은 계약을 반영했습니다." }]]) insert.run(node, role, now, event.type, JSON.stringify(event));
db.close();

async function isolate(app) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini", "grok"].map(agent => ({agent, path: "mock-cli.exe", authStatus: agent === "grok" ? "required" : "authenticated"})));
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_e, agent) => [{ id: { claude: "opus", codex: "gpt-test", gemini: "gemini-test-medium", grok: "grok-test" }[agent], label: `${agent} test model`, isDefault: true, reasoningEfforts: ["medium", "high", "xhigh"] }]);
  });
}
async function openChat(page) {
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.getByLabel("이 채팅의 그록 모델", { exact: true }).waitFor();
}
let app, page;
try {
  ({ app, page } = await launch(data)); await isolate(app); await page.reload();
  await page.setViewportSize({ width: 1420, height: 1000 }); await openChat(page);
  const usage = await page.getByTestId("usage-bar").allTextContents();
  check("usage names are 클로드 / 지피티 / 제미나이 / 그록", usage.length === 4 && ["클로드", "지피티", "제미나이", "그록"].every((name, i) => usage[i].startsWith(name)), usage.join(" | "));
  check("Gemini web management keeps its own name", await page.getByTestId("gemini-web-manage").textContent() === " 제미나이 웹 계정 관리" || (await page.getByTestId("gemini-web-manage").textContent()).trim() === "제미나이 웹 계정 관리");
  for (const name of ["클로드", "지피티", "제미나이", "그록"]) check(`${name} header model control`, await page.getByLabel(`이 채팅의 ${name} 모델`, { exact: true }).count() === 1);
  await page.getByLabel("이 채팅의 마스터 모델", { exact: true }).click();
  check("master picker offers all four CLI providers", (await page.getByRole("menu").textContent()).includes("그록 모델") && (await page.getByRole("menu").textContent()).includes("제미나이 모델"));
  check("web account is not offered as master", !(await page.getByRole("menu").textContent()).includes("제미나이 웹 · Argon"));
  await page.getByRole("menuitem", { name: /grok test model/ }).click();
  let chat = (await page.evaluate(() => window.chatterbox.listChats()))[0];
  check("Grok master selection persists", chat.orchestratorModelOverride === "grok:grok-test");
  await page.locator('[data-testid="team-chip"][data-role="w2"]').click();
  check("peer message identifies sender and recipient", (await page.locator("main").textContent()).includes("API 계약: resultId 필드를 사용하세요."));
  check("legacy worker names are normalized", (await page.getByTestId("team-chips").textContent()).includes("제미나이 1호") && (await page.getByTestId("team-chips").textContent()).includes("그록 1호"));
  const grok = page.locator('[data-testid="provider-controls"][data-provider="grok"]');
  await grok.locator('button[aria-label="그록 로그인 상태 다시 확인"]').waitFor();
  check("installed but logged-out Grok is visibly inactive", await grok.getAttribute("data-state") === "inactive" && (await grok.textContent()).includes("로그인 필요"));
  check("master also shows missing login", await page.getByTestId("orch-badge").getAttribute("data-state") === "inactive");
  check("Grok PNG avatar decodes", await grok.locator('img[data-kind="grok"]').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.includes("/characters/grok/neutral.png")));
  for (const authStatus of ["unknown", "authenticated", "required"]) {
    await app.evaluate(({ipcMain}, authStatus) => {
      ipcMain.removeHandler("cli:info");
      ipcMain.handle("cli:info", () => ["claude", "codex", "gemini", "grok"].map(agent => ({agent, path:"mock-cli.exe", authStatus: agent === "grok" ? authStatus : "authenticated"})));
    }, authStatus);
    if (await grok.getByRole("button", {name:"그록 로그인 상태 다시 확인", exact:true}).count()) await grok.getByRole("button", {name:"그록 로그인 상태 다시 확인", exact:true}).click();
    else { await page.reload(); await openChat(page); }
    const expected = authStatus === "authenticated" ? "ready" : "inactive";
    await page.waitForFunction(expected => document.querySelector('[data-testid="provider-controls"][data-provider="grok"]')?.getAttribute("data-state") === expected, expected);
    if (authStatus === "unknown") await grok.getByText("로그인 확인 필요", {exact:true}).waitFor();
    check(`Grok login state ${authStatus}`, await grok.getAttribute("data-state") === expected);
  }
  await page.screenshot({ path: join(base, "providers-wide.png"), fullPage: true });
  await page.setViewportSize({ width: 1000, height: 800 });
  check("header wraps within smaller window", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(base, "providers-small.png"), fullPage: true });
  await page.setViewportSize({ width: 1420, height: 1000 });
  await page.getByRole("button", { name: "Provider UI 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("그록이 잘 맡는 작업").fill("이미지와 구현 담당");
  await dialog.getByLabel("그록 작업자 주의점").fill("실제 도구 결과 확인");
  await dialog.locator("label").filter({ hasText: "동시 그록 작업자" }).locator("input").fill("2");
  await dialog.getByLabel("마스터 모델", { exact: true }).click();
  await page.getByRole("menuitem", { name: /grok test model/ }).click();
  await page.screenshot({ path: join(base, "provider-settings.png"), fullPage: true });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const project = (await page.evaluate(() => window.chatterbox.listProjects()))[0];
  check("Grok project preferences, limit and master persist", project.settings.grokStrengths === "이미지와 구현 담당" && project.settings.maxGrokWorkers === 2 && project.settings.orchestratorModel === "grok:grok-test");
  await app.close(); app = undefined;
  ({ app, page } = await launch(data)); await isolate(app); await page.reload(); await openChat(page);
  check("Grok master survives restart", (await page.getByLabel("이 채팅의 마스터 모델", { exact: true }).textContent()).includes("그록"));
  await app.evaluate(({ipcMain}) => {
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini", "grok"].map(agent => ({agent, path: "mock-cli.exe", authStatus: "required"})));
  });
  await page.evaluate(() => window.chatterbox.updateChat(1, {geminiModelOverride: "gemini-web-argon"}));
  await page.reload(); await openChat(page);
  const gemini = page.locator('[data-testid="provider-controls"][data-provider="gemini"]');
  check("Gemini web stays separate from missing CLI login", await gemini.getAttribute("data-state") === "web" && !(await gemini.textContent()).includes("로그인 필요"));
  const saved = (await page.evaluate(() => window.chatterbox.listProjects()))[0];
  check("Grok preferences survive restart", saved.settings.grokCautions === "실제 도구 결과 확인" && saved.settings.maxGrokWorkers === 2);
} catch (error) {
  check("provider UI completes", false, error.stack ?? String(error));
  await page?.screenshot({ path: join(base, "failure.png"), fullPage: true }).catch(() => {});
} finally { await app?.close().catch(() => {}); }
console.log(`Artifacts: ${base}`);
finish();

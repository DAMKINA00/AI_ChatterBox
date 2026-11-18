// Isolated SQLite + real Electron sidebar/IPC; only model execution is replaced by a synthetic reply.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { root } from "./e2e-lib.mjs";

const base = join(root, ".scratch", "chat-list-ui", String(Date.now()));
const data = join(base, "data"), isolatedHome = join(base, "home");
for (const dir of [data, isolatedHome, join(isolatedHome, "AppData", "Roaming"), join(isolatedHome, "AppData", "Local")]) mkdirSync(dir, { recursive: true });
const fixtureFile = join(base, "fixture.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: fixtureFile, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error" });
const { Store, DEFAULT_SETTINGS } = createRequire(import.meta.url)(fixtureFile);
const dbFile = join(data, "chatterbox.db"), store = new Store(dbFile);
const project = store.createProject("순서 프로젝트", base, DEFAULT_SETTINGS);
const other = store.createProject("다른 프로젝트", base, DEFAULT_SETTINGS);
const a = store.createChat(project.id, "첫 번째 대화"), b = store.createChat(project.id, "두 번째 대화"), c = store.createChat(project.id, "세 번째 대화");
const foreign = store.createChat(other.id, "외부 대화");
store.close();
const env = { ...process.env, AI_CHATTERBOX_DATA: data, AI_CHATTERBOX_HIDE: "1",
  USERPROFILE: isolatedHome, HOME: isolatedHome, APPDATA: join(isolatedHome, "AppData", "Roaming"), LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
  CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"), CODEX_HOME: join(isolatedHome, ".codex"), GROK_HOME: join(isolatedHome, ".grok"),
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot};${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` };
for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|XAI|DEEPSEEK|GEMINI|GOOGLE)_/i.test(key)) delete env[key];
let app;
let passed = 0;
const check = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`); passed++; };
try {
  app = await electron.launch({ args: [root], env, timeout: 45_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.getByTestId("sidebar").waitFor();
  await app.evaluate(async ({ ipcMain, BrowserWindow }, { fixtureFile, dbFile, base }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const { Store, ChatManager } = createRequire(fixtureFile)(fixtureFile);
    const fixtureStore = new Store(dbFile);
    const emit = (channel, value) => BrowserWindow.getAllWindows()[0].webContents.send(channel, value);
    const manager = new ChatManager(fixtureStore, { agents() {}, consult() {}, usage() {}, chat: c => emit("chat:updated", c), event: e => emit("chat:event", e) }, base, "unused");
    manager.sendHandler = async chat => {
      manager.emit(chat.id, "orch", "orch", { type: "text", text: "테스트 응답" });
      manager.orchTurnEnded(chat.id, { type: "turn_end", ok: true });
    };
    globalThis.chatListFixture = { manager, store: fixtureStore, rejectNext: false };
    ipcMain.removeHandler("chats:send");
    ipcMain.handle("chats:send", (_e, id, text, attachments, delivery) => {
      if (globalThis.chatListFixture.rejectNext) { globalThis.chatListFixture.rejectNext = false; throw new Error("테스트 전송 실패"); }
      return manager.send(id, text, attachments, delivery);
    });
    for (const [channel, value] of [["cli:info", []], ["models:list", []], ["usage:get", {}], ["cli-accounts:startup-check", []]]) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, () => value);
    }
  }, { fixtureFile, dbFile, base });
  await page.reload();
  const group = page.getByTestId("project-node").filter({ has: page.getByRole("button", { name: "순서 프로젝트 폴더", exact: true }) });
  const rows = () => group.getByTestId("chat-node");
  const order = () => rows().evaluateAll(nodes => nodes.map(n => Number(n.dataset.chatId)));
  const row = id => page.locator(`[data-chat-id="${id}"] [role="treeitem"]`).first();
  await rows().nth(2).waitFor();
  check("initial order", JSON.stringify(await order()) === JSON.stringify([c.id, b.id, a.id]));
  await row(a.id).dragTo(row(c.id), { sourcePosition: { x: 80, y: 16 }, targetPosition: { x: 80, y: 3 } });
  await page.waitForFunction(id => Number(document.querySelector('[data-testid="project-node"] [data-chat-id]')?.getAttribute("data-chat-id")) === id, a.id);
  check("mouse drag moves chat above target", JSON.stringify(await order()) === JSON.stringify([a.id, c.id, b.id]));
  await row(a.id).dragTo(row(b.id), { sourcePosition: { x: 80, y: 16 }, targetPosition: { x: 80, y: 29 } });
  await page.waitForFunction(id => Number(document.querySelector('[data-testid="project-node"] [data-chat-id]')?.getAttribute("data-chat-id")) === id, c.id);
  check("mouse drag moves chat below target", JSON.stringify(await order()) === JSON.stringify([c.id, b.id, a.id]));
  await row(a.id).dragTo(row(foreign.id), { sourcePosition: { x: 80, y: 16 }, targetPosition: { x: 80, y: 3 } });
  check("another project rejects drop", JSON.stringify(await order()) === JSON.stringify([c.id, b.id, a.id]));
  await page.reload(); await rows().nth(2).waitFor();
  check("saved order survives renderer reload", JSON.stringify(await order()) === JSON.stringify([c.id, b.id, a.id]));
  await group.getByRole("button", { name: "순서 프로젝트에 새 채팅", exact: true }).click();
  const input = page.getByRole("textbox", { name: "메시지 입력", exact: true });
  await input.waitFor();
  check("new opens blank composer without list entry", await input.inputValue() === "" && await rows().count() === 3);
  const draftId = await page.evaluate(() => Number(localStorage.getItem("lastChat")));
  await page.evaluate(id => window.chatterbox.updateChat(id, { codexModelOverride: "fixture-model" }), draftId);
  const file = join(base, "draft.txt"); writeFileSync(file, "draft attachment");
  await page.evaluate(async ({ draftId, file }) => window.chatterbox.attachFromPaths(draftId, [file]), { draftId, file });
  await input.fill("실제 첫 메시지");
  check("typing, model and attachment changes do not register chat", await rows().count() === 3);
  await app.evaluate(() => { globalThis.chatListFixture.rejectNext = true; });
  await page.getByTestId("send").click();
  await page.getByText("테스트 전송 실패", { exact: false }).waitFor();
  check("failed send preserves text and hidden draft", await input.inputValue() === "실제 첫 메시지" && await rows().count() === 3);
  await page.getByTestId("send").click();
  await page.locator(`[data-chat-id="${draftId}"]`).waitFor();
  check("first accepted send registers once at top", (await order())[0] === draftId && await rows().count() === 4);
  check("registered chat gets the message title", await row(draftId).innerText().then(text => text.includes("실제 첫 메시지")));
  await group.getByRole("button", { name: "순서 프로젝트에 새 채팅", exact: true }).click();
  check("next New opens another blank composer", await input.inputValue() === "" && await rows().count() === 4);
  await page.reload(); await input.waitFor();
  check("unfinished draft stays hidden after reload", await rows().count() === 4);
  await page.getByRole("textbox", { name: "채팅 검색" }).fill("새 채팅");
  check("draft does not appear in search", await page.getByTestId("chat-node").count() === 0);
  await page.getByRole("textbox", { name: "채팅 검색" }).fill("");
  await page.screenshot({ path: join(base, "chat-list.png") });
  check("no renderer errors", errors.length === 0);
  console.log(`${passed} passed; evidence: ${base}`);
} finally {
  if (app) {
    await app.evaluate(async () => { await globalThis.chatListFixture?.manager.dispose(); globalThis.chatListFixture?.store.close(); });
    await app.close();
  }
}

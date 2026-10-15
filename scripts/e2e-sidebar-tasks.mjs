// Isolated UI checks: folder gestures, menu anchors, project limits and tool groups.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, root } from "./e2e-lib.mjs";

const data = join(root, ".scratch", "sidebar-tasks", String(Date.now()));
mkdirSync(data, { recursive: true });
let app;
let passed = 0;
const check = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`); passed++; };
try {
  const fixture = await launch(data);
  app = fixture.app;
  const page = fixture.page;
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini"].map(agent => ({ agent, path: "fixture" })));
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", () => []);
    ipcMain.removeHandler("usage:get");
    ipcMain.handle("usage:get", () => ({}));
  });
  const ids = await page.evaluate(async folder => {
    const project = await window.chatterbox.createProject({ name: "폴더 점검", folder, settings: {} });
    const chat = await window.chatterbox.createChat(project.id);
    await window.chatterbox.updateChat(chat.id, { title: "작업 목록 점검" });
    return { project: project.id, chat: chat.id };
  }, data);
  await page.reload();
  const folder = page.getByRole("button", { name: "폴더 점검 폴더", exact: true });
  await folder.waitFor();
  await folder.click();
  check("single folder click preserves expanded state", await folder.getAttribute("aria-expanded") === "true");
  await folder.dblclick();
  check("double click collapses folder", await folder.getAttribute("aria-expanded") === "false");
  await folder.click();
  check("single click does not reopen folder", await folder.getAttribute("aria-expanded") === "false");
  await folder.dblclick();
  check("double click expands folder", await folder.getAttribute("aria-expanded") === "true");
  await folder.focus(); await folder.press("Enter");
  check("keyboard activation still toggles folder", await folder.getAttribute("aria-expanded") === "false");
  await folder.press("Enter");

  async function checkMenu(trigger, label) {
    await trigger.hover();
    const anchor = await trigger.boundingBox();
    await trigger.click();
    await page.mouse.move(950, 500);
    await page.waitForTimeout(250);
    const menu = await page.getByRole("menu").boundingBox();
    const current = await trigger.boundingBox();
    check(`${label} remains anchored after leaving its row`, !!anchor && !!menu && !!current && current.width > 0 && menu.x > 20 && menu.y > 20 && Math.abs(menu.y - anchor.y) < 300);
    await page.screenshot({ path: join(data, `${label}-menu.png`) });
    await page.keyboard.press("Escape");
  }
  await checkMenu(page.locator('button[aria-label="폴더 점검 메뉴"]'), "project");
  const chatRow = page.locator(`[data-testid="chat-node"][data-chat-id="${ids.chat}"] [role="treeitem"]`);
  await chatRow.hover();
  await checkMenu(chatRow.locator('button[aria-label="작업 목록 점검 메뉴"]'), "chat");
  check("menus do not fold the folder", await folder.getAttribute("aria-expanded") === "true");

  await page.getByRole("button", { name: "폴더 점검 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const consults = dialog.locator("label").filter({ hasText: "지시당 배정 한도" }).getByRole("spinbutton");
  const reviews = dialog.locator("label").filter({ hasText: "리뷰 왕복" }).getByRole("spinbutton");
  check("new project defaults are 100 and 20", await consults.inputValue() === "100" && await reviews.inputValue() === "20");
  check("settings expose maximums 999 and 99", await consults.getAttribute("max") === "999" && await reviews.getAttribute("max") === "99");
  await consults.fill("1000"); await reviews.fill("100");
  check("settings clamp values beyond the maximum", await consults.inputValue() === "999" && await reviews.inputValue() === "99");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const settings = await page.evaluate(async id => (await window.chatterbox.listProjects()).find(p => p.id === id).settings, ids.project);
  check("maximum settings are saved through IPC", settings.maxConsults === 999 && settings.maxReviews === 99);
  await chatRow.click();
  await page.evaluate(id => window.chatterbox.updateChat(id, { status: "working" }), ids.chat);
  let eventId = 10000;
  const publish = async (event, role = "orch") => {
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("chat:event", payload), {
      id: eventId++, chatId: ids.chat, node: role, role, at: Date.now(), event,
    });
  };
  const tool = async (id, role = "orch", ok = true) => {
    await publish({ type: "tool_call", id, name: "Read", input: `${id}.txt` }, role);
    if (ok !== null) await publish({ type: "tool_result", id, ok, output: `${id} output` }, role);
  };
  await publish({ type: "text", text: "첫 작업 묶음" });
  await tool("a1"); await tool("a2"); await tool("a3", "orch", null);
  await publish({ type: "text", text: "메시지 다음에는 별도 작업" });
  await tool("single");
  await publish({ type: "text", text: "작업자별 묶음" });
  await tool("b1", "w1"); await tool("b2", "w1", false);
  await tool("c1", "orch"); await tool("c2", "orch", null);
  await publish({ type: "approval_request", request: { id: "fixture-pending", role: "orch", title: "별도 승인", detail: "fixture only", risk: "high" } });
  const groups = page.locator('[data-testid="task-list-group"]');
  await groups.nth(2).waitFor();
  check("consecutive tools group without crossing messages or roles", await groups.count() === 3 && await groups.nth(1).getAttribute("data-role") === "w1");
  check("all task groups start collapsed", (await page.locator('[data-testid="task-list-toggle"]').evaluateAll(buttons => buttons.every(b => b.getAttribute("aria-expanded") === "false"))));
  check("single tool remains available outside groups", await page.locator('[data-testid="tool-card"]').count() === 1);
  check("collapsed groups show running and error counts", (await groups.first().textContent()).includes("1개 진행 중") && (await groups.nth(1).textContent()).includes("1개 오류"));
  await groups.first().getByTestId("task-list-toggle").click();
  check("expanding group reveals original tool rows", await groups.first().getByTestId("tool-card").count() === 3);
  await groups.first().getByTestId("tool-card").first().getByRole("button").click();
  check("individual tool details still expand", (await groups.first().textContent()).includes("a1 output"));
  await publish({ type: "tool_result", id: "a3", ok: true, output: "a3 complete" });
  check("result updates preserve group expansion", await groups.first().getByTestId("task-list-toggle").getAttribute("aria-expanded") === "true" && !(await groups.first().textContent()).includes("진행 중"));
  await groups.nth(2).getByTestId("task-list-toggle").click();
  await tool("c3", "orch", null);
  check("new consecutive tool preserves expansion and updates count", await groups.nth(2).getByTestId("tool-card").count() === 3 && await groups.nth(2).getByTestId("task-list-toggle").getAttribute("aria-expanded") === "true");
  check("pending approval stays outside groups at bottom", await page.locator('[data-testid="pending-approvals"] [data-testid="approval"]').count() === 1 && await groups.locator('[data-testid="approval"]').count() === 0);
  for (const button of await page.getByTestId("task-list-toggle").all()) if (await button.getAttribute("aria-expanded") === "true") await button.click();
  await page.screenshot({ path: join(data, "task-groups-dark.png") });
  await page.getByRole("button", { name: "테마 전환", exact: true }).click();
  await page.screenshot({ path: join(data, "task-groups-light.png") });
  console.log(`${passed}/${passed} passed; screenshots and data: ${data}`);
} finally { await app?.close(); }

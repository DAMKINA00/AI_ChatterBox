// Isolated synthetic history: no user database writes or model calls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, root } from "./e2e-lib.mjs";

const base = join(root, ".scratch", "chat-switching", String(Date.now()));
mkdirSync(base, { recursive: true });
let app;
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`PASS ${name}`); };
try {
  const started = await launch(join(base, "data"));
  app = started.app;
  const page = started.page;
  const [a, b] = await page.evaluate(async ({ folder, settings }) => {
    const p = await window.chatterbox.createProject({ name: "History window", folder, settings });
    const a = await window.chatterbox.createChat(p.id), b = await window.chatterbox.createChat(p.id);
    await window.chatterbox.updateChat(a.id, { title: "History A", status: "working" });
    await window.chatterbox.updateChat(b.id, { title: "History B" });
    return [a.id, b.id];
  }, { folder: base, settings: DEFAULTS });
  const events = [];
  const add = (event, node = "orch", role = "orch") => events.push({ id: events.length + 1, chatId: a, at: Date.now(), node, role, event });
  add({ type: "consult_start", consultId: 10, kind: "implement", from: "orch", to: "w1", request: "older active work", attachments: [] });
  add({ type: "text_delta", text: "older worker still streaming" }, "consult:10", "w1");
  add({ type: "approval_request", request: { id: "old-approval", role: "w1", title: "older approval", detail: "fixture only", risk: "low" } }, "consult:10", "w1");
  add({ type: "ask_user", id: "old-question", question: "older question", options: [] });
  for (let i = 0; i < 300; i++) add({ type: "text", text: `history message ${i}` });
  add({ type: "consult_start", consultId: 20, kind: "review", from: "orch", to: "w2", request: "completed review", attachments: [] });
  for (let i = 0; i < 60; i++) add({ type: "text", text: `review detail ${i}` }, "consult:20", "w2");
  add({ type: "consult_end", consultId: 20, status: "done", summary: "completed review summary", files: [] });
  for (let i = 300; i < 350; i++) add({ type: "text", text: `history message ${i}` });
  await app.evaluate(({ ipcMain, BrowserWindow }, { a, b, events }) => {
    globalThis.switchLoads = [];
    for (const channel of ["chats:events", "cli:info", "usage:get", "chats:approve"]) ipcMain.removeHandler(channel);
    ipcMain.handle("chats:events", (_e, id) => { globalThis.switchLoads.push(id); return id === a ? events : [{ id: 9999, chatId: b, at: Date.now(), node: "orch", role: "orch", event: { type: "text", text: "other chat only" } }]; });
    ipcMain.handle("cli:info", () => []);
    ipcMain.handle("usage:get", () => ({}));
    ipcMain.handle("chats:approve", (_e, chatId, id, decision) => {
      globalThis.switchApproval = { chatId, id, decision };
      BrowserWindow.getAllWindows()[0].webContents.send("chat:event", { id: 10001, chatId, at: Date.now(), node: "orch", role: "orch", event: { type: "approval_resolved", id, decision } });
    });
  }, { a, b, events });
  await page.evaluate(() => localStorage.removeItem("lastChat"));
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  const select = async id => {
    await page.locator(`[data-testid="chat-node"][data-chat-id="${id}"] [role="treeitem"]`).click();
    await page.waitForSelector('[data-testid="agent-message"]');
  };
  await select(a);
  const history = page.getByTestId("history-list").first();
  check("first paint contains recent messages and older active work only", await history.locator(":scope > [data-history-entry]").count() === 102);
  check("older working consult remains visible", await page.getByText("older worker still streaming", { exact: true }).count() === 1);
  check("older unanswered question remains visible", await page.getByText("older question", { exact: true }).count() === 1);
  check("pending approval stays outside the history window", await page.getByTestId("pending-approvals").getByTestId("approve-once").count() === 1);
  check("old messages are deferred", await page.getByText("history message 0", { exact: true }).count() === 0);
  await page.keyboard.press("Control+f");
  const query = page.getByLabel("대화에서 찾을 내용");
  await query.fill("history message 0");
  await query.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "1 / 1");
  check("search includes messages outside the recent history window", await page.getByText("history message 0", { exact: true }).count() === 1);
  await query.fill("review detail 0");
  await query.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "1 / 1");
  check("search includes collapsed worker details", await page.getByText("review detail 0", { exact: true }).count() === 1);
  await page.getByLabel("대화 검색 닫기").click();
  check("closing search restores the recent history window", await page.getByText("history message 0", { exact: true }).count() === 0);
  const review = page.getByTestId("consult-card").filter({ hasText: "completed review summary" });
  check("completed worker details are initially unmounted", await review.getByTestId("agent-message").count() === 0);
  await review.getByTestId("consult-progress-toggle").click();
  check("opening worker details starts with the latest twenty", await review.getByTestId("agent-message").count() === 20);
  await review.getByTestId("load-earlier").click();
  await review.getByTestId("load-earlier").click();
  check("all worker details remain accessible", await review.getByTestId("agent-message").count() === 60);

  const timeline = page.getByTestId("timeline");
  await timeline.evaluate(el => { el.scrollTop = 800; });
  await page.waitForFunction(() => document.querySelector('[data-testid="timeline"]').scrollTop === 800);
  const anchor = await history.locator(":scope > [data-history-entry]").evaluateAll(entries => {
    const top = document.querySelector('[data-testid="timeline"]').getBoundingClientRect().top;
    const e = entries.find(e => e.getBoundingClientRect().bottom > top);
    e.setAttribute("data-scroll-anchor", "true");
    return e.getBoundingClientRect().top;
  });
  // Invoke the button without Playwright scrolling it into view: test prepend anchoring itself.
  await history.locator(':scope > [data-testid="load-earlier"]').evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="history-list"]').querySelectorAll(':scope > [data-history-entry]').length === 202);
  const after = await page.locator('[data-scroll-anchor="true"]').evaluate(el => el.getBoundingClientRect().top);
  check("loading earlier history preserves the visible scroll anchor", Math.abs(anchor - after) < 2);
  await timeline.evaluate(el => { el.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-testid="history-list"]').querySelectorAll(':scope > [data-history-entry]').length > 202);
  check("scrolling upward loads earlier history", true);
  while (await history.locator(':scope > [data-testid="load-earlier"]').count()) await history.locator(':scope > [data-testid="load-earlier"]').evaluate(el => el.click());
  check("first message remains reachable", await page.getByText("history message 0", { exact: true }).count() === 1);
  await page.getByTestId("pending-approvals").getByTestId("approve-once").click();
  check("approval remains actionable", (await app.evaluate(() => globalThis.switchApproval))?.decision === "once");

  await page.getByLabel("메시지 입력").fill("keep draft A");
  await select(b);
  check("switching isolates the other chat", await page.getByText("other chat only", { exact: true }).count() === 1 && await page.getByText("history message 349", { exact: true }).count() === 0);
  await app.evaluate(({ BrowserWindow }, chatId) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:event", { id: 10002, chatId, at: Date.now(), node: "orch", role: "orch", event: { type: "text", text: "background update A" } });
  }, a);
  await select(a);
  check("returning preserves background updates and drafts", await page.getByText("background update A", { exact: true }).count() === 1 && await page.getByLabel("메시지 입력").inputValue() === "keep draft A");
  check("returning resets to recent history", await page.getByText("history message 0", { exact: true }).count() === 0);
  check("cached histories are not fetched again", JSON.stringify(await app.evaluate(() => globalThis.switchLoads)) === JSON.stringify([a, b]));
  await app.evaluate(({ BrowserWindow }, chatId) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    let id = 20000;
    const send = (event, role = "orch") => contents.send("chat:event", { id: id++, chatId, at: Date.now(), node: role, role, event });
    for (let i = 0; i < 200; i++) send({ type: "text", text: `boundary old ${i}` });
    send({ type: "text_delta", text: "boundary stream preview" }, "w7");
    for (let i = 0; i < 99; i++) send({ type: "text", text: `boundary tail ${i}` });
  }, b);
  await select(b);
  await page.getByText("boundary stream preview", { exact: true }).waitFor();
  check("temporary stream can be the history window boundary", await history.locator(":scope > [data-history-entry]").count() === 100);
  await app.evaluate(({ BrowserWindow }, chatId) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:event", { id: 21000, chatId, at: Date.now(), node: "w7", role: "w7", event: { type: "text", text: "boundary final response" } });
  }, b);
  await page.getByText("boundary final response", { exact: true }).waitFor();
  check("replacing the window boundary does not mount the entire history", await history.locator(":scope > [data-history-entry]").count() === 100 && await page.getByText("boundary old 0", { exact: true }).count() === 0);
  await select(a);
  await page.screenshot({ path: join(base, "chat-switching.png") });
  console.log(`${checks} checks passed; evidence: ${base}`);
} finally {
  await app?.close();
}

// UI-only controls/receipts with isolated data and deferred IPC; no real agents run.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, root } from "./e2e-lib.mjs";
const data = join(root, ".scratch", "pause-receipts", String(Date.now()));
mkdirSync(data, { recursive: true });
let app; let count = 0;
const check = (label, ok) => { assert.ok(ok, label); console.log(`PASS ${label}`); count++; };
try {
  const fixture = await launch(data); app = fixture.app;
  const page = fixture.page;
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ["cli:info", "models:list", "usage:get"]) ipcMain.removeHandler(channel);
    ipcMain.handle("cli:info", () => ["claude", "codex", "gemini"].map(agent => ({ agent, path: "fixture" })));
    ipcMain.handle("models:list", () => []); ipcMain.handle("usage:get", () => ({}));
    globalThis.calls = [];
    for (const name of ["pause", "resume"]) {
      ipcMain.removeHandler(`chats:${name}`);
      ipcMain.handle(`chats:${name}`, (_event, chatId) => {
        globalThis.calls.push({ name, chatId });
        return new Promise(resolve => { globalThis.finishControl = resolve; });
      });
    }
    ipcMain.removeHandler("chats:approve");
    ipcMain.handle("chats:approve", (_event, chatId, id, decision) => {
      globalThis.calls.push({ name: "approve", chatId, id, decision });
      return new Promise(resolve => { globalThis.finishApproval = resolve; });
    });
  });
  const ids = await page.evaluate(async folder => {
    const p = await window.chatterbox.createProject({ name: "일시 정지 점검", folder, settings: {} });
    const a = await window.chatterbox.createChat(p.id); const b = await window.chatterbox.createChat(p.id);
    await window.chatterbox.updateChat(a.id, { title: "첫 채팅" });
    await window.chatterbox.updateChat(b.id, { title: "다른 채팅", status: "working" });
    return { a: a.id, b: b.id };
  }, data);
  await page.reload();
  const row = page.locator(`[data-testid="chat-node"][data-chat-id="${ids.a}"]`);
  await row.locator('[role="treeitem"]').click();
  const setStatus = status => page.evaluate(({ id, status }) => window.chatterbox.updateChat(id, { status }), { id: ids.a, status });
  const pause = page.getByTestId("pause"); const resume = page.getByTestId("resume");
  check("idle chat has no pause/play control", await pause.count() === 0 && await resume.count() === 0);
  check("top right stop removed", await page.getByTestId("stop").count() === 0);
  await setStatus("working"); await pause.waitFor();
  check("working pause icon sits inside composer", await pause.evaluate(el => !!el.closest('div.rounded-2xl')?.querySelector('textarea')));
  await pause.click();
  check("pause click immediately disables control", await pause.isDisabled());
  await setStatus("pausing");
  check("pausing shows busy indicator in chat tree", await row.getByLabel("일시 중지 중", { exact: true }).count() === 1);
  await setStatus("paused");
  await app.evaluate(() => globalThis.finishControl());
  await resume.waitFor();
  check("paused chat shows play and sidebar pause icon", await resume.getAttribute("aria-label") === "재시작" && await row.getByLabel("일시 정지", { exact: true }).count() === 1);
  check("paused input explains queued instructions", (await page.getByRole("textbox", { name: "메시지 입력" }).getAttribute("placeholder")).includes("재시작"));
  await page.screenshot({ path: join(data, "paused.png") });
  await resume.click();
  check("play click immediately prevents repeated resume", await pause.isDisabled() && await pause.getAttribute("aria-label") === "재시작하는 중");
  await setStatus("working"); await app.evaluate(() => globalThis.finishControl());
  await page.waitForFunction(() => document.querySelector('[data-testid="pause"]')?.getAttribute("aria-label") === "일시 중지");
  const calls = await app.evaluate(() => globalThis.calls);
  check("controls target only selected chat", calls.length === 2 && calls.every(call => call.chatId === ids.a));
  const other = await page.evaluate(async id => (await window.chatterbox.listChats()).find(chat => chat.id === id), ids.b);
  check("other chat remains working", other.status === "working");
  await setStatus("done");
  check("completed chat hides controls", await pause.count() === 0 && await resume.count() === 0);
  await setStatus("approval");
  await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0].webContents.send("chat:event", payload), {
    id: 10000, chatId: ids.a, node: "orch", role: "orch", at: Date.now(), event: { type: "approval_request", request: { id: "receipt-a", role: "orch", title: "확인 대상", detail: "fixture only", risk: "low" } },
  });
  const approval = page.getByTestId("approval");
  await approval.getByTestId("approve-once").click();
  check("approval click gives immediate pending receipt", (await approval.getByTestId("approval-receipt").textContent()).includes("승인 전달 중"));
  check("approval buttons disabled while IPC pending", await approval.getByTestId("approve-once").isDisabled());
  await app.evaluate(({ BrowserWindow }, id) => {
    for (let i = 0; i < 100; i++) BrowserWindow.getAllWindows()[0].webContents.send("chat:event", { id: 20000 + i, chatId: id, node: "orch", role: "orch", at: Date.now(), event: { type: "text_delta", text: `other${i}` } });
    globalThis.finishApproval("once");
  }, ids.b);
  await page.waitForFunction(() => document.querySelector('[data-testid="approval"]')?.getAttribute("data-state") === "done");
  check("IPC receipt completes without waiting for model or resolved event", (await approval.textContent()).includes("이번만 허용함") && await approval.getByTestId("approve-once").count() === 0);
  const receipt = await app.evaluate(() => globalThis.calls.find(call => call.name === "approve"));
  check("receipt preserves original chat and approval identifiers", receipt.chatId === ids.a && receipt.id === "receipt-a" && receipt.decision === "once");
  await page.screenshot({ path: join(data, "approval-receipt.png") });
  console.log(`${count}/${count} passed; screenshots/data: ${data}`);
} finally { await app?.close(); }

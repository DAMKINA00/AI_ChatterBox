// Renderer responsiveness under a large history and a sustained text stream.
// The app, database, events, and screenshot all live under one scratch directory.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { launch, root } from "./e2e-lib.mjs";

const base = join(root, ".scratch", "renderer-responsiveness", String(Date.now()));
const data = join(base, "data");
const screenshot = join(base, "renderer-responsiveness.png");
mkdirSync(data, { recursive: true });

const CONSULTS = 100;
const TOOLS_PER_CONSULT = 30;
const TEXTS_PER_CONSULT = 3;
const STREAM_MS = 5_000;
const HISTORY_MARKER = "renderer-history-001-1";
const STREAM_FINAL_TEXT = "렌더러 응답성 스트림 최종 결과: 모든 조각과 종료 이벤트를 보존했습니다.";
const APPROVAL_ID = "renderer-responsiveness-approval";

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${String(detail).replace(/\s+/g, " ").slice(0, 240)})` : ""}`);
  assert.ok(ok, `${name}${detail ? `: ${detail}` : ""}`);
}

function textFor(consult, number) {
  const prefix = number === 1 ? HISTORY_MARKER : `renderer-history-${String(consult).padStart(3, "0")}-${number}`;
  const body = ` synthetic consult ${consult} message ${number} `;
  const text = `${prefix}${body}${"렌더러 응답성 합성 이력입니다. 도구 결과와 협의 순서를 보존하는지 확인합니다. ".repeat(8)}`;
  if (text.length < 200 || text.length > 600) throw new Error(`synthetic text length out of range: ${text.length}`);
  return text;
}

function pushEvent(events, id, chatId, node, role, event, at) {
  events.push({ id, chatId, node, role, at, event });
  return id + 1;
}

function buildHistory(chatId) {
  const events = [];
  let id = 1;
  const start = Date.now() - 120_000;
  for (let consult = 1; consult <= CONSULTS; consult++) {
    const role = `w${((consult - 1) % 7) + 1}`;
    const node = `consult:${consult}`;
    const at = start + consult * 1_000;
    id = pushEvent(events, id, chatId, "orch", "orch", {
      type: "consult_start",
      consultId: consult,
      kind: consult % 4 === 0 ? "review" : "implement",
      from: "orch",
      to: role,
      request: `합성 응답성 협의 ${consult}`,
      attachments: [],
      scope: [`fixture/${consult}.txt`],
      instructionId: consult,
      reason: "renderer responsiveness fixture",
    }, at);

    for (let tool = 1; tool <= TOOLS_PER_CONSULT; tool++) {
      const toolId = `history-tool-${consult}-${tool}`;
      id = pushEvent(events, id, chatId, node, role, {
        type: "tool_call",
        id: toolId,
        name: tool % 2 ? "Read" : "Bash",
        input: `fixture consult ${consult}, tool ${tool}`,
      }, at + tool);
      id = pushEvent(events, id, chatId, node, role, {
        type: "tool_result",
        id: toolId,
        ok: true,
        output: `fixture result ${consult}-${tool}`,
      }, at + tool + 0.5);
    }

    for (let number = 1; number <= TEXTS_PER_CONSULT; number++) {
      id = pushEvent(events, id, chatId, node, role, { type: "text", text: textFor(consult, number) }, at + 100 + number);
    }

    id = pushEvent(events, id, chatId, node, role, {
      type: "approval_auto",
      request: {
        id: `history-auto-${consult}`,
        role,
        title: `fixture approval ${consult}`,
        detail: `synthetic action ${consult}`,
        risk: "low",
      },
      decision: "allow",
      reason: "fixture auto approval",
      reused: consult > 1,
    }, at + 200);
    id = pushEvent(events, id, chatId, node, role, { type: "notice", text: `합성 결과 공지 ${consult}` }, at + 201);
    id = pushEvent(events, id, chatId, "orch", "orch", {
      type: "consult_end",
      consultId: consult,
      status: "done",
      summary: `합성 협의 ${consult} 완료`,
      files: [`fixture/${consult}.txt`],
    }, at + 202);
  }
  return events;
}

async function installMocks(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ["cli:info", "models:list", "usage:get"]) ipcMain.removeHandler(channel);
    ipcMain.handle("cli:info", () => [
      { agent: "claude", path: "renderer-fixture-claude" },
      { agent: "codex", path: "renderer-fixture-codex" },
      { agent: "gemini", path: "renderer-fixture-gemini" },
    ]);
    ipcMain.handle("models:list", () => []);
    ipcMain.handle("usage:get", () => ({}));
    globalThis.__rendererResponsivenessApprovals = [];
    ipcMain.removeHandler("chats:approve");
    ipcMain.handle("chats:approve", (_event, chatId, approvalId, decision) => {
      globalThis.__rendererResponsivenessApprovals.push({ chatId, approvalId, decision, at: Date.now() });
      return decision;
    });
  });
}

async function installSyntheticEvents(app, chatId, events) {
  await app.evaluate(({ ipcMain }, payload) => {
    ipcMain.removeHandler("chats:events");
    ipcMain.handle("chats:events", (_event, id) => id === payload.chatId ? payload.events : []);
  }, { chatId, events });
}

async function selectChat(page, chatId) {
  const row = page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"]`);
  await row.locator('[role="treeitem"]').click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="chat-node"][data-chat-id="${id}"] [role="treeitem"]`)?.getAttribute("aria-selected") === "true", chatId);
  await page.waitForSelector('[data-testid="timeline"]');
}

async function stopStream(app) {
  if (!app) return;
  await app.evaluate(() => {
    const stream = globalThis.__rendererResponsivenessStream;
    if (!stream) return;
    clearInterval(stream.timer);
    if (stream.finishTimer) clearTimeout(stream.finishTimer);
    stream.stopped = true;
  }).catch(() => undefined);
}

let app;
let page;
let failure;
let streamStartedAt;
try {
  const fixture = await launch(data);
  app = fixture.app;
  page = fixture.page;
  await installMocks(app);

  const ids = await page.evaluate(async folder => {
    const project = await window.chatterbox.createProject({ name: "렌더러 응답성 fixture", folder, settings: {} });
    if (!project) throw new Error("fixture project was not created");
    const historyChat = await window.chatterbox.createChat(project.id);
    const emptyChat = await window.chatterbox.createChat(project.id);
    if (!historyChat || !emptyChat) throw new Error("fixture chats were not created");
    await window.chatterbox.updateChat(historyChat.id, { title: "합성 이력 fixture", status: "working" });
    await window.chatterbox.updateChat(emptyChat.id, { title: "빈 fixture" });
    return { historyChat: historyChat.id, emptyChat: emptyChat.id };
  }, data);

  const history = buildHistory(ids.historyChat);
  check("synthetic history has the expected event volume", history.length >= 6_500 && history.length <= 7_000, history.length);
  await installSyntheticEvents(app, ids.historyChat, history);

  // This is intentionally the only throttling change, and applies to this fixture window only.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await selectChat(page, ids.historyChat);
  await page.waitForSelector('[data-testid="consult-summary"]');
  check("completed histories defer worker detail rendering", await page.getByTestId("agent-message").count() === 0);
  const firstConsult = page.getByTestId("consult-card").first();
  await firstConsult.getByTestId("consult-progress-toggle").click();
  await firstConsult.getByTestId("load-earlier").click();

  const initial = await page.evaluate(() => ({
    messages: document.querySelectorAll('[data-testid="agent-message"]').length,
    toolGroups: document.querySelectorAll('[data-testid="task-list-group"]').length,
    autoApprovals: document.querySelectorAll('[data-testid="auto-approval"]').length,
    historyMarker: [...document.querySelectorAll('[data-testid="agent-message"]')].some(element => element.textContent?.includes("renderer-history-001-1")),
  }));
  check("requested historical details load intact", initial.messages === 3 && initial.toolGroups === 1 && initial.historyMarker, JSON.stringify(initial));

  const firstToolGroup = page.locator('[data-testid="task-list-group"]').first();
  await firstToolGroup.getByTestId("task-list-toggle").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="task-list-group"] [data-testid="tool-card"]') !== null);
  check("synthetic tool results remain attached", await firstToolGroup.getByTestId("tool-card").count() === TOOLS_PER_CONSULT);

  streamStartedAt = performance.now();
  await app.evaluate(({ BrowserWindow }, payload) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const stream = { startedAt: Date.now(), sent: 0, ticks: [], timer: 0, chatId: payload.chatId };
    stream.timer = setInterval(() => {
      const index = stream.sent++;
      stream.ticks.push(Date.now());
      contents.send("chat:event", {
        id: 800_000 + index,
        chatId: stream.chatId,
        node: "orch",
        role: "orch",
        at: Date.now(),
        event: { type: "text_delta", text: `stream fragment ${index} ` },
      });
    }, 25);
    globalThis.__rendererResponsivenessStream = stream;
  }, { chatId: ids.historyChat });

  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="agent-message"]')]
    .some(element => element.textContent?.includes("stream fragment 0")));
  const messageBox = page.getByLabel("메시지 입력");
  let started = performance.now();
  await messageBox.fill("반응 확인");
  const fillMs = performance.now() - started;
  check("message textbox stays responsive during stream", fillMs < 1_500, `${fillMs.toFixed(1)}ms`);
  await page.waitForFunction(() => document.querySelector('[aria-label="메시지 입력"]')?.value === "반응 확인");

  const theme = page.getByLabel("테마 전환", { exact: true });
  started = performance.now();
  await theme.click();
  const themeMs = performance.now() - started;
  check("sidebar theme toggle stays responsive during stream", themeMs < 1_500, `${themeMs.toFixed(1)}ms`);

  const timeline = page.getByTestId("timeline");
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  await timeline.hover();
  started = performance.now();
  await page.mouse.wheel(0, scrollBefore > 400 ? -400 : 400);
  await page.waitForFunction(previous => Math.abs((document.querySelector('[data-testid="timeline"]')?.scrollTop ?? previous) - previous) > 100, scrollBefore, { timeout: 1_500 });
  const scrollMs = performance.now() - started;
  check("chat history scrolls during stream", scrollMs < 1_500, `${scrollMs.toFixed(1)}ms`);

  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send("chat:event", {
      id: 900_001,
      chatId: payload.chatId,
      node: "orch",
      role: "orch",
      at: Date.now(),
      event: {
        type: "approval_request",
        request: { id: payload.approvalId, role: "orch", title: "응답성 승인", detail: "fixture approval", risk: "low" },
      },
    });
  }, { chatId: ids.historyChat, approvalId: APPROVAL_ID });
  const approval = page.locator('[data-testid="approval"][data-state="pending"]').filter({ hasText: "응답성 승인" });
  await approval.waitFor({ state: "visible", timeout: 5_000 });
  started = performance.now();
  await approval.getByTestId("approve-once").click();
  let approvalCalls = [];
  while (performance.now() - started < 1_500) {
    approvalCalls = await app.evaluate(() => globalThis.__rendererResponsivenessApprovals ?? []);
    if (approvalCalls.some(call => call.approvalId === APPROVAL_ID)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const approvalMs = performance.now() - started;
  const approved = approvalCalls.find(call => call.approvalId === APPROVAL_ID);
  check("approval click is recorded during stream", !!approved && approved.decision === "once" && approvalMs < 1_500, `${approvalMs.toFixed(1)}ms`);

  const elapsed = performance.now() - streamStartedAt;
  if (elapsed < STREAM_MS) await new Promise(resolve => setTimeout(resolve, STREAM_MS - elapsed));
  const streamResult = await app.evaluate(({ BrowserWindow }, payload) => {
    const stream = globalThis.__rendererResponsivenessStream;
    if (!stream) throw new Error("stream state was lost");
    clearInterval(stream.timer);
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const now = Date.now();
    contents.send("chat:event", {
      id: 900_002,
      chatId: stream.chatId,
      node: "orch",
      role: "orch",
      at: now,
      event: { type: "text", text: payload.finalText },
    });
    contents.send("chat:event", {
      id: 900_003,
      chatId: stream.chatId,
      node: "orch",
      role: "orch",
      at: now + 1,
      event: { type: "turn_end", ok: true },
    });
    stream.finishedAt = now;
    stream.durationMs = now - stream.startedAt;
    stream.finalSent = true;
    return { sent: stream.sent, durationMs: stream.durationMs, firstTick: stream.ticks[0], lastTick: stream.ticks.at(-1) };
  }, { finalText: STREAM_FINAL_TEXT });
  check("25ms stream timer ran for at least four seconds", streamResult.durationMs >= 4_000 && streamResult.sent >= 120, JSON.stringify(streamResult));

  await page.waitForFunction(text => {
    const messages = [...document.querySelectorAll('[data-testid="agent-message"]')];
    return messages.some(element => element.textContent?.includes(text));
  }, STREAM_FINAL_TEXT, { timeout: 5_000 });
  const finalMessage = await page.locator('[data-testid="agent-message"]').last().evaluate(element => {
    const content = [...element.querySelectorAll("div")].find(node =>
      node.classList.contains("group") && node.classList.contains("relative") && node.parentElement?.classList.contains("min-w-0"));
    return content?.textContent?.trim() ?? "";
  });
  const afterStream = await page.evaluate(() => ({
    marker: [...document.querySelectorAll('[data-testid="agent-message"]')].some(element => element.textContent?.includes("renderer-history-001-1")),
    toolGroups: document.querySelectorAll('[data-testid="task-list-group"]').length,
  }));
  check("final streaming message is exact and expanded history remains", finalMessage === STREAM_FINAL_TEXT && afterStream.marker && afterStream.toolGroups === 1, JSON.stringify({ finalMessage, afterStream }));

  await selectChat(page, ids.emptyChat);
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-title"]')?.textContent === "빈 fixture");
  await selectChat(page, ids.historyChat);
  await page.waitForFunction(() => document.querySelector('[aria-label="메시지 입력"]')?.value === "반응 확인");
  check("draft survives switching to an empty fixture chat and back", await messageBox.inputValue() === "반응 확인");

  await page.screenshot({ path: screenshot });
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await stopStream(app);
  await page?.screenshot({ path: screenshot }).catch(() => undefined);
  await app?.close().catch(() => undefined);
}

const failedChecks = checks.filter(result => !result.ok).length;
const totalChecks = checks.length + (failure && failedChecks === 0 ? 1 : 0);
console.log(`Evidence: ${base}`);
console.log(`Checks: ${checks.length - failedChecks}/${totalChecks} passed`);
if (failure) process.exitCode = 1;

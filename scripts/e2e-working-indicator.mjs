// Native Electron UI regression for the orbiting/pulsing work indicators.
// The fixture is injected through renderer event channels; no model generation is requested.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, root, scratchDir } from "./e2e-lib.mjs";

const base = scratchDir("working-indicator");
const data = join(base, "data");
const workspace = join(base, "workspace");
const results = [];
const errors = [];
let app;
let page;

function check(name, ok, detail = "") {
  const result = { name, ok: !!ok };
  if (detail) result.detail = String(detail);
  results.push(result);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, " ").slice(0, 240)})` : ""}`);
}

function fixtureEvent(id, chatId, node, role, event, at) {
  return { id, chatId, node, role, event, at };
}

mkdirSync(workspace, { recursive: true });

try {
  ({ app, page } = await launch(data));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1360, height: 900 });

  const project = await page.evaluate(({ folder, settings }) => window.chatterbox.createProject({ name: "Working indicator fixture", folder, settings }), {
    folder: workspace,
    settings: { ...DEFAULTS, claudeStrengths: "fixture", claudeCautions: "fixture", gptStrengths: "fixture", gptCautions: "fixture", geminiStrengths: "fixture", geminiCautions: "fixture" },
  });
  if (!project) throw new Error("could not create fixture project");
  const chat = await page.evaluate((projectId) => window.chatterbox.createChat(projectId), project.id);
  if (!chat) throw new Error("could not create fixture chat");

  // Reload so the newly created project/chat are in the normal renderer store, then select it
  // before injecting events. This makes the event listener's existing events array writable.
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  check("analysis API removed from preload", await page.evaluate(() => !("graphify" in window.chatterbox)));
  for (const menu of ["context", "more"]) {
    if (menu === "context") await page.getByRole("button", { name: `${project.name} 폴더`, exact: true }).click({ button: "right" });
    else await page.getByRole("button", { name: `${project.name} 메뉴`, exact: true }).click();
    await page.getByRole("menuitem", { name: "프로젝트 설정", exact: true }).waitFor();
    check(`${menu} menu has no analysis entry`, await page.getByRole("menuitem", { name: "프로젝트 그래프", exact: true }).count() === 0);
    check(`${menu} menu retains project actions`, await page.getByRole("menuitem", { name: "새 채팅", exact: true }).count() === 1);
    await page.keyboard.press("Escape");
  }
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chat.id}"] [role="treeitem"]`).click();
  await page.waitForSelector('[data-testid="chat-title"]');
  await page.waitForSelector('[data-testid="timeline"]');

  const now = Date.now();
  const agents = [
    { id: 1, chatId: chat.id, key: "w1", kind: "gpt", number: 1, nickname: "지피티 1호", job: "fixture GPT", sessionId: null, status: "active", createdAt: now - 4 },
    { id: 2, chatId: chat.id, key: "w2", kind: "gemini", number: 1, nickname: "제미나이 1호", job: "fixture Gemini", sessionId: null, status: "active", createdAt: now - 3 },
    { id: 3, chatId: chat.id, key: "w3", kind: "deepseek", number: 1, nickname: "딥시크 1호", job: "released fixture", sessionId: null, status: "released", createdAt: now - 2 },
    { id: 4, chatId: chat.id, key: "w4", kind: "claude", number: 1, nickname: "클로드 1호", job: "idle fixture", sessionId: null, status: "active", createdAt: now - 1 },
  ];
  const consults = [
    { id: 1, chatId: chat.id, seq: 1, fromRole: "orch", toRole: "w1", scope: [], kind: "implement", request: "GPT work", responseSummary: null, filesChanged: [], status: "running", startedAt: now - 4000, endedAt: null },
    { id: 2, chatId: chat.id, seq: 2, fromRole: "orch", toRole: "w2", scope: [], kind: "writing", request: "Gemini work", responseSummary: null, filesChanged: [], status: "running", startedAt: now - 3000, endedAt: null },
    { id: 3, chatId: chat.id, seq: 3, fromRole: "orch", toRole: "w3", scope: [], kind: "opinion", request: "released worker", responseSummary: null, filesChanged: [], status: "running", startedAt: now - 2000, endedAt: null },
    { id: 4, chatId: chat.id, seq: 4, fromRole: "orch", toRole: "w4", scope: [], kind: "review", request: "idle worker", responseSummary: null, filesChanged: [], status: "done", startedAt: now - 5000, endedAt: now - 4500 },
  ];
  const events = [
    fixtureEvent(1, chat.id, "orch", "orch", { type: "plan_update", steps: [
      { title: "[제미나이 1호] 문서 초안 작성", status: "inProgress" },
      { title: "[지피티 1호] 이미지 확인", status: "pending" },
    ], explanation: "indicator fixture" }, now - 1000),
    fixtureEvent(2, chat.id, "w1", "w1", { type: "tool_call", id: "fixture-tool-1", name: "Bash", input: "echo first" }, now - 900),
    fixtureEvent(3, chat.id, "w1", "w1", { type: "tool_call", id: "fixture-tool-2", name: "Bash", input: "echo second" }, now - 800),
  ];

  await app.evaluate(({ BrowserWindow }, payload) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send("agents:updated", payload.chatId, payload.agents);
    for (const consult of payload.consults) contents.send("consult:updated", consult);
    contents.send("chat:updated", { ...payload.chat, status: "working", lastActiveAt: Date.now() });
    for (const event of payload.events) contents.send("chat:event", event);
  }, { chat, chatId: chat.id, agents, consults, events });

  const master = page.locator('[data-testid="chat-header-title-row"] [data-testid="working-indicator"]');
  await master.waitFor();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="chat-header-title-row"] [data-testid="working-indicator"]`)?.getAttribute("data-colors") === "gpt,gemini", chat.id);
  const masterColors = await master.getAttribute("data-colors");
  check("master mixes active running worker colors", masterColors === "gpt,gemini", masterColors);
  check("master excludes released and idle workers", masterColors === "gpt,gemini", masterColors);

  await page.waitForFunction(() => document.querySelectorAll('[data-testid="team-chip"] [data-testid="working-indicator"]').length >= 3);
  const chipColors = await page.locator('[data-testid="team-chip"]').evaluateAll((chips) => Object.fromEntries(chips.map((chip) => [
    chip.getAttribute("data-role"), chip.querySelector('[data-testid="working-indicator"]')?.getAttribute("data-colors") ?? null,
  ])));
  check("worker chips use each worker kind color", chipColors.w1 === "gpt" && chipColors.w2 === "gemini" && chipColors.w3 === "deepseek", JSON.stringify(chipColors));
  check("idle active worker has no working indicator", chipColors.w4 === null, JSON.stringify(chipColors));

  const planIndicator = page.locator('[data-testid="plan-step"][data-status="inProgress"] [data-testid="working-indicator"]');
  await planIndicator.waitFor();
  check("plan step nickname resolves to worker color", await planIndicator.getAttribute("data-colors") === "gemini", await planIndicator.getAttribute("data-colors"));

  const group = page.getByTestId("task-list-group");
  await group.waitFor();
  check("pending tool group uses worker color", await group.locator('[data-testid="working-indicator"]').getAttribute("data-colors") === "gpt");
  await group.getByTestId("task-list-toggle").click();
  const pendingTools = group.getByTestId("tool-card");
  const pendingToolColors = await pendingTools.locator('[data-testid="working-indicator"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-colors")));
  check("each pending ToolCard uses the worker color", (await pendingTools.count()) === 2 && pendingToolColors.every((color) => color === "gpt"), JSON.stringify(pendingToolColors));

  const animationName = await master.locator(".working-orbit").evaluate((el) => getComputedStyle(el).animationName);
  check("working orbit uses the working-orbit animation", animationName === "working-orbit", animationName);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedAnimationName = await master.locator(".working-orbit").evaluate((el) => getComputedStyle(el).animationName);
  check("reduced motion disables the working orbit", reducedAnimationName === "none", reducedAnimationName);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.screenshot({ path: join(base, "ui.png") });

  const geminiDone = { ...consults[1], status: "done", responseSummary: "fixture done", endedAt: Date.now() };
  await app.evaluate(({ BrowserWindow }, consult) => BrowserWindow.getAllWindows()[0].webContents.send("consult:updated", consult), geminiDone);
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-header-title-row"] [data-testid="working-indicator"]')?.getAttribute("data-colors") === "gpt");
  const afterGemini = await master.getAttribute("data-colors");
  check("master drops a completed consult color", afterGemini === "gpt", afterGemini);
  check("no renderer page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("working indicator UI regression completes", false, error instanceof Error ? error.stack ?? error.message : String(error));
  await page?.screenshot({ path: join(base, "ui.png") }).catch(() => undefined);
} finally {
  await app?.close().catch(() => undefined);
}

const failed = results.filter((result) => !result.ok);
writeFileSync(join(base, "result.json"), JSON.stringify({ passed: failed.length === 0, at: new Date().toISOString(), checks: results, rendererErrors: errors }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;

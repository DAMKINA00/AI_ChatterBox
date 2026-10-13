// V3 stage e2e, run against the packaged portable exe (CDP) — or the built app when no exe is given:
//  - v1 data migrates into a "가져온 세션" project
//  - the bug-fix collaboration scenario works from the exe
//  - quit + relaunch, then a follow-up instruction continues the same chat
//  - message search, usage display, orchestrator switch (Claude → GPT) on an existing chat
//  - no app/CLI processes left behind
// Usage: node scripts/e2e-v3.mjs [path\to\AI_ChatterBox-<ver>-portable.exe]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { makeChecks, scratchDir, launch, launchPortable, DEFAULTS, waitIdle, send, lastAgentText, shot, snapshot, leftovers } from "./e2e-lib.mjs";

const exe = process.argv[2] ? resolve(process.argv[2]) : null;
const { check, finish } = makeChecks();
const base = scratchDir("e2e-v3");
const data = join(base, "data");
mkdirSync(data, { recursive: true });

// ---- seed a v0.1 database (workspaces → sessions → events)
{
  const db = new DatabaseSync(join(data, "chatterbox.db"));
  db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, agent TEXT NOT NULL, native_id TEXT, title TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
  `);
  const old = join(base, "old-workspace");
  mkdirSync(old, { recursive: true });
  db.prepare("INSERT INTO workspaces VALUES (1, ?, 'old-workspace', ?)").run(old, Date.now() - 86400000);
  db.prepare("INSERT INTO sessions VALUES (1, 1, 'claude', 'v1-session', 'v1에서 하던 대화', ?, 'idle', ?, ?)").run(old, Date.now() - 86400000, Date.now() - 86000000);
  db.prepare("INSERT INTO events (session_id, at, type, data) VALUES (1, ?, 'user', ?)").run(Date.now() - 86400000, JSON.stringify({ type: "user", text: "예전 질문입니다" }));
  db.prepare("INSERT INTO events (session_id, at, type, data) VALUES (1, ?, 'text', ?)").run(Date.now() - 86300000, JSON.stringify({ type: "text", text: "예전 답변입니다" }));
  db.close();
}

const CALC = "function sum(nums) {\n  let total = 0;\n  for (let i = 1; i < nums.length; i++) total += nums[i];\n  return total;\n}\n\nmodule.exports = { sum };\n";
const TEST = 'const assert = require("assert");\nconst { sum } = require("./calc");\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(sum([]), 0);\nconsole.log("ok");\n';
const dir = join(base, "fix");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "calc.js"), CALC);
writeFileSync(join(dir, "test.js"), TEST);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix", private: true, type: "commonjs" }));
const testsPass = () => {
  try {
    return execFileSync(process.execPath, ["test.js"], { cwd: dir, encoding: "utf8" }).includes("ok");
  } catch {
    return false;
  }
};

const before = snapshot();
async function open() {
  if (exe) return launchPortable(exe, data);
  const { app, page } = await launch(data);
  return { page, close: () => app.close() };
}

let { page, close } = await open();
check(`app starts${exe ? " from the portable exe" : ""}`, true);

// ---- v1 migration
const projects = await page.evaluate(() => window.chatterbox.listProjects());
const imported = projects.find((p) => p.name.startsWith("가져온 세션"));
check("v1 workspace imported as a project", !!imported, projects.map((p) => p.name).join(", "));
const chats = await page.evaluate(() => window.chatterbox.listChats());
const v1chat = chats.find((c) => c.title === "v1에서 하던 대화");
check("v1 session imported as a chat that resumes the old CLI session", v1chat?.orchClaudeSessionId === "v1-session");
await page.locator(`[data-testid="chat-node"][data-chat-id="${v1chat.id}"] [role="treeitem"]`).click();
await page.waitForSelector('[data-testid="user-message"]');
check("v1 history shown", (await page.textContent('[data-testid="timeline"]')).includes("예전 답변입니다"));

// ---- collaboration scenario from the exe
const p = await page.evaluate(([f, s]) => window.chatterbox.createProject({ name: "exe 시나리오", folder: f, settings: s }), [dir, DEFAULTS]);
const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
await page.reload();
await page.waitForSelector('[data-testid="sidebar"]');
await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
await page.waitForSelector('[data-testid="chat-title"]');
await send(page, "calc.js에 버그가 있어서 node test.js 가 실패해. 고쳐줘.");
await waitIdle(page, { timeout: 1_500_000, approve: "chat" });
const consults = await page.evaluate((id) => window.chatterbox.listConsults(id), c.id);
check("exe: implementation delegated and reviewed", consults.some((x) => x.kind === "implement") && consults.some((x) => x.kind === "review"), consults.map((x) => `${x.kind}->${x.toRole}`).join(", "));
check("exe: tests pass after the fix", testsPass());
check("exe: final report", (await lastAgentText(page, "orch")).length > 20);
await page.waitForTimeout(2000);
const usage = await page.$$eval('[data-testid="usage-bar"]', (els) => els.map((e) => e.textContent));
check("usage shown for Claude and GPT", usage.length >= 2 && !usage[0].endsWith("–") && !usage[1].endsWith("–"), usage.join(" | "));
await shot(page, "v3-exe-scenario.png");

// ---- quit, relaunch, continue
await close();
await new Promise((r) => setTimeout(r, 1500));
({ page, close } = await open());
await page.waitForSelector('[data-testid="chat-title"]');
check("relaunch reopens the last chat", (await page.textContent('[data-testid="chat-title"]')).includes("calc.js"));
await send(page, "방금 어떤 함수의 어떤 부분을 고쳤는지 한 문장으로 다시 알려 줘. 작업자는 부르지 마.");
await waitIdle(page, { timeout: 600_000 });
const followUp = await lastAgentText(page, "orch");
check("follow-up after relaunch remembers the fix", /sum/.test(followUp) && /(1|0|인덱스|시작)/.test(followUp), followUp.slice(0, 160));

// ---- search by message content
await page.getByLabel("채팅 검색").fill("예전 답변");
await page.waitForTimeout(600);
const found = await page.locator('[data-testid="chat-node"]').allTextContents();
check("message search finds the chat", found.length === 1 && found[0].includes("v1에서 하던 대화"), found.join(" | "));
await page.getByLabel("검색 지우기").click();

// ---- switch the orchestrator to GPT on the existing chat
await page.evaluate(([id, s]) => window.chatterbox.updateProject(id, { settings: { ...s, orchestratorModel: "codex:gpt-6-astra" } }), [p.id, p.settings]);
await page.reload();
await page.waitForSelector('[data-testid="chat-title"]');
check("header shows the GPT orchestrator", (await page.textContent('[data-testid="orch-badge"]')).includes("GPT"));
await send(page, "test.js에 있는 테스트 개수를 숫자로만 답해. 작업자는 부르지 마.");
await waitIdle(page, { timeout: 600_000 });
const chatNow = (await page.evaluate(() => window.chatterbox.listChats())).find((x) => x.id === c.id);
check("GPT orchestrator answered on the same chat", !!chatNow.orchCodexThreadId && /2|두/.test(await lastAgentText(page, "orch")), await lastAgentText(page, "orch"));
await shot(page, "v3-orchestrator-switch.png");

await close();
await new Promise((r) => setTimeout(r, 2000));
const left = leftovers(before, /^(claude|codex|AI_ChatterBox)\.exe$/i);
check("no app/CLI processes left after quit", left.length === 0, left.join(", "));
finish();

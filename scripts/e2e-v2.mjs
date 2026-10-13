// V2 stage e2e: collaboration against the real CLIs.
//  A. Claude orchestrator: "fix this bug" → implement consult → cross review → final report; tree shows consult nodes;
//     an extra instruction sent mid-work is delivered.
//  B. GPT (Codex) orchestrator: same scenario on a fresh copy.
//  C. Limits: maxConsults=1 → the second consult is refused and the orchestrator still reports.
//  D. Stop: stopping mid-consult stops both agents.
// Usage: npm run build && node scripts/e2e-v2.mjs [A B C D]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, scratchDir, launch, DEFAULTS, waitIdle, send, lastAgentText, shot, countProcs } from "./e2e-lib.mjs";

const only = new Set(process.argv.slice(2));
const run = (k) => only.size === 0 || only.has(k);
const { check, finish } = makeChecks();
const base = scratchDir("e2e-v2");
const data = join(base, "data");

const CALC = `function sum(nums) {
  let total = 0;
  for (let i = 1; i < nums.length; i++) total += nums[i];
  return total;
}

function average(nums) {
  return sum(nums) / nums.length;
}

module.exports = { sum, average };
`;
const TEST = `const assert = require("assert");
const { sum, average } = require("./calc");
assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(sum([]), 0);
assert.strictEqual(average([2, 4]), 3);
console.log("ok");
`;
function fixture(name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calc.js"), CALC);
  writeFileSync(join(dir, "test.js"), TEST);
  // The scratch folder sits inside this repo, whose package.json says "type": "module".
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: name, private: true, type: "commonjs" }));
  return dir;
}
function testsPass(dir) {
  try {
    return execFileSync(process.execPath, ["test.js"], { cwd: dir, encoding: "utf8" }).includes("ok");
  } catch {
    return false;
  }
}

const before = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe") };
let { app, page } = await launch(data);

async function newProject(name, folder, settings) {
  const p = await page.evaluate(([n, f, s]) => window.chatterbox.createProject({ name: n, folder: f, settings: s }), [name, folder, settings]);
  const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
  await page.waitForSelector('[data-testid="chat-title"]');
  return { project: p, chat: c };
}

async function consultsOf(chatId) {
  return page.evaluate((id) => window.chatterbox.listConsults(id), chatId);
}

const FIX = "calc.js에 버그가 있어서 node test.js 가 실패해. 고쳐줘.";

async function scenario(label, orchestratorModel, dirName) {
  const dir = fixture(dirName);
  check(`${label}: fixture test fails before`, !testsPass(dir));
  const { chat } = await newProject(`버그 수정 (${label})`, dir, { ...DEFAULTS, orchestratorModel });
  await send(page, FIX);
  // Extra instruction while the team works (delivered at the next boundary).
  await page.waitForSelector('[data-testid="consult-card"]', { timeout: 300_000 });
  await send(page, "최종 보고 첫 줄에 '수정 완료'라고 써 줘.");
  await page.waitForTimeout(500);
  check(`${label}: extra instruction accepted while working`, (await page.getByText("작업 중 추가 지시").count()) >= 1);
  const { approvals } = await waitIdle(page, { timeout: 1_500_000, approve: "chat" });
  const consults = await consultsOf(chat.id);
  const impl = consults.filter((c) => c.kind === "implement");
  const reviews = consults.filter((c) => c.kind === "review");
  check(`${label}: implementation delegated to a worker`, impl.length >= 1 && impl.every((c) => c.fromRole === "orch"), JSON.stringify(consults.map((c) => `${c.kind}->${c.toRole}:${c.status}`)));
  check(`${label}: cross review by the other worker`, reviews.some((r) => impl.some((i) => i.toRole !== r.toRole)), JSON.stringify(consults.map((c) => `${c.kind}->${c.toRole}`)));
  check(`${label}: worker reported changed files`, impl.some((c) => c.filesChanged.some((f) => /calc\.js$/.test(f))), JSON.stringify(impl.map((c) => c.filesChanged)));
  check(`${label}: tests pass after the team's fix`, testsPass(dir));
  const report = await lastAgentText(page, "orch");
  check(`${label}: final report from the orchestrator`, report.length > 20, report.slice(0, 160));
  check(`${label}: extra instruction delivered`, /수정 완료/.test(report), report.slice(0, 80));
  check(`${label}: consult cards show who asked whom`, (await page.locator('[data-testid="consult-card"]').count()) >= 2 && (await page.locator('[data-testid="consult-card"]').first().textContent()).includes("오케스트레이터"));
  // tree
  const node = page.locator(`[data-testid="chat-node"][data-chat-id="${chat.id}"]`);
  await node.getByLabel("펼치기").click();
  await page.waitForTimeout(500);
  const labels = await node.locator('[data-testid="tree-node"]').allTextContents();
  check(`${label}: tree shows conversations and consult nodes`, labels.some((l) => l.includes("오케스트레이터 대화")) && labels.filter((l) => l.startsWith("협의")).length >= 2, labels.join(" | "));
  await shot(page, `v2-${dirName}.png`);
  // open one consult node
  await node.locator('[data-testid="tree-node"]', { hasText: "협의 1" }).click();
  await page.waitForTimeout(500);
  check(`${label}: consult node view opens`, (await page.textContent("header")).includes("협의 1"));
  await shot(page, `v2-${dirName}-consult.png`);
  console.log(`   (${label}: approvals answered: ${approvals})`);
  return chat;
}

if (run("A")) await scenario("Claude 오케스트레이터", "claude:opus", "fix-claude");
if (run("B")) await scenario("GPT 오케스트레이터", "codex:gpt-6-astra", "fix-gpt");

if (run("C")) {
  const dir = fixture("limit");
  const { chat } = await newProject("한도 테스트", dir, { ...DEFAULTS, maxConsults: 1 });
  await send(page, FIX + " 구현은 한 작업자에게 맡기고, 끝나면 다른 작업자에게 리뷰를 꼭 맡겨.");
  await waitIdle(page, { timeout: 1_200_000, approve: "chat" });
  const consults = await consultsOf(chat.id);
  check("limit: only one consult ran", consults.length === 1, consults.length);
  check("limit: refusal shown in the chat", (await page.getByText(/위임 거절/).count()) >= 1);
  check("limit: orchestrator still reports", (await lastAgentText(page, "orch")).length > 10);
}

if (run("D")) {
  const dir = fixture("stop");
  const { chat } = await newProject("중지 테스트", dir, DEFAULTS);
  await send(page, "calc.js 전체를 TypeScript로 옮기고 JSDoc 주석을 아주 자세히 달아 줘. 구현은 GPT 작업자에게 맡겨.");
  await page.waitForSelector('[data-testid="consult-card"][data-status="running"]', { timeout: 300_000 });
  await page.waitForTimeout(3000);
  await page.getByTestId("stop").click();
  await page.waitForSelector('[data-testid="working"]', { state: "detached", timeout: 60_000 });
  const c = (await page.evaluate(() => window.chatterbox.listChats())).find((x) => x.id === chat.id);
  const consults = await consultsOf(chat.id);
  check("stop: chat is idle after stop", c.status === "idle", c.status);
  check("stop: running consult marked stopped", consults.every((x) => x.status !== "running"), JSON.stringify(consults.map((x) => x.status)));
  check("stop: '중지됨' shown", (await page.getByText("중지됨").count()) >= 1);
}

await app.close();
await new Promise((r) => setTimeout(r, 1500));
const after = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe") };
check("no CLI processes left after quit", after.claude <= before.claude && after.codex <= before.codex, JSON.stringify({ before, after }));
finish();

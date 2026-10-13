// Slash commands e2e against the real CLIs, for both orchestrator types (E2E_ORCH=claude|codex to pick one):
//  - "/" opens the command menu (filterable, Esc closes); unknown commands are rejected locally
//  - /plan → plan checklist proposed (no consults) → 실행 → checklist reaches all done, task done
//  - /goal → goal bar, progress, auto-continuation until complete
//  - /status opens the status dialog
// Usage: npm run build && node scripts/e2e-commands.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, scratchDir, launch, DEFAULTS, waitIdle, send, lastAgentText, shot, snapshot, leftovers, descendants, stillAlive } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = scratchDir(process.env.E2E_NAME ?? "e2e-commands");
const data = join(base, "data");
const CALC = "function sum(nums) {\n  let total = 0;\n  for (let i = 1; i < nums.length; i++) total += nums[i];\n  return total;\n}\n\nmodule.exports = { sum };\n";
const TEST = 'const assert = require("assert");\nconst { sum } = require("./calc");\nassert.strictEqual(sum([1, 2, 3]), 6);\nconsole.log("ok");\n';
function fixture(name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calc.js"), CALC);
  writeFileSync(join(dir, "test.js"), TEST);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, type: "commonjs" }));
  return dir;
}
const testsPass = (dir) => {
  try {
    return execFileSync(process.execPath, ["test.js"], { cwd: dir, encoding: "utf8" }).includes("ok");
  } catch {
    return false;
  }
};

const before = snapshot();
let { app, page } = await launch(data);
async function openChat(name, folder, settings) {
  const p = await page.evaluate(([n, f, s]) => window.chatterbox.createProject({ name: n, folder: f, settings: s }), [name, folder, settings]);
  const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
  await page.waitForSelector('[data-testid="chat-title"]');
  return c;
}
const chatOf = async (id) => (await page.evaluate(() => window.chatterbox.listChats())).find((x) => x.id === id);

let menuChecked = false;
for (const [label, orch] of [
  ["Claude 오케스트레이터", "claude:opus"],
  ["GPT 오케스트레이터", "codex:gpt-6-astra"],
]) {
  if (process.env.E2E_ORCH && !orch.startsWith(process.env.E2E_ORCH)) continue;
  const tag = orch.split(":")[0];

  // ---- menu + unknown command (once)
  const dirPlan = fixture(`plan-${tag}`);
  const c1 = await openChat(`/plan (${label})`, dirPlan, { ...DEFAULTS, orchestratorModel: orch });
  if (!menuChecked) {
    menuChecked = true;
    const box = page.getByLabel("메시지 입력");
    await box.fill("/");
    await page.waitForSelector('[data-testid="slash-menu"]');
    const all = await page.locator('[data-testid="slash-menu"] [role="option"]').count();
    await box.fill("/pl");
    const filtered = await page.locator('[data-testid="slash-menu"] [role="option"]').allTextContents();
    check("slash menu opens and filters", all >= 8 && filtered.length === 1 && filtered[0].includes("/plan"), `${all} → ${filtered.join(",")}`);
    await box.press("Escape");
    check("Esc closes the menu", (await page.locator('[data-testid="slash-menu"]').count()) === 0);
    await box.fill("/frobnicate now");
    await box.press("Enter");
    await page.waitForTimeout(500);
    check("unknown command rejected locally", (await page.getByText("알 수 없는 명령: /frobnicate").count()) >= 1 && (await page.locator('[data-testid="user-message"]').count()) === 0);
    await box.fill("/status");
    await box.press("Enter");
    await page.waitForTimeout(500);
    check("/status opens the status dialog", (await page.getByRole("dialog").getByText("채팅 상태").count()) === 1);
    await page.keyboard.press("Escape");
  }

  // ---- /plan → 실행
  await send(page, "/plan calc.js 의 sum 버그를 고치고, 곱셈 함수 multiply(a, b) 를 추가하고, test.js 에 multiply 테스트를 넣어 node test.js 가 통과하게 하기");
  await waitIdle(page, { timeout: 900_000, approve: "once" });
  await page.waitForSelector('[data-testid="plan-panel"][data-state="proposed"]', { timeout: 20_000 }).catch(() => undefined);
  const steps = await page.locator('[data-testid="plan-step"]').count();
  const consultsAfterPlan = (await page.evaluate((id) => window.chatterbox.listConsults(id), c1.id)).length;
  check(`${label}: /plan proposes a checklist`, steps >= 2 && (await page.locator('[data-testid="plan-panel"][data-state="proposed"]').count()) === 1, `steps=${steps}`);
  check(`${label}: /plan did not delegate or change files`, consultsAfterPlan === 0 && readFileSync(join(dirPlan, "calc.js"), "utf8") === CALC, `consults=${consultsAfterPlan}`);
  await shot(page, `v023-plan-proposed-${tag}.png`);
  await page.getByTestId("plan-run").click();
  const { approvals } = await waitIdle(page, { timeout: 1_800_000, approve: "once", answer: "네, 진행하세요." });
  await page.waitForTimeout(800);
  const statuses = await page.locator('[data-testid="plan-step"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
  check(`${label}: checklist reaches all done`, statuses.length >= 2 && statuses.every((s) => s === "completed"), statuses.join(","));
  const calc = readFileSync(join(dirPlan, "calc.js"), "utf8");
  check(`${label}: plan executed (tests pass, multiply added)`, testsPass(dirPlan) && /multiply/.test(calc), `approvals clicked=${approvals}`);
  await shot(page, `v023-plan-done-${tag}.png`);

  // ---- /goal
  const dirGoal = fixture(`goal-${tag}`);
  const c2 = await openChat(`/goal (${label})`, dirGoal, { ...DEFAULTS, orchestratorModel: orch });
  await send(page, "/goal calc.js 의 sum 버그를 고치고, subtract(a, b) 와 divide(a, b) 를 추가하고(0으로 나누면 에러), test.js 에 둘의 테스트를 넣어 node test.js 가 통과하게 하기");
  await page.waitForSelector('[data-testid="goal-bar"]', { timeout: 30_000 });
  // The goal may take several orchestrator turns (auto-continuation); wait until it leaves "active".
  const end = Date.now() + 2_400_000;
  let status = "active";
  while (Date.now() < end) {
    await waitIdle(page, { timeout: 1_200_000, approve: "once", answer: "네, 진행하세요." }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const ch = await chatOf(c2.id);
    status = ch.goal?.status ?? "none";
    if (status !== "active" && ch.status !== "working") break;
  }
  const g = (await chatOf(c2.id)).goal;
  check(`${label}: /goal reaches complete`, g?.status === "complete", `${g?.status} after ${g?.turns} turn(s)`);
  check(`${label}: goal progress shown`, (await page.locator('[data-testid="goal-progress"]').count()) === 1 && !!g?.progress);
  const calc2 = readFileSync(join(dirGoal, "calc.js"), "utf8");
  check(`${label}: goal work done (tests pass, subtract/divide)`, testsPass(dirGoal) && /subtract/.test(calc2) && /divide/.test(calc2));
  await shot(page, `v023-goal-${tag}.png`);
  await send(page, "/goal clear");
  await page.waitForTimeout(800);
  check(`${label}: /goal clear removes the goal`, !(await chatOf(c2.id)).goal && (await page.locator('[data-testid="goal-bar"]').count()) === 0);
}

const tracked = descendants(app.process().pid);
await app.close();
await new Promise((r) => setTimeout(r, 2000));
const left = stillAlive(tracked);
check("no CLI processes left after quit", left.length === 0, left.join(", "));
finish();

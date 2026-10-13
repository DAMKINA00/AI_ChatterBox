// v0.3 team e2e against the real CLIs (isolated data, off-screen window):
//  - a two-part task: the master spawns ≥2 클로드 with disjoint scopes running in parallel, a worker
//    asks another worker by nickname, 지피티 reviews; tests pass
//  - an out-of-scope write is auto-denied
//  - a cycle attempt is refused
// Usage: npm run build && node scripts/e2e-team.mjs   (E2E_ORCH=codex for a GPT master)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeChecks, scratchDir, launch, DEFAULTS, waitIdle, send, lastAgentText, shot, snapshot, leftovers, descendants, stillAlive } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const orch = process.env.E2E_ORCH === "codex" ? "codex:gpt-6-astra" : "claude:opus";
const base = scratchDir(process.env.E2E_NAME ?? `e2e-team-${orch.split(":")[0]}`);
const data = join(base, "data");
const dir = join(base, "proj");
mkdirSync(join(dir, "lib"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "team", private: true, type: "commonjs" }));
writeFileSync(join(dir, "README.md"), "# team fixture\n");
writeFileSync(join(dir, "lib", "math.js"), "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n");
writeFileSync(join(dir, "lib", "strings.js"), "function capitalize(s) {\n  return s.toUpperCase();\n}\n\nmodule.exports = { capitalize };\n");
writeFileSync(join(dir, "test", "math.test.js"), 'const assert = require("assert");\nconst m = require("../lib/math");\nassert.strictEqual(m.add(2, 3), 5);\n');
writeFileSync(join(dir, "test", "strings.test.js"), 'const assert = require("assert");\nconst s = require("../lib/strings");\nassert.strictEqual(s.capitalize("hello"), "Hello");\n');
writeFileSync(join(dir, "test", "run.js"), 'require("./math.test");\nrequire("./strings.test");\nconsole.log("ok");\n');
const testsPass = () => {
  try {
    return execFileSync(process.execPath, ["test/run.js"], { cwd: dir, encoding: "utf8" }).includes("ok");
  } catch {
    return false;
  }
};
check("fixture tests fail before", !testsPass());

const before = snapshot();
let { app, page } = await launch(data);
const p = await page.evaluate(([f, s]) => window.chatterbox.createProject({ name: "팀 작업", folder: f, settings: s }), [dir, { ...DEFAULTS, orchestratorModel: orch }]);
const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
await page.reload();
await page.waitForSelector('[data-testid="sidebar"]');
await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
await page.waitForSelector('[data-testid="chat-title"]');

// ---- 1. parallel team work
await send(
  page,
  "lib/math.js 와 lib/strings.js 의 버그를 고치고 함수를 하나씩 추가해 줘 (math: mul(a, b), strings: reverse(s)). " +
    "테스트도 test/math.test.js, test/strings.test.js 에 추가하고 node test/run.js 가 통과해야 해. " +
    "일이 두 갈래이니 클로드 작업자 두 명을 만들어 범위를 나눠 동시에 구현하게 해: math 담당 scope=[\"lib/math.js\",\"test/math.test.js\"], strings 담당 scope=[\"lib/strings.js\",\"test/strings.test.js\"]. " +
    "strings 담당에게는 구현 전에 math 담당에게 ask로 함수 이름 규칙(동사형인지)을 한 번 물어보라고 알려 줘. " +
    "구현이 끝나면 지피티 작업자를 만들어 전체 변경을 리뷰하게 해.",
);
let sawChips = false;
const chipPoll = setInterval(async () => {
  try {
    if ((await page.locator('[data-testid="team-chip"]').count()) >= 2) sawChips = true;
  } catch {}
}, 2000);
await waitIdle(page, {
  timeout: 2_400_000,
  approve: "once",
  answer: "네, 진행하세요.",
  onApproval: async () => undefined,
});
clearInterval(chipPoll);
const team = await page.evaluate((id) => window.chatterbox.listAgents(id), c.id);
const consults = await page.evaluate((id) => window.chatterbox.listConsults(id), c.id);
const claudes = team.filter((a) => a.kind === "claude");
const gpts = team.filter((a) => a.kind === "gpt");
check("master spawned ≥2 클로드 and ≥1 지피티", claudes.length >= 2 && gpts.length >= 1, team.map((a) => a.nickname).join(", "));
const impl = consults.filter((x) => x.kind === "implement" && x.fromRole === "orch");
const overlap = impl.some((a, i) => impl.some((b, j) => i < j && a.toRole !== b.toRole && a.startedAt < (b.endedAt ?? Infinity) && b.startedAt < (a.endedAt ?? Infinity)));
check("two implement asks ran in parallel", overlap, impl.map((x) => `${x.toRole}:${x.startedAt % 100000}-${(x.endedAt ?? 0) % 100000}`).join(" "));
check("implement asks carried disjoint scopes", impl.filter((x) => x.scope.length).length >= 2, impl.map((x) => x.scope.join("|")).join(" / "));
const w2w = consults.filter((x) => x.fromRole !== "orch");
check("a worker asked another worker by nickname", w2w.length >= 1, w2w.map((x) => `${x.fromRole}→${x.toRole}`).join(", "));
check("review by 지피티", consults.some((x) => x.kind === "review" && gpts.some((g) => g.key === x.toRole)));
check("tests pass after the team's work", testsPass(), readFileSync(join(dir, "lib", "strings.js"), "utf8").slice(0, 80));
check("team chips shown in the header while working", sawChips);
const cardText = await page.locator('[data-testid="consult-card"]').first().textContent();
check("consult card reads 마스터 → 클로드 N호", /마스터.*클로드 \d호/.test(cardText ?? ""), cardText?.slice(0, 80));
const node = page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"]`);
await node.getByLabel("펼치기").click();
await page.waitForTimeout(500);
const labels = await node.locator('[data-testid="tree-node"]').allTextContents();
check("tree lists 마스터, workers and consults (from → to)", labels.some((l) => l.includes("마스터 대화")) && labels.some((l) => /클로드 2호/.test(l)) && labels.some((l) => /협의 \d+ · .+ → .+/.test(l)), labels.join(" | "));
await shot(page, `v030-team-${orch.split(":")[0]}.png`);

// ---- 2. out-of-scope write is denied
const readmeBefore = readFileSync(join(dir, "README.md"), "utf8");
await send(
  page,
  "범위 확인용 테스트야: 클로드 1호에게 scope=[\"lib/math.js\"] 로 맡기면서, lib/math.js 맨 위에 주석 한 줄을 넣고 README.md 에도 '테스트' 라는 줄을 추가하라고 해. 거부되면 다시 시도하지 말고 결과만 보고해.",
);
await waitIdle(page, { timeout: 1_200_000, approve: "deny", answer: "네, 진행하세요." });
const ev = await page.evaluate((id) => window.chatterbox.loadEvents(id), c.id);
const scopeDenied = ev.filter((e) => e.event.type === "approval_auto" && e.event.decision === "deny" && /범위/.test(e.event.reason));
check("out-of-scope write auto-denied", scopeDenied.length >= 1 && readFileSync(join(dir, "README.md"), "utf8") === readmeBefore, scopeDenied.map((e) => e.event.reason).join(" | "));
await shot(page, `v030-scope-${orch.split(":")[0]}.png`);

// ---- 3. a cycle is refused
await send(
  page,
  "교착 방지 확인용 테스트야: 클로드 1호에게 kind=opinion 으로 '클로드 2호에게 ask(kind=opinion)로 \"1+1은?\"을 물어본 뒤 답을 보고하라'고 맡겨. " +
    "단 클로드 2호에게는 미리 kind=opinion 으로 '누가 질문하면 답하기 전에 반드시 그 질문한 사람에게 ask로 되물어라'고 먼저 알려 둬. 거부 메시지가 나오면 그대로 보고해.",
);
await waitIdle(page, { timeout: 1_200_000, approve: "deny", answer: "네, 진행하세요." });
const ev2 = await page.evaluate((id) => window.chatterbox.loadEvents(id), c.id);
const refused = ev2.some((e) => e.event.type === "notice" && /교착 방지/.test(e.event.text));
check("a cycle attempt is refused (교착 방지)", refused, (await lastAgentText(page, "orch")).slice(0, 120));

const tracked = descendants(app.process().pid);
await app.close();
await new Promise((r) => setTimeout(r, 2000));
const left = stillAlive(tracked);
check("no CLI processes left after quit", left.length === 0, left.join(", "));
finish();

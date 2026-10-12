// End-to-end check of M1 against the real CLIs: launches the built app with Playwright,
// chats with Claude and Codex (2 turns each, one approval denied), quits, relaunches,
// resumes both sessions and checks the context carried over. Screenshots go to docs/.
// Usage: npm run e2e   (uses a scratch data dir, not %APPDATA%\AI_ChatterBox)
import { _electron as electron } from "playwright-core";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".scratch", "e2e");
const dataDir = join(scratch, "data");
const wsDir = join(scratch, "workspace");
const docs = join(root, "docs");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(wsDir, { recursive: true });
mkdirSync(docs, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const countProcs = (name) => {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith(name)).length;
  } catch {
    return 0;
  }
};

async function launch() {
  const app = await electron.launch({ args: [root], env: { ...process.env, AI_CHATTERBOX_DATA: dataDir } });
  const page = await app.firstWindow();
  page.on("console", (m) => m.type() === "error" && console.log("[renderer]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  app.process().stdout?.on("data", (d) => process.stdout.write(`[main] ${d}`));
  await page.waitForSelector(".sidebar");
  return { app, page };
}

async function sendAndWait(page, text, { onApproval } = {}) {
  const box = page.getByLabel("메시지 입력");
  await box.waitFor({ timeout: 10_000 }).catch(async (e) => {
    await page.screenshot({ path: join(scratch, "failure.png") });
    throw e;
  });
  await box.fill(text);
  await box.press("Enter");
  await page.waitForSelector(".working", { timeout: 30_000 });
  const deadline = Date.now() + 240_000;
  let approvals = 0;
  while (Date.now() < deadline) {
    if (!(await page.$(".working"))) break;
    const card = await page.$(".approval:not(.done)");
    if (card && onApproval) {
      approvals++;
      await (await card.$(`button.${onApproval}`)).click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(300);
  }
  if (await page.$(".working")) {
    await page.screenshot({ path: join(scratch, "failure.png") });
    throw new Error(`turn did not finish: ${text}`);
  }
  const texts = await page.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent ?? ""));
  return { last: texts[texts.length - 1] ?? "", approvals };
}

async function openSession(page, agent, index = 0) {
  await page.locator(`.group.${agent} li button`).nth(index).click();
  await page.waitForSelector(".chat");
  await page.waitForTimeout(500);
}

// ---------- run 1
const before = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe") };
let { app, page } = await launch();
await page.evaluate((p) => window.chatterbox.addWorkspace(p), wsDir);
await page.reload();
await page.waitForSelector(".sidebar");

// Claude
await page.getByLabel("새 Claude 세션").click();
let r = await sendAndWait(page, "코드워드 '바나나-77'을 기억해 줘. 다른 말 없이 '확인'이라고만 답해.");
check("claude turn 1 reply", r.last.includes("확인"), r.last);
r = await sendAndWait(
  page,
  "Write 도구로 현재 폴더에 note.txt 파일을 만들고 내용은 hi 로 해 줘. 거부되면 다시 시도하지 말고 'DENIED'라고만 답해.",
  { onApproval: "deny" },
);
check("claude approval card shown and denied", r.approvals >= 1, `approvals=${r.approvals}`);
check("claude file not written", !existsSync(join(wsDir, "note.txt")));
check("claude turn 2 reply", r.last.length > 0, r.last);
await page.screenshot({ path: join(docs, "m1-claude.png") });

// Codex
await page.getByLabel("새 Codex 세션").click();
r = await sendAndWait(page, "코드워드 '수박-31'을 기억해 줘. 명령은 실행하지 말고 '확인'이라고만 답해.");
check("codex turn 1 reply", r.last.includes("확인"), r.last);
r = await sendAndWait(
  page,
  "다음 명령을 그대로 한 번 실행해 줘: Invoke-WebRequest -UseBasicParsing https://example.com | Select-Object -ExpandProperty StatusCode . 승인이 거부되면 다시 시도하지 말고 'DENIED'라고만 답해.",
  { onApproval: "deny" },
);
check("codex turn 2 finished", r.last.length > 0, `${r.last} / approvals=${r.approvals}`);
await page.screenshot({ path: join(docs, "m1-codex.png") });

await app.close();
await new Promise((res) => setTimeout(res, 1500));
const after = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe") };
check(
  "no CLI processes left after quit",
  after.claude <= before.claude && after.codex <= before.codex,
  JSON.stringify({ before, after }),
);

// ---------- run 2: relaunch and resume
({ app, page } = await launch());
await openSession(page, "claude");
const history = await page.$$eval(".msg", (els) => els.length);
check("claude history restored", history >= 4, `messages=${history}`);
r = await sendAndWait(page, "아까 기억해 달라고 한 코드워드가 뭐였지? 코드워드만 답해.");
check("claude resume keeps context", r.last.includes("바나나-77"), r.last);
await page.screenshot({ path: join(docs, "m1-claude-resumed.png") });

await openSession(page, "codex");
r = await sendAndWait(page, "아까 기억해 달라고 한 코드워드가 뭐였지? 코드워드만 답해.");
check("codex resume keeps context", r.last.includes("수박-31"), r.last);
await page.screenshot({ path: join(docs, "m1-codex-resumed.png") });
await app.close();

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

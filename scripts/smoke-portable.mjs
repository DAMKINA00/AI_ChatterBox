// Smoke test of the portable exe itself. Playwright can't launch it directly (the portable
// launcher extracts to %TEMP% and starts a child), so start it with a remote debugging port
// and attach over CDP. Checks: a Claude turn with an approval card (denied), a Codex turn,
// and that quitting leaves no claude.exe / codex.exe behind.
// Usage: node scripts/smoke-portable.mjs dist\AI_ChatterBox-<ver>-portable.exe
import { chromium } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = resolve(process.argv[2] ?? join(root, "dist", "AI_ChatterBox-0.1.0-portable.exe"));
const scratch = join(root, ".scratch", "smoke-portable");
const wsDir = join(scratch, "workspace");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(wsDir, { recursive: true });
const port = 9333;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const countProcs = (name) =>
  execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf8" }).split("\n").filter((l) => l.startsWith(name)).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe"), app: countProcs("AI_ChatterBox.exe") };
const started = Date.now();
spawn(exe, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, AI_CHATTERBOX_DATA: join(scratch, "data") },
  detached: true,
  stdio: "ignore",
}).unref();

let browser;
for (let i = 0; i < 120 && !browser; i++) {
  await sleep(500);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
}
check("portable exe starts and opens a window", !!browser, `${((Date.now() - started) / 1000).toFixed(1)}s`);
if (!browser) process.exit(1);

let page;
for (let i = 0; i < 40 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
  if (!page) await sleep(250);
}
await page.waitForSelector(".sidebar");
await page.evaluate((p) => window.chatterbox.addWorkspace(p), wsDir);
await page.reload();
await page.waitForSelector(".sidebar");

async function turn(text, deny) {
  const box = page.getByLabel("메시지 입력");
  await box.fill(text);
  await box.press("Enter");
  await page.waitForSelector(".working", { timeout: 30_000 });
  let approvals = 0;
  for (const end = Date.now() + 180_000; Date.now() < end && (await page.$(".working")); ) {
    const card = await page.$(".approval:not(.done)");
    if (card && deny) {
      approvals++;
      await (await card.$("button.deny")).click();
      await sleep(500);
    }
    await sleep(300);
  }
  const texts = await page.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent ?? ""));
  return { last: texts.at(-1) ?? "", approvals };
}

await page.getByLabel("새 Claude 세션").click();
await page.waitForSelector(".chat .badge.claude");
let r = await turn("Write 도구로 현재 폴더에 note.txt 를 만들고 내용은 hi 로 해 줘. 거부되면 다시 시도하지 말고 'DENIED'라고만 답해.", true);
check("claude turn with approval card (denied)", r.approvals >= 1 && !existsSync(join(wsDir, "note.txt")), `${r.last} / approvals=${r.approvals}`);

await page.getByLabel("새 Codex 세션").click();
await page.waitForSelector(".chat .badge.codex");
r = await turn("명령은 실행하지 말고 '안녕'이라고만 답해.", false);
check("codex turn", r.last.includes("안녕"), r.last);

await page.screenshot({ path: join(scratch, "portable.png") });
await page.evaluate(() => window.close()).catch(() => undefined);
await browser.close().catch(() => undefined);
for (let i = 0; i < 40 && countProcs("AI_ChatterBox.exe") > before.app; i++) await sleep(250);
const after = { claude: countProcs("claude.exe"), codex: countProcs("codex.exe"), app: countProcs("AI_ChatterBox.exe") };
check(
  "quit leaves no app/CLI processes",
  after.claude <= before.claude && after.codex <= before.codex && after.app <= before.app,
  JSON.stringify({ before, after }),
);
process.exit(failed ? 1 : 0);

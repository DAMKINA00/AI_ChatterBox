// Requires a human to answer the Windows UAC prompt. Uses a fresh test profile.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "..");
const exe = resolve(process.argv[2] ?? join(root, "dist", "AI_ChatterBox-0.3.1-portable.exe"));
const attachBase = process.env.CBX_ADMIN_ATTACH_BASE;
const base = attachBase ? resolve(attachBase) : join(root, ".scratch", `admin-${Date.now()}`);
if (!base.startsWith(join(root, ".scratch", "admin-"))) throw new Error("Admin test profile must be inside this project's scratch directory");
const work = join(base, "workspace"), data = join(base, "data");
mkdirSync(work, { recursive: true }); mkdirSync(data, { recursive: true });
const port = 9447;
const launcher = attachBase ? undefined : spawn("pwsh.exe", ["-NoProfile", "-File", join(root, "scripts", "launch-admin-test.ps1"), "-Executable", exe, "-DataDir", data, "-Port", String(port)], { windowsHide: true, stdio: "inherit" });
let exit;
launcher?.on("exit", (code) => { exit = code; });
const checks = []; let browser, page;
try {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline && exit === undefined && !browser) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
    if (!browser) await new Promise((r) => setTimeout(r, 500));
  }
  if (!browser) throw new Error(`UAC launch not completed (exit=${exit ?? "pending"}); no fallback attempted`);
  const windowDeadline = Date.now() + 60_000;
  while (!page && Date.now() < windowDeadline) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("Elevated app did not create a renderer window");
  await page.waitForSelector('[data-testid="sidebar"]');
  // The test profile must be empty. Never continue against the user's real data.
  if ((await page.evaluate(() => window.chatterbox.listProjects())).length) throw new Error("Expected empty isolated app profile");
  const settings = { orchestratorModel: "claude:sonnet", claudeModel: "sonnet", codexModel: "gpt-6.1-sol", reviewGate: false, maxConsults: 8, maxReviews: 3, maxMinutes: 15, maxClaudeWorkers: 3, maxGptWorkers: 3, approvalMode: "user", delegateHighRisk: false };
  for (const provider of ["claude", "codex"]) {
    const p = await page.evaluate((input) => window.chatterbox.createProject(input), { name: `admin-${provider}`, folder: work, settings: { ...settings, orchestratorModel: `${provider}:${provider === "claude" ? "sonnet" : "gpt-6.1-sol"}` } });
    const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
    const file = `${provider}-admin.json`;
    const command = `$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); $admin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); fltmc.exe > $null; $code = $LASTEXITCODE; @{administrator=$admin;fltmcExitCode=$code} | ConvertTo-Json | Set-Content -LiteralPath '${file}' -Encoding utf8`;
    await page.evaluate(([id, text]) => window.chatterbox.send(id, text, []), [c.id, `관리자 실행을 확인하는 격리 테스트입니다. 작업자를 만들지 말고 다음 PowerShell 명령을 직접 실행하세요. fltmc는 조회만 하며 시스템을 변경하지 않습니다. 샌드박스에서 실패하면 필요한 앱 승인을 요청하세요. 결과를 꾸며 쓰지 말고 명령이 생성한 JSON을 그대로 두세요. 명령: ${command}`]);
    const answered = new Set(); const end = Date.now() + 300_000;
    let ended = false;
    while (Date.now() < end && !ended) {
      const events = await page.evaluate((id) => window.chatterbox.loadEvents(id), c.id);
      for (const e of events) {
        if (e.event.type === "approval_request" && !answered.has(e.event.request.id)) {
          answered.add(e.event.request.id);
          await page.evaluate(([id, ap]) => window.chatterbox.answerApproval(id, ap, "once"), [c.id, e.event.request.id]);
        }
        if (e.event.type === "turn_end") ended = true;
      }
      if (!ended) await new Promise((r) => setTimeout(r, 500));
    }
    const result = existsSync(join(work, file)) ? JSON.parse(readFileSync(join(work, file), "utf8").replace(/^\uFEFF/, "")) : null;
    const ok = ended && answered.size > 0 && result?.administrator === true && result?.fltmcExitCode === 0;
    checks.push({ provider, ok, approvals: answered.size, result });
    console.log(ok ? "PASS" : "FAIL", provider, JSON.stringify(result));
    if (!ended) await page.evaluate((id) => window.chatterbox.stop(id), c.id);
  }
} catch (error) {
  writeFileSync(join(data, "cancel-launch"), String(error));
  checks.push({ ok: false, error: String(error) }); console.error(String(error));
}
finally {
  await page?.evaluate(() => window.close()).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  writeFileSync(join(base, "results.json"), JSON.stringify(checks, null, 2));
  console.log("Evidence:", base);
  // Do not keep a timed-out UAC test launcher alive or launch later into an unattended test.
  if (!browser) launcher?.kill();
}
process.exitCode = checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1;

// Shared helpers for the Playwright e2e scripts (real CLIs, scratch data dir).
import { _electron as electron } from "playwright-core";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function scratchDir(name, { fresh = true } = {}) {
  const dir = join(root, ".scratch", name);
  if (fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeChecks() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  };
  return { check, finish };
}

export function countProcs(name) {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith(name)).length;
  } catch {
    return 0;
  }
}

/** Launch the built app (or E2E_EXE) on a scratch data dir. */
export async function launch(dataDir) {
  const exe = process.env.E2E_EXE;
  const app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [root] }),
    env: { ...process.env, AI_CHATTERBOX_DATA: dataDir },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("[renderer]", m.text()));
  await page.waitForSelector('[data-testid="sidebar"]');
  return { app, page };
}

/**
 * Launch a portable exe and attach over CDP (Playwright can't launch it directly: the portable
 * launcher extracts to %TEMP% and starts a child process).
 */
export async function launchPortable(exe, dataDir, port = 9333) {
  const { spawn } = await import("node:child_process");
  const { chromium } = await import("playwright-core");
  const before = countProcs("AI_ChatterBox.exe");
  spawn(exe, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, AI_CHATTERBOX_DATA: dataDir },
    detached: true,
    stdio: "ignore",
  }).unref();
  let browser;
  for (let i = 0; i < 180 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  }
  if (!browser) throw new Error("portable exe did not start");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 });
  return {
    page,
    async close() {
      await page.evaluate(() => window.close()).catch(() => undefined);
      await browser.close().catch(() => undefined);
      for (let i = 0; i < 80 && countProcs("AI_ChatterBox.exe") > before; i++) await new Promise((r) => setTimeout(r, 250));
    },
  };
}

export const DEFAULTS = {
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
};

/** Wait for the selected chat's turn to finish. Optionally answer approvals: "once" | "chat" | "deny". */
export async function waitIdle(page, { timeout = 600_000, approve, onApproval } = {}) {
  await page.waitForSelector('[data-testid="working"]', { timeout: 30_000 }).catch(() => undefined);
  const end = Date.now() + timeout;
  let approvals = 0;
  while (Date.now() < end) {
    if (!(await page.$('[data-testid="working"]'))) break;
    const card = await page.$('[data-testid="approval"][data-state="pending"]');
    if (card && approve) {
      approvals++;
      if (onApproval) await onApproval(card, approvals);
      let which = typeof approve === "function" ? approve(approvals) : approve;
      // High-risk requests (outside the folder, deletes, …) can only be allowed once.
      if (which === "chat" && (await card.$('[data-testid="approve-chat"]:disabled'))) which = "once";
      await (await card.$(`[data-testid="approve-${which}"]`)).click();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(300);
  }
  if (await page.$('[data-testid="working"]')) throw new Error("turn did not finish in time");
  return { approvals };
}

export async function send(page, text) {
  const box = page.getByLabel("메시지 입력");
  await box.fill(text);
  await box.press("Enter");
}

export async function lastAgentText(page, role) {
  const sel = role ? `[data-testid="agent-message"][data-role="${role}"]` : '[data-testid="agent-message"]';
  const texts = await page.$$eval(sel, (els) => els.map((e) => e.textContent ?? ""));
  return texts[texts.length - 1] ?? "";
}

export async function shot(page, name) {
  mkdirSync(join(root, "docs", "screenshots"), { recursive: true });
  await page.screenshot({ path: join(root, "docs", "screenshots", name) });
}

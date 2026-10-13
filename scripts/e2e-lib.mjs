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
      const which = typeof approve === "function" ? approve(approvals) : approve;
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

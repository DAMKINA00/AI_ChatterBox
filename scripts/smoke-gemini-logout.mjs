// Isolated Electron profiles and synthetic cookies only; no Google or AI Studio requests.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, ".scratch", `gemini-logout-${Date.now()}`);
mkdirSync(data, { recursive: true });
const main = join(data, "main.cjs");
await build({ stdin: { resolveDir: root, loader: "ts", contents: `
import { app, session, BrowserWindow } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { GeminiWebAccounts } from "./src/main/drivers/gemini-web-accounts";
const data = ${JSON.stringify(data)}, checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
app.setPath("userData", join(data, "electron"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
let pool: GeminiWebAccounts;
void app.whenReady().then(async () => {
  try {
    const sessions = [1, 2].map(n => session.fromPath(join(data, "web-accounts", "gemini-" + n)));
    for (const [n, ses] of sessions.entries()) {
      ses.protocol.handle("https", () => new Response("<!doctype html><body>offline fixture</body>", { headers: { "content-type": "text/html" } }));
      await ses.cookies.set({ url: "https://gemini.google.com", name: "fixture", value: "account-" + (n + 1), secure: true, expirationDate: Date.now() / 1000 + 3600 });
      await ses.cookies.flushStore();
    }
    const saved = new Map<string, string>();
    const settings = { getSetting: (key: string) => saved.get(key), setSetting: (key: string, value: string) => { saved.set(key, value); } };
    pool = new GeminiWebAccounts(data, settings);
    pool.add();
    pool.update("gemini-1", { label: "Retained slot" });
    const first = pool.browser("gemini-1");
    const win = new BrowserWindow({ show: false, webPreferences: { session: sessions[0] } });
    (first as any).win = win;
    await win.loadURL("https://gemini.google.com/app");
    await win.webContents.executeJavaScript("localStorage.setItem('fixture', 'private account data')");
    (first as any).setUsage({ status: "available", checkedAt: Date.now(), detail: "fixture", current: { usedPercent: 5 } });
    let unlinked = 0;
    const accounts = await pool.disconnect("gemini-1", false, async () => { unlinked++; });
    check("logout closes the target browser and keeps the named slot", win.isDestroyed() && accounts[0].label === "Retained slot" && accounts.length === 2);
    check("target profile cookies are cleared", (await sessions[0].cookies.get({})).length === 0);
    check("other account profile keeps its cookie", (await sessions[1].cookies.get({})).some(c => c.name === "fixture" && c.value === "account-2"));
    check("quota is cleared and login is required", accounts[0].state === "login_required" && accounts[0].usage.current === undefined);
    const verify = new BrowserWindow({ show: false, webPreferences: { session: sessions[0] } });
    await verify.loadURL("https://gemini.google.com/app");
    check("target origin local storage is cleared", await verify.webContents.executeJavaScript("localStorage.getItem('fixture') === null"));
    verify.destroy();
    await pool.disconnect("gemini-1", true, async () => { unlinked++; });
    check("removal frees the slot without touching its neighbor", pool.list().map(a => a.accountId).join(",") === "gemini-2");
    const reused = pool.add().find(a => a.accountId === "gemini-1")!;
    check("reused slot has a fresh name, empty usage and no old cookies", reused.label === "계정 1" && reused.usage.current === undefined && (await sessions[0].cookies.get({})).length === 0);
    await pool.disconnect("gemini-1", true, async () => {});
    await pool.disconnect("gemini-2", true, async () => {});
    await pool.dispose();
    pool = new GeminiWebAccounts(data, settings);
    check("removing the last slot persists after reopening", pool.list().length === 0 && unlinked === 2);
    await pool.dispose();
    writeFileSync(join(data, "results.json"), JSON.stringify({ checks }, null, 2));
    app.exit(0);
  } catch (error) {
    await pool?.dispose();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    writeFileSync(join(data, "results.json"), JSON.stringify({ checks, error: String(error) }, null, 2));
    app.exit(1);
  }
});
` }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error" });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let failure;
await new Promise(resolve => execFile(join(root, "node_modules", "electron", "dist", "electron.exe"), [main],
  { cwd: root, env, windowsHide: true, timeout: 60_000 }, error => { failure = error; resolve(); }));
const report = JSON.parse(readFileSync(join(data, "results.json"), "utf8"));
for (const check of report.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
console.log(`Evidence: ${data}`);
if (failure) throw Error(report.error || failure.message);
console.log(`${report.checks.length}/${report.checks.length} isolated session checks passed`);

// Real bundled WPF process, isolated settings/profiles, no model prompts or login changes.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(root, ".scratch", "hosted-usage-"));
const production = join(process.env.LOCALAPPDATA, "AIUsageMonitor", "settings.json");
const hash = () => existsSync(production) ? createHash("sha256").update(readFileSync(production)).digest("hex") : null;
const before = hash();
process.env.AIUSAGEMONITOR_DATA_DIR = join(scratch, "usage");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
process.env.CODEX_HOME = join(scratch, "codex");
mkdirSync(process.env.AIUSAGEMONITOR_DATA_DIR);
writeFileSync(join(process.env.AIUSAGEMONITOR_DATA_DIR, "settings.json"), JSON.stringify({
  StartWithWindows: false, ShowTaskbarUsage: false, Topmost: false, ShowCharacters: false,
  ClaudeDesktopEnabled: false, ClaudeWebEnabled: false, GeminiEnabled: false,
  CodexExePath: join(scratch, "missing-codex.exe"), GrokExePath: join(scratch, "missing-grok.exe"),
}));
const settingsFile = join(scratch, "desktop.json");
writeFileSync(settingsFile, JSON.stringify({ unrelated: "preserved", usageEnabled: true }));
const moduleFile = join(scratch, "companion.cjs");
await build({ entryPoints: [join(root, "src/main/usage-companion.ts")], outfile: moduleFile, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { UsageCompanion } = createRequire(import.meta.url)(moduleFile);
const exe = process.env.E2E_USAGE_EXE ?? join(root, ".scratch/usage-monitor-publish/AIUsageMonitor.exe");
let changes = 0;
const companion = new UsageCompanion({ exe, settingsFile, allowed: true, changed: () => changes++, notification() {} });
async function until(predicate) {
  const end = Date.now() + 10_000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), "expected state arrived");
}
try {
  await companion.start();
  assert.equal(companion.snapshot().state.visible, false);
  console.log("PASS hosted initial state with own tray hidden");
  const duplicate = await new Promise((resolve, reject) => {
    const child = spawn(exe, ["--hosted"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = ""; child.stdout.on("data", value => output += value); child.on("error", reject);
    child.on("exit", code => resolve({ code, output }));
  });
  assert.equal(duplicate.code, 2); assert.match(duplicate.output, /"type":"error"/);
  console.log("PASS duplicate instance rejected without closing the active monitor");
  await companion.command("show"); await until(() => companion.snapshot().state.visible);
  await companion.command("characters", true); await until(() => companion.snapshot().state.characters);
  await companion.command("characters", false); await until(() => !companion.snapshot().state.characters);
  await companion.command("hide"); await until(() => !companion.snapshot().state.visible);
  console.log("PASS real widget show/hide and setting round trips");
  await companion.setEnabled(false); assert.equal(companion.snapshot().running, false);
  assert.equal(JSON.parse(readFileSync(settingsFile)).usageEnabled, false);
  await companion.command("show"); await until(() => companion.snapshot().state.visible);
  assert.equal(companion.snapshot().enabled, true);
  assert.equal(JSON.parse(readFileSync(settingsFile)).unrelated, "preserved");
  console.log("PASS off/on stops and restarts one monitor while preserving host settings");
} finally { await companion.stop(); }
assert.equal(companion.snapshot().running, false); assert.equal(hash(), before); assert.ok(changes > 3);
console.log("PASS graceful quit preserves production account settings");

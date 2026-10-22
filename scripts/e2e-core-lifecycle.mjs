// Real separate processes, isolated DB. --elevated prompts for UAC; no model calls.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root } from "./e2e-lib.mjs";
const { check, finish } = makeChecks();
const elevated = process.argv.includes("--elevated");
const base = join(root, ".scratch", "core lifecycle 한글", String(Date.now()));
const data = join(base, "data");
mkdirSync(base, { recursive: true });
const preserved = join(data, "electron", "Partitions", "gemini-test", "existing-session.txt");
mkdirSync(join(preserved, ".."), { recursive: true });
writeFileSync(preserved, "preserve existing browser sessions");
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function exited(pid) {
  for (let n = 0; n < 100 && alive(pid); n++) await new Promise(resolve => setTimeout(resolve, 100));
  return !alive(pid);
}
let app;
try {
  let started = await launch(data, { elevateCore: elevated });
  app = started.app;
  const info = await app.evaluate(() => {
    const { execFileSync } = process.getBuiltinModule("node:child_process");
    const uiAdmin = process.platform === "win32" && execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], { windowsHide: true, encoding: "utf8" }).trim() === "True";
    return { uiPid: process.pid, uiAdmin, core: globalThis.__chatterboxCoreTest };
  });
  console.log(JSON.stringify(info));
  check("core runs in a different process", info.core?.pid > 0 && info.core.pid !== info.uiPid);
  check("UI stays at normal privilege", info.uiAdmin === false);
  if (elevated) check("core and its token-check child inherit administrator privilege", info.core.elevated === true);
  check("existing Google browser session profile is preserved", readFileSync(preserved, "utf8") === "preserve existing browser sessions");
  const created = await started.page.evaluate(async ({ base, defaults }) => {
    const project = await window.chatterbox.createProject({ name: "코어 경계 확인", folder: base, settings: defaults });
    const chat = await window.chatterbox.createChat(project.id);
    const attachment = await window.chatterbox.attachFromBytes(chat.id, "권한 테스트.txt", "text/plain", new TextEncoder().encode("binary IPC ✓"));
    await window.chatterbox.updateChat(chat.id, { title: "코어에 저장한 대화" });
    return { chat, attachment };
  }, { base, defaults: DEFAULTS });
  check("attachments cross the privilege boundary intact", readFileSync(created.attachment.path, "utf8") === "binary IPC ✓");
  await app.close(); app = undefined;
  check("normal UI quit shuts down the core", await exited(info.core.pid));
  // The elevated run needs only one consent prompt. Repeat lifecycle/crash checks without elevation.
  started = await launch(data); app = started.app;
  const restored = await started.page.evaluate(() => window.chatterbox.listChats());
  check("only core owns the DB and stored conversations survive restart", restored.some(chat => chat.title === "코어에 저장한 대화"));
  const crashInfo = await app.evaluate(() => ({ ui: process.pid, core: globalThis.__chatterboxCoreTest.pid }));
  process.kill(crashInfo.ui);
  check("UI crash disconnects and stops the orphan core", await exited(crashInfo.core));
  await app.close().catch(() => {}); app = undefined;
} catch (error) {
  console.error(error);
  check("core lifecycle completed", false, error.stack ?? error.message);
} finally { await app?.close().catch(() => {}); }
finish();

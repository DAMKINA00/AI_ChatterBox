// Regression check for the cross-version instance guard:
//  1. start an OLD build (no single-instance lock, e.g. dist\win-unpacked of 0.2.0) on a scratch data dir
//  2. start the new build on the same data dir → it must detect the old one, open no window, and
//     leave the DB untouched (a chat marked "working" stays "working").
// Usage: npm run build && node scripts/check-instance-guard.mjs <old AI_ChatterBox.exe>
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import { makeChecks, scratchDir, root } from "./e2e-lib.mjs";

const oldExe = resolve(process.argv[2]);
const { check, finish } = makeChecks();
const data = scratchDir("guard");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Old instance creates the DB; mark a chat as working (as if it were mid-task).
const old = spawn(oldExe, [], { env: { ...process.env, AI_CHATTERBOX_DATA: data }, stdio: "ignore" });
await sleep(8000);
{
  const db = new DatabaseSync(join(data, "chatterbox.db"));
  db.prepare("INSERT INTO projects (name, folder, settings_json, created_at) VALUES ('guard', ?, '{}', ?)").run(data, Date.now());
  db.prepare("INSERT INTO chats (project_id, title, status, created_at, last_active_at) VALUES (1, 'running chat', 'working', ?, ?)").run(Date.now(), Date.now());
  db.close();
}

// New build on the same data dir.
let log = "";
const app = await electron.launch({ args: [root], env: { ...process.env, AI_CHATTERBOX_DATA: data } }).catch((e) => ({ error: e }));
if (app.error) {
  check("new build started", false, String(app.error));
} else {
  app.process().stdout.on("data", (d) => (log += d));
  await sleep(8000);
  check("new build detects the old instance", log.includes("[guard] another AI_ChatterBox"), log.trim().split("\n").pop());
  check("new build opens no window next to it", app.windows().length === 0, `windows=${app.windows().length}`);
  app.process().kill();
}
const db = new DatabaseSync(join(data, "chatterbox.db"), { readOnly: true });
const status = db.prepare("SELECT status FROM chats WHERE title = 'running chat'").get()?.status;
db.close();
check("old instance's running chat untouched", status === "working", status);
old.kill();
await sleep(1000);
finish();

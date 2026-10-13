// Opens a COPY of a user data folder with the built app and checks that every project and chat is listed
// and the last chat opens with its history. Sends nothing (the projects point at real folders).
// Usage: node scripts/check-userdb-copy.mjs <copied data dir>
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, makeChecks, shot } from "./e2e-lib.mjs";

const dir = resolve(process.argv[2]);
const { check, finish } = makeChecks();
const db = new DatabaseSync(join(dir, "chatterbox.db"), { readOnly: true });
const expectProjects = db.prepare("SELECT id, name FROM projects").all();
const expectChats = db.prepare("SELECT id, title, orch_codex_thread_id, orch_claude_session_id, claude_session_id, codex_thread_id FROM chats").all();
const events = db.prepare("SELECT chat_id, COUNT(*) n FROM chat_events GROUP BY chat_id").all();
db.close();

const { app, page } = await launch(dir);
const projects = await page.evaluate(() => window.chatterbox.listProjects());
const chats = await page.evaluate(() => window.chatterbox.listChats());
check("all projects listed", expectProjects.every((p) => projects.some((x) => x.id === p.id && x.name === p.name)), projects.map((p) => p.name).join(", "));
check("all chats listed", expectChats.every((c) => chats.some((x) => x.id === c.id)), chats.map((c) => c.title.slice(0, 30)).join(" | "));
check(
  "session ids kept (orchestrator / workers can resume)",
  expectChats.every((c) => {
    const x = chats.find((y) => y.id === c.id);
    return x && x.orchCodexThreadId === c.orch_codex_thread_id && x.orchClaudeSessionId === c.orch_claude_session_id && x.claudeSessionId === c.claude_session_id && x.codexThreadId === c.codex_thread_id;
  }),
);
for (const c of chats) {
  await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
  await page.waitForSelector('[data-testid="chat-title"]');
  const n = (await page.evaluate((id) => window.chatterbox.loadEvents(id), c.id)).length;
  const want = events.find((e) => e.chat_id === c.id)?.n ?? 0;
  check(`chat ${c.id} opens with its full history`, n === want, `${n}/${want} events, status=${c.status}`);
}
await shot(page, "v021-userdb-copy.png");
await app.close();
finish();

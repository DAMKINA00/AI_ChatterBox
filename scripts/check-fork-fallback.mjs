// Regression check for the "thread-store conflict: … already has an active writer" fallback.
// A helper codex app-server creates a throwaway thread and keeps it open (holds the writer, like the Codex
// desktop app does). The app (isolated data dir) then continues a chat whose orchestrator is that thread:
// it must fork, store the new thread id, show the notice, and answer. Never touches real user threads.
// Usage: npm run build && node scripts/check-fork-fallback.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { makeChecks, scratchDir, launch, DEFAULTS, waitIdle, send, lastAgentText, shot } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = scratchDir("fork-fallback");
const data = join(base, "data");
const work = join(base, "work");
mkdirSync(work, { recursive: true });

function findCodex() {
  const bin = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const c = readdirSync(bin).map((d) => join(bin, d, "codex.exe")).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return c ?? "codex";
}

// ---- helper app-server: create a thread, run one turn, keep holding it
const holder = spawn(findCodex(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
let nextId = 1;
const pending = new Map();
let turnDone;
createInterface({ input: holder.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined && !m.method) pending.get(m.id)?.(m.result ?? m.error);
  else if (m.id !== undefined) holder.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "no" } }) + "\n");
  else if (m.method === "turn/completed") turnDone?.();
});
const req = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    holder.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
await req("initialize", { clientInfo: { name: "fork-test-holder", title: null, version: "0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
holder.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const started = await req("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", model: "gpt-6-astra" });
const threadId = started.thread.id;
const done = new Promise((r) => (turnDone = r));
await req("turn/start", { threadId, input: [{ type: "text", text: "코드워드는 '포크-17'이야. '확인'이라고만 답해.", text_elements: [] }] });
await done;
const lock = join(homedir(), ".codex", "thread-writer-locks", `${threadId}.lock`);
check("helper holds the throwaway thread's writer lock", existsSync(lock), threadId);

// ---- app: chat whose orchestrator thread is the held one
let { app, page } = await launch(data);
const p = await page.evaluate(([f, s]) => window.chatterbox.createProject({ name: "fork", folder: f, settings: s }), [work, { ...DEFAULTS, orchestratorModel: "codex:gpt-6-astra" }]);
const c = await page.evaluate((id) => window.chatterbox.createChat(id), p.id);
await app.close();
{
  const db = new DatabaseSync(join(data, "chatterbox.db"));
  db.prepare("UPDATE chats SET orch_codex_thread_id = ? WHERE id = ?").run(threadId, c.id);
  db.close();
}
({ app, page } = await launch(data));
await page.locator(`[data-testid="chat-node"][data-chat-id="${c.id}"] [role="treeitem"]`).click();
await page.waitForSelector('[data-testid="chat-title"]');
await send(page, "아까 말한 코드워드가 뭐였지? 코드워드만 답해. 작업자는 부르지 마.");
await waitIdle(page, { timeout: 300_000 });
const chat = (await page.evaluate(() => window.chatterbox.listChats())).find((x) => x.id === c.id);
const reply = await lastAgentText(page, "orch");
check("app forked instead of failing", !!chat.orchCodexThreadId && chat.orchCodexThreadId !== threadId, chat.orchCodexThreadId);
check("fork notice shown in the chat", (await page.getByText(/복사한 새 대화로 이어서/).count()) >= 1);
check("forked thread kept the history", /포크-17/.test(reply), reply.slice(0, 100));
check("no raw 'active writer' error shown", (await page.getByText(/active writer/).count()) === 0);
await shot(page, "v022-fork-fallback.png");
await app.close();
holder.stdin.end();
await new Promise((r) => setTimeout(r, 1500));
finish();

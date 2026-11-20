import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodexDriver, type CodexServer } from "./codex";
import { rebindCodexRollout } from "./codex-rollout";

const threadId = "00000000-0000-4000-8000-000000000001";
const session = ["sessions", "2026", "01", "02", `rollout-2026-01-02T03-04-05-${threadId}.jsonl`];

function fixture(run: (f: { home: string; file: string; stale: string; db: DatabaseSync }) => void | Promise<void>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cbx-rollout-")));
  const home = join(root, "account");
  const file = join(home, ...session);
  const stale = join(root, "previous-account-path", ...session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(threadId, stale);
  return Promise.resolve().then(() => run({ home, file, stale, db })).finally(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
}

test("Codex repairs a moved account's rollout and retries the unchanged thread once", () => fixture(async ({ home, file, db }) => {
  const calls: string[] = [];
  const server = {
    loaded: new Set(), ensure: async () => {}, attach() {},
    async request(method: string, args: { threadId: string }) {
      calls.push(method);
      assert.equal(args.threadId, threadId);
      if (method === "thread/resume" && calls.length === 1) throw new Error(`no rollout found for thread id ${threadId}`);
      return { turn: { id: "same-chat-next-turn" } };
    },
  } as unknown as CodexServer;
  const driver = new CodexDriver({ cwd: home, exePath: "unused", nativeId: threadId, accountEnv: { CODEX_HOME: home } }, server, {
    emit() {}, nativeId: () => assert.fail("must keep the original thread"), approve: async () => ({ verdict: "deny" }),
  });
  await driver.send({ text: "continue", attachments: [] });
  assert.deepEqual(calls, ["thread/resume", "thread/resume", "turn/start"]);
  assert.equal(db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path, file);
  assert.equal(rebindCodexRollout(home, threadId), false, "an existing path does not need a repair");
}));

test("Codex rollout repair leaves the index untouched for a different thread or linked directory", () => fixture(({ home, file, stale, db }) => {
  const indexed = () => db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path;
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "another-session" } }) + "\n");
  assert.equal(rebindCodexRollout(home, threadId), false);
  assert.equal(indexed(), stale);

  const outside = join(dirname(home), "another-account");
  mkdirSync(outside);
  writeFileSync(join(outside, session.at(-1)!), JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n");
  const alternate = join(dirname(home), "linked-account");
  mkdirSync(join(alternate, ...session.slice(0, -2)), { recursive: true });
  symlinkSync(outside, join(alternate, ...session.slice(0, -1)), process.platform === "win32" ? "junction" : "dir");
  const alternateDb = new DatabaseSync(join(alternate, "state_5.sqlite"));
  try {
    alternateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    alternateDb.prepare("INSERT INTO threads VALUES (?, ?)").run(threadId, stale);
    assert.equal(rebindCodexRollout(alternate, threadId), false);
    assert.equal(alternateDb.prepare("SELECT rollout_path FROM threads").get()?.rollout_path, stale);
  } finally { alternateDb.close(); }
}));

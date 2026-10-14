import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "./db";
import { DEFAULT_SETTINGS } from "../shared/types";

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-effort-storage-"));
  const dbPath = join(root, "app.sqlite");
  const store = new Store(dbPath);
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test chat");
  return { root, dbPath, store, projectId: project.id, chatId: chat.id };
}

function seedLegacyDb() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-effort-legacy-"));
  const dbPath = join(root, "app.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      settings_json TEXT NOT NULL, created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, orch_claude_session_id TEXT, orch_codex_thread_id TEXT,
      claude_session_id TEXT, codex_thread_id TEXT, claude_model_override TEXT,
      codex_model_override TEXT, status TEXT NOT NULL DEFAULT 'idle', unread INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
    );
    CREATE TABLE consults (
      id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, from_role TEXT NOT NULL, to_role TEXT NOT NULL, kind TEXT NOT NULL,
      request TEXT NOT NULL, response_summary TEXT, files_changed_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
    );
  `);
  db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(
      1,
      "legacy project",
      root,
      JSON.stringify({
        claudeStrengths: "legacy Claude",
        claudeCautions: "legacy Claude cautions",
        gptStrengths: "legacy GPT",
        gptCautions: "legacy GPT cautions",
        orchestratorModel: "codex:legacy",
        claudeModel: "legacy-claude",
        codexModel: "legacy-codex",
        reviewGate: true,
        maxConsults: 8,
        maxReviews: 3,
        maxMinutes: 60,
        maxClaudeWorkers: 3,
        maxGptWorkers: 3,
        approvalMode: "orchestrator",
        delegateHighRisk: false,
      }),
      10,
    );
  db.prepare(
    `INSERT INTO chats
      (id, project_id, title, status, unread, archived, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(7, 1, "legacy chat", "idle", 0, 0, 20, 30);
  db.prepare(
    `INSERT INTO consults
      (id, chat_id, seq, from_role, to_role, kind, request, response_summary, files_changed_json, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(201, 7, 1, "orch", "w1", "implement", "legacy implementation", "implemented", "[]", "done", 60, 70);
  db.close();
  return { root, dbPath, chatId: 7, projectId: 1 };
}

test("legacy databases add nullable effort fields and preserve project settings", () => {
  const f = seedLegacyDb();
  let store: Store | undefined;
  try {
    store = new Store(f.dbPath);
    const chat = store.chat(f.chatId)!;
    assert.equal(chat.orchestratorEffortOverride, null);
    assert.equal(chat.claudeEffortOverride, null);
    assert.equal(chat.codexEffortOverride, null);
    assert.equal(chat.geminiEffortOverride, null);

    const settings = store.project(f.projectId)!.settings;
    assert.equal(settings.orchestratorModel, "codex:legacy");
    assert.equal(settings.claudeModel, "legacy-claude");
    assert.equal(settings.codexModel, "legacy-codex");
    assert.equal(settings.orchestratorEffort, DEFAULT_SETTINGS.orchestratorEffort);
    assert.equal(settings.claudeEffort, DEFAULT_SETTINGS.claudeEffort);
    assert.equal(settings.codexEffort, DEFAULT_SETTINGS.codexEffort);
    assert.equal(settings.geminiEffort, DEFAULT_SETTINGS.geminiEffort);

    const consult = store.consult(201)!;
    assert.equal(consult.requestedEffort, undefined);
    assert.equal(consult.effort, undefined);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("chat effort overrides persist across restart and clear with null", () => {
  const f = freshStore();
  let store: Store | undefined = f.store;
  try {
    assert.deepEqual(
      [
        store.chat(f.chatId)!.orchestratorEffortOverride,
        store.chat(f.chatId)!.claudeEffortOverride,
        store.chat(f.chatId)!.codexEffortOverride,
        store.chat(f.chatId)!.geminiEffortOverride,
      ],
      [null, null, null, null],
    );
    assert.deepEqual(
      [
        store.updateChat(f.chatId, {
          orchestratorEffortOverride: "high",
          claudeEffortOverride: "max",
          codexEffortOverride: "xhigh",
          geminiEffortOverride: "medium",
          touch: true,
        }).orchestratorEffortOverride,
        store.chat(f.chatId)!.claudeEffortOverride,
        store.chat(f.chatId)!.codexEffortOverride,
        store.chat(f.chatId)!.geminiEffortOverride,
      ],
      ["high", "max", "xhigh", "medium"],
    );

    store.close();
    store = new Store(f.dbPath);
    assert.deepEqual(
      [
        store.chat(f.chatId)!.orchestratorEffortOverride,
        store.chat(f.chatId)!.claudeEffortOverride,
        store.chat(f.chatId)!.codexEffortOverride,
        store.chat(f.chatId)!.geminiEffortOverride,
      ],
      ["high", "max", "xhigh", "medium"],
    );
    const cleared = store.updateChat(f.chatId, {
      orchestratorEffortOverride: null,
      claudeEffortOverride: null,
      codexEffortOverride: null,
      geminiEffortOverride: null,
      touch: true,
    });
    assert.deepEqual(
      [cleared.orchestratorEffortOverride, cleared.claudeEffortOverride, cleared.codexEffortOverride, cleared.geminiEffortOverride],
      [null, null, null, null],
    );
    store.close();
    store = new Store(f.dbPath);
    assert.deepEqual(
      [
        store.chat(f.chatId)!.orchestratorEffortOverride,
        store.chat(f.chatId)!.claudeEffortOverride,
        store.chat(f.chatId)!.codexEffortOverride,
        store.chat(f.chatId)!.geminiEffortOverride,
      ],
      [null, null, null, null],
    );
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("consult requested and effective effort survive finish and restart", () => {
  const f = freshStore();
  let store: Store | undefined = f.store;
  try {
    const consult = store.createConsult(f.chatId, "orch", "w1", "implement", "implement", [], undefined, undefined, undefined, {
      requestedEffort: "auto",
      effort: "xhigh",
    });
    assert.equal(consult.requestedEffort, "auto");
    assert.equal(consult.effort, "xhigh");
    store.finishConsult(consult.id, "done", "complete", []);
    store.close();
    store = new Store(f.dbPath);
    const reloaded = store.consult(consult.id)!;
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.requestedEffort, "auto");
    assert.equal(reloaded.effort, "xhigh");
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

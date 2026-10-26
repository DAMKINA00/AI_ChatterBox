import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "./db";
import { DEFAULT_SETTINGS } from "../shared/types";

const legacySettings = {
  claudeStrengths: "legacy Claude",
  claudeCautions: "legacy Claude cautions",
  gptStrengths: "legacy GPT",
  gptCautions: "legacy GPT cautions",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

function seedLegacyDb() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-gemini-storage-"));
  const dbPath = join(root, "app.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE chat_events (
      id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      node TEXT NOT NULL, role TEXT, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('claude','gpt')), number INTEGER NOT NULL,
      nickname TEXT NOT NULL, job TEXT NOT NULL DEFAULT '', session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(1, "legacy project", root, JSON.stringify(legacySettings), 10);
  db.prepare(
    `INSERT INTO chats
      (id, project_id, title, orch_claude_session_id, orch_codex_thread_id, claude_session_id, codex_thread_id,
       status, unread, archived, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(7, 1, "legacy chat", "orch-claude", "orch-codex", "chat-claude", "chat-codex", "idle", 0, 0, 20, 30);
  db.prepare(
    `INSERT INTO agents
      (id, chat_id, kind, number, nickname, job, session_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(41, 7, "claude", 1, "클로드 1호", "implementation", "claude-native-41", "released", 40);
  db.prepare(
    `INSERT INTO agents
      (id, chat_id, kind, number, nickname, job, session_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(42, 7, "gpt", 2, "지피티 2호", "review", "codex-native-42", "active", 41);
  db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(101, 7, "w41", "w41", 50, "text", JSON.stringify({ type: "text", text: "legacy Claude event" }));
  db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(102, 7, "w42", "w42", 51, "tool_result", JSON.stringify({ type: "tool_result", id: "tool-42", ok: true, output: "legacy GPT event" }));
  db.prepare(
    `INSERT INTO consults
      (id, chat_id, seq, from_role, to_role, kind, request, response_summary, files_changed_json, status, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(201, 7, 1, "orch", "w41", "implement", "legacy implementation", "implemented", JSON.stringify(["src/a.ts"]), "done", 60, 70);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("migratedAgents", "1");
  db.close();
  return { root, dbPath, chatId: 7, projectId: 1 };
}

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-gemini-storage-"));
  const dbPath = join(root, "app.sqlite");
  const store = new Store(dbPath);
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test chat");
  return { root, dbPath, store, projectId: project.id, chatId: chat.id };
}

test("two-kind agent migration preserves identities, sessions, statuses, events, and consults", () => {
  const f = seedLegacyDb();
  let store: Store | undefined;
  try {
    store = new Store(f.dbPath);

    assert.deepEqual(
      store.listAgents(f.chatId).map((a) => ({ id: a.id, kind: a.kind, number: a.number, nickname: a.nickname, job: a.job, sessionId: a.sessionId, status: a.status, createdAt: a.createdAt })),
      [
        { id: 41, kind: "claude", number: 1, nickname: "클로드 1호", job: "implementation", sessionId: "claude-native-41", status: "released", createdAt: 40 },
        { id: 42, kind: "gpt", number: 2, nickname: "지피티 2호", job: "review", sessionId: "codex-native-42", status: "active", createdAt: 41 },
      ],
    );
    assert.deepEqual(
      store.chat(f.chatId),
      {
        id: f.chatId,
        projectId: f.projectId,
        title: "legacy chat",
        orchClaudeSessionId: "orch-claude",
        orchCodexThreadId: "orch-codex",
        claudeSessionId: "chat-claude",
        codexThreadId: "chat-codex",
        claudeModelOverride: null,
        codexModelOverride: null,
        geminiModelOverride: null,
        grokModelOverride: null,
        deepseekModelOverride: null,
        orchestratorEffortOverride: null,
        claudeEffortOverride: null,
        codexEffortOverride: null,
        geminiEffortOverride: null,
        grokEffortOverride: null,
        deepseekEffortOverride: null,
        approvalModeOverride: null,
        orchestratorModelOverride: null,
        goal: null,
        status: "idle",
        unread: false,
        archived: false,
        createdAt: 20,
        lastActiveAt: 30,
      },
    );
    assert.deepEqual(
      store.events(f.chatId).map((e) => ({ id: e.id, node: e.node, role: e.role, at: e.at, event: e.event })),
      [
        { id: 101, node: "w41", role: "w41", at: 50, event: { type: "text", text: "legacy Claude event" } },
        { id: 102, node: "w42", role: "w42", at: 51, event: { type: "tool_result", id: "tool-42", ok: true, output: "legacy GPT event" } },
      ],
    );
    assert.deepEqual(
      store.listConsults(f.chatId).map((c) => ({ id: c.id, seq: c.seq, fromRole: c.fromRole, toRole: c.toRole, kind: c.kind, request: c.request, responseSummary: c.responseSummary, filesChanged: c.filesChanged, status: c.status, startedAt: c.startedAt, endedAt: c.endedAt, scope: c.scope })),
      [{ id: 201, seq: 1, fromRole: "orch", toRole: "w41", kind: "implement", request: "legacy implementation", responseSummary: "implemented", filesChanged: ["src/a.ts"], status: "done", startedAt: 60, endedAt: 70, scope: [] }],
    );

    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() as { sql: string };
    assert.match(schema.sql, /'gemini'/);
    assert.equal((store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    store.deleteChat(f.chatId);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE chat_id = ?").get(f.chatId) as { n: number }).n, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM chat_events WHERE chat_id = ?").get(f.chatId) as { n: number }).n, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM consults WHERE chat_id = ?").get(f.chatId) as { n: number }).n, 0);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy project settings fill new Gemini fields from defaults", () => {
  const f = seedLegacyDb();
  let store: Store | undefined;
  try {
    store = new Store(f.dbPath);
    const settings = store.project(f.projectId)!.settings;
    assert.equal(settings.claudeStrengths, legacySettings.claudeStrengths);
    assert.equal(settings.gptStrengths, legacySettings.gptStrengths);
    assert.equal(settings.geminiModel, DEFAULT_SETTINGS.geminiModel);
    assert.equal(settings.geminiStrengths, DEFAULT_SETTINGS.geminiStrengths);
    assert.equal(settings.geminiCautions, DEFAULT_SETTINGS.geminiCautions);
    assert.equal(settings.maxGeminiWorkers, DEFAULT_SETTINGS.maxGeminiWorkers);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Gemini workers create, release, and reuse their stable identity and session", () => {
  const f = freshStore();
  try {
    const created = f.store.createAgent(f.chatId, "gemini", "summarize documents");
    assert.deepEqual(
      { kind: created.kind, number: created.number, nickname: created.nickname, status: created.status, sessionId: created.sessionId },
      { kind: "gemini", number: 1, nickname: "제미나이 1호", status: "active", sessionId: null },
    );
    const released = f.store.updateAgent(created.id, { sessionId: "gemini-native-1", status: "released" });
    assert.equal(released.status, "released");
    assert.equal(released.sessionId, "gemini-native-1");

    const reused = f.store.createAgent(f.chatId, "gemini", "compare documents");
    assert.equal(reused.id, created.id);
    assert.equal(reused.number, created.number);
    assert.equal(reused.sessionId, "gemini-native-1");
    assert.equal(reused.status, "active");
    assert.equal(reused.job, "compare documents");
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Gemini model override persists, reloads, clears with null, and reloads cleared", () => {
  const f = freshStore();
  let store: Store | undefined = f.store;
  try {
    assert.equal(store.chat(f.chatId)!.geminiModelOverride, null);
    assert.equal(store.updateChat(f.chatId, { geminiModelOverride: "aistudio:gemini-4-argon", touch: true }).geminiModelOverride, "aistudio:gemini-4-argon");
    store.close();
    store = new Store(f.dbPath);
    assert.equal(store.chat(f.chatId)!.geminiModelOverride, "aistudio:gemini-4-argon");
    assert.equal(store.updateChat(f.chatId, { geminiModelOverride: null, touch: true }).geminiModelOverride, null);
    store.close();
    store = new Store(f.dbPath);
    assert.equal(store.chat(f.chatId)!.geminiModelOverride, null);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

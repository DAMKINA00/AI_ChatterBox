import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, parseOrchestrator } from "../shared/types";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { ChatCompletionDriver } from "./drivers/aistudio";
import { CodexDriver } from "./drivers/codex";
import { Orchestrator } from "./orchestrator";

const sink = { agents() {}, chat() {}, consult() {}, usage() {}, event() {} };
const body = (result: any) => result.content.map((content: any) => content.text).join("\n");

function closeRoot(store: Store | undefined, root: string) {
  store?.close();
  rmSync(root, { recursive: true, force: true });
}

test("four-provider agents migrate to DeepSeek without losing identity, web account, sessions, status, or events", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-migration-"));
  const path = join(root, "app.db");
  let store: Store | undefined;
  try {
    store = new Store(path);
    const project = store.createProject("migration", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "migration");
    const old = [
      store.createAgent(chat.id, "claude", "claude job"),
      store.createAgent(chat.id, "gpt", "gpt job"),
      store.createAgent(chat.id, "gemini", "gemini job"),
      store.createAgent(chat.id, "grok", "grok job"),
    ];
    for (const [index, agent] of old.entries()) {
      store.updateAgent(agent.id, {
        sessionId: `legacy-session-${index + 1}`,
        ...(agent.kind === "gemini" ? { webAccountId: "gemini-4" } : {}),
        ...(agent.kind === "grok" ? { status: "released" as const } : {}),
      });
    }
    const event = store.addEvent(chat.id, old[2].key, old[2].key, { type: "text", text: "legacy Gemini event" });
    const expected = store.listAgents(chat.id).map(({ id, kind, number, nickname, job, sessionId, status, webAccountId }) => ({ id, kind, number, nickname, job, sessionId, status, webAccountId }));
    store.close(); store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`ALTER TABLE agents RENAME TO agents_current;
      CREATE TABLE agents (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('claude','gpt','gemini','grok')), number INTEGER NOT NULL, nickname TEXT NOT NULL,
      job TEXT NOT NULL DEFAULT '', session_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
      web_account_id TEXT);
      INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at, web_account_id)
        SELECT id, chat_id, kind, number, nickname, job, session_id, status, created_at, web_account_id FROM agents_current;
      DROP TABLE agents_current;
      CREATE INDEX agents_chat ON agents(chat_id,id);`);
    legacy.close();

    store = new Store(path);
    assert.deepEqual(store.listAgents(chat.id).map(({ id, kind, number, nickname, job, sessionId, status, webAccountId }) => ({ id, kind, number, nickname, job, sessionId, status, webAccountId })), expected);
    assert.equal(store.agent(old[2].id)?.webAccountId, "gemini-4");
    assert.equal(store.agent(old[3].id)?.status, "released");
    const restoredEvent = store.events(chat.id).find((entry) => entry.id === event.id);
    assert.deepEqual(restoredEvent && { node: restoredEvent.node, role: restoredEvent.role, event: restoredEvent.event }, { node: event.node, role: event.role, event: event.event });
  } finally { closeRoot(store, root); }
});

test("DeepSeek workers support CRUD and released identity reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-workers-"));
  let store: Store | undefined;
  try {
    store = new Store(join(root, "app.db"));
    const project = store.createProject("workers", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "workers");
    const created = store.createAgent(chat.id, "deepseek", "first assignment");
    store.updateAgent(created.id, { sessionId: "deepseek-session", status: "released" });
    const reused = store.createAgent(chat.id, "deepseek", "second assignment");
    assert.equal(reused.id, created.id);
    assert.equal(reused.number, created.number);
    assert.equal(reused.nickname, "딥시크 1호");
    assert.equal(reused.sessionId, "deepseek-session");
    assert.equal(reused.status, "active");
    assert.equal(reused.job, "second assignment");
  } finally { closeRoot(store, root); }
});

test("DeepSeek defaults merge, chat overrides persist, routing parses, and drivers stay on DeepSeek", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-routing-"));
  const path = join(root, "app.db");
  let store: Store | undefined;
  let chats: ChatManager | undefined;
  try {
    store = new Store(path);
    const project = store.createProject("routing", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "routing");
    const saved = JSON.parse((store.db.prepare("SELECT settings_json FROM projects WHERE id = ?").get(project.id) as { settings_json: string }).settings_json);
    saved.claudeStrengths = "custom preference";
    delete saved.deepseekModel;
    delete saved.deepseekStrengths;
    delete saved.deepseekCautions;
    delete saved.deepseekEffort;
    delete saved.maxDeepseekWorkers;
    store.db.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").run(JSON.stringify(saved), project.id);
    const merged = store.project(project.id)!.settings;
    assert.equal(merged.claudeStrengths, "custom preference");
    assert.equal(merged.deepseekModel, DEFAULT_SETTINGS.deepseekModel);
    assert.equal(merged.deepseekStrengths, DEFAULT_SETTINGS.deepseekStrengths);
    assert.equal(merged.deepseekCautions, DEFAULT_SETTINGS.deepseekCautions);
    assert.equal(merged.deepseekEffort, DEFAULT_SETTINGS.deepseekEffort);
    assert.equal(merged.maxDeepseekWorkers, DEFAULT_SETTINGS.maxDeepseekWorkers);

    store.updateProject(project.id, { settings: { ...merged, orchestratorModel: "deepseek:deepseek-v4-pro", orchestratorEffort: "high" } });
    store.updateChat(chat.id, { deepseekModelOverride: "deepseek-v4-pro", deepseekEffortOverride: "max" });
    const worker = store.createAgent(chat.id, "deepseek", "routing worker");
    const currentChat = store.chat(chat.id)!;
    const currentProject = store.project(project.id)!;
    assert.deepEqual(parseOrchestrator("deepseek:deepseek-v4-pro"), { agent: "deepseek", model: "deepseek-v4-pro" });
    chats = new ChatManager(store, sink, root, "unused");
    assert.deepEqual(chats.roleConfig(currentChat, currentProject, "orch"), { agent: "deepseek", model: "deepseek-v4-pro", effort: "high" });
    assert.deepEqual(chats.roleConfig(currentChat, currentProject, worker.key), { agent: "deepseek", model: "deepseek-v4-pro", effort: "max" });

    const master = await chats.driver(chat.id, "orch");
    const assigned = await chats.driver(chat.id, worker.key, "medium");
    assert.ok(master instanceof ChatCompletionDriver);
    assert.ok(assigned instanceof ChatCompletionDriver);
    assert.equal(master.agent, "deepseek");
    assert.equal(assigned.agent, "deepseek");
    assert.equal(master instanceof CodexDriver, false);
    assert.equal(assigned instanceof CodexDriver, false);
    await chats.dispose(); chats = undefined;
    store.close(); store = undefined;

    store = new Store(path);
    assert.equal(store.chat(chat.id)?.deepseekModelOverride, "deepseek-v4-pro");
    assert.equal(store.chat(chat.id)?.deepseekEffortOverride, "max");
  } finally {
    await chats?.dispose();
    closeRoot(store, root);
  }
});

test("DeepSeek context is removed with its chat or project while unrelated AI Studio context remains", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-context-"));
  let store: Store | undefined;
  try {
    store = new Store(join(root, "app.db"));
    const project = store.createProject("context", root, DEFAULT_SETTINGS);
    const first = store.createChat(project.id, "first");
    const second = store.createChat(project.id, "second");
    const deepFirst = `deepseek-context:${first.id}:orch:deepseek-flash`;
    const studioFirst = `aistudio-context:${first.id}:orch:aistudio:gemini-4-argon`;
    const deepSecond = `deepseek-context:${second.id}:orch:deepseek-flash`;
    const studioSecond = `aistudio-context:${second.id}:orch:aistudio:gemini-4-argon`;
    store.setSetting(deepFirst, "deep first");
    store.setSetting(studioFirst, "studio first");
    store.setSetting(deepSecond, "deep second");
    store.setSetting(studioSecond, "studio second");
    assert.equal(store.getSetting(studioFirst), "studio first");
    store.deleteChat(first.id);
    assert.equal(store.getSetting(deepFirst), undefined);
    assert.equal(store.getSetting(studioFirst), undefined);
    assert.equal(store.getSetting(deepSecond), "deep second");
    assert.equal(store.getSetting(studioSecond), "studio second");
    store.deleteProject(project.id);
    assert.equal(store.getSetting(deepSecond), undefined);
    assert.equal(store.getSetting(studioSecond), undefined);
  } finally { closeRoot(store, root); }
});

test("Orchestrator enforces maxDeepseekWorkers without contacting the API", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-limit-"));
  let store: Store | undefined;
  let chats: ChatManager | undefined;
  let engine: Orchestrator | undefined;
  try {
    store = new Store(join(root, "app.db"));
    const project = store.createProject("limits", root, { ...DEFAULT_SETTINGS, maxDeepseekWorkers: 1 });
    const chat = store.createChat(project.id, "limits");
    chats = new ChatManager(store, sink, root, "unused");
    chats.cliInfo = () => [{ agent: "deepseek", path: "DeepSeek API" }];
    engine = new Orchestrator(chats);
    const first = await (engine as any).call(chat.id, "orch", "spawn", { kind: "deepseek", job: "first" });
    assert.equal(first.isError, false);
    const worker = store.listAgents(chat.id)[0];
    const blocked = await (engine as any).call(chat.id, "orch", "spawn", { kind: "deepseek", job: "second" });
    assert.equal(blocked.isError, true);
    assert.match(body(blocked), /동시에 1명/);
    assert.equal(store.listAgents(chat.id).length, 1);
    assert.equal((await (engine as any).call(chat.id, "orch", "release", { nickname: worker.nickname })).isError, false);
    const reused = await (engine as any).call(chat.id, "orch", "spawn", { kind: "deepseek", job: "third" });
    assert.equal(reused.isError, false);
    assert.deepEqual(store.listAgents(chat.id).map(agent => [agent.id, agent.number, agent.status, agent.job]), [[worker.id, 1, "active", "third"]]);
  } finally {
    await engine?.judge.dispose();
    await chats?.dispose();
    closeRoot(store, root);
  }
});

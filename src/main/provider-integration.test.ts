import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { AttachmentStore } from "./attachments";
import { GrokDriver } from "./drivers/grok";
import { GeminiDriver } from "./drivers/gemini";
import { AIStudioDriver } from "./drivers/aistudio";
import { AISTUDIO_MODEL } from "../shared/aistudio";
import { publishGeneratedImages } from "./drivers/generated-images";
import { DEFAULT_SETTINGS, GEMINI_WEB_MODEL, parseOrchestrator } from "../shared/types";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XkAAAAASUVORK5CYII=";

test("three-provider DB upgrade preserves workers, sessions and new Grok settings across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-provider-db-"));
  const path = join(root, "app.db");
  let store = new Store(path);
  const p = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(p.id, "test");
  const old = store.createAgent(chat.id, "gemini", "existing worker");
  store.updateAgent(old.id, { sessionId: "existing-antigravity-session" });
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(`ALTER TABLE agents RENAME TO agents_old;
    CREATE TABLE agents (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('claude','gpt','gemini')), number INTEGER NOT NULL, nickname TEXT NOT NULL,
    job TEXT NOT NULL DEFAULT '', session_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
    INSERT INTO agents SELECT id, chat_id, kind, number, nickname, job, session_id, status, created_at FROM agents_old; DROP TABLE agents_old; CREATE INDEX agents_chat ON agents(chat_id,id);`);
  legacy.close();
  try {
    store = new Store(path);
    assert.equal(store.agent(old.id)!.sessionId, "existing-antigravity-session");
    const grok = store.createAgent(chat.id, "grok", "new worker");
    store.updateAgent(grok.id, { sessionId: "grok-worker" });
    store.updateChat(chat.id, { grokModelOverride: "grok-4.6", grokEffortOverride: "high", orchestratorModelOverride: "grok:grok-4.6" });
    const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
    for (const agent of ["claude", "codex", "gemini", "grok"] as const) (chats as any).saveNativeId(chat.id, "orch", agent, `master-${agent}`);
    for (const agent of ["claude", "codex", "gemini", "grok"] as const) assert.equal((chats as any).nativeIdOf(store.chat(chat.id), "orch", agent), `master-${agent}`);
    assert.equal(chats.roleConfig(store.chat(chat.id)!, p, "orch").agent, "grok");
    assert.equal(chats.roleConfig(store.chat(chat.id)!, p, grok.key).effort, p.settings.grokEffort);
    store.updateChat(chat.id, { orchestratorModelOverride: `gemini:${GEMINI_WEB_MODEL}` });
    await assert.rejects(chats.driver(chat.id, "orch"), /마스터는 Antigravity CLI/);
    store.updateChat(chat.id, { orchestratorModelOverride: `gemini:${AISTUDIO_MODEL}`, geminiModelOverride: AISTUDIO_MODEL });
    assert.ok(await chats.driver(chat.id, "orch") instanceof AIStudioDriver);
    assert.ok(await chats.driver(chat.id, old.key, "") instanceof AIStudioDriver);
    await chats.dispose();
    store.close(); store = new Store(path);
    assert.equal(store.chat(chat.id)!.grokModelOverride, "grok-4.6");
    assert.equal(store.chat(chat.id)!.grokEffortOverride, "high");
    assert.equal(store.agent(grok.id)!.sessionId, "grok-worker");
    assert.equal(store.getSetting(`orchSession:${chat.id}:gemini`), "master-gemini");
    assert.equal(store.getSetting(`orchSession:${chat.id}:grok`), "master-grok");
    assert.deepEqual(parseOrchestrator("gemini:gemini-pro"), { agent: "gemini", model: "gemini-pro" });
    assert.deepEqual(parseOrchestrator("grok:grok-4.6"), { agent: "grok", model: "grok-4.6" });
    store.setSetting(`teamMessages:${chat.id}:w1`, "100");
    store.setSetting(`aistudio-context:${chat.id}:orch:${AISTUDIO_MODEL}`, "private history");
    store.deleteChat(chat.id);
    assert.equal(store.getSetting(`aistudio-context:${chat.id}:orch:${AISTUDIO_MODEL}`), undefined);
    assert.equal(store.getSetting(`orchSession:${chat.id}:grok`), undefined);
    assert.equal(store.getSetting(`teamMessages:${chat.id}:w1`), undefined);
    const next = store.createChat(p.id, "new conversation");
    store.setSetting(`orchSession:${next.id}:gemini`, "new-native");
    store.setSetting(`aistudio-context:${next.id}:orch:${AISTUDIO_MODEL}`, "private history");
    store.deleteProject(p.id);
    assert.equal(store.getSetting(`aistudio-context:${next.id}:orch:${AISTUDIO_MODEL}`), undefined);
    assert.equal(store.getSetting(`orchSession:${next.id}:gemini`), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity and Grok publish validated image tool outputs as durable app attachments", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-provider-images-"));
  const store = new Store(join(root, "app.db"));
  try {
    const project = store.createProject("images", root, DEFAULT_SETTINGS), chat = store.createChat(project.id, "images");
    const attachments = new AttachmentStore(join(root, "attachments"), store);
    const path = join(root, "flower.png"), invalid = join(root, "fake.png");
    writeFileSync(path, Buffer.from(png, "base64")); writeFileSync(invalid, "not an image");
    const events: any[] = [];
    const host = { emit: (e: any) => events.push(e), nativeId() {}, approve: async () => ({ verdict: "allow" as const }), image: (i: any) => attachments.generatedImage(chat.id, i) };
    assert.equal(publishGeneratedImages([invalid, join(root, "missing.png")], "invalid", host), 0);
    assert.equal(publishGeneratedImages({ path, repeated: path }, "valid", host), 1);
    const grok = new GrokDriver({ cwd: root, nativeId: "s", exePath: "unused" }, () => ({}), host);
    (grok as any)._running = true;
    await grok.hook({ sessionId: "s", hookCallbackId: "chatterbox-approval", hookEventName: "pre_tool_use", toolUseId: "image", toolName: "image_gen", toolInput: { prompt: "flower" } });
    grok.onUpdate({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "image", status: "completed", rawOutput: { path } } });
    const gemini = new GeminiDriver({ cwd: root, nativeId: "a", exePath: "unused" }, { bridge: {} as any, hookScript: "unused", tmpDir: root }, host);
    Object.assign(gemini, { _running: true, hooksReady: true, noWrites: false });
    const payload = { conversationId: "a", stepIdx: 1, toolCall: { name: "generate_image", args: { Prompt: "flower" } } };
    assert.equal((await gemini.hook("pre", payload)).decision, "auto_approve");
    await gemini.hook("post", { ...payload, toolResponse: `![image](${path})` });
    assert.equal(events.filter(e => e.type === "image_generation" && e.status === "done").length, 3);
    assert.ok(events.filter(e => e.type === "image_generation").every(e => e.attachment.mime === "image/png" && e.attachment.path !== path));
    // Merely viewing a reference image is not an image generation result.
    grok.onUpdate({ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed", content: [{ type: "image", data: png }] } });
    assert.equal(events.filter(e => e.type === "image_generation").length, 3);
    // The documented hook has only the artifact directory and tool call, without toolResponse.
    const official = { ...payload, stepIdx: 2, artifactDirectoryPath: root };
    await gemini.hook("pre", official);
    writeFileSync(join(root, "fresh-image.png"), Buffer.from(png, "base64"));
    await gemini.hook("post", official);
    assert.equal(events.filter(e => e.type === "image_generation").length, 4);
    await gemini.hook("post", official);
    assert.equal(events.filter(e => e.type === "image_generation").length, 4);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

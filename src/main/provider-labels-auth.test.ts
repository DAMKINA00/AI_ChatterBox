import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { claudeAuthStatus } from "./cli-auth";
import { grokAuthMethod } from "./drivers/grok";
import { DEFAULT_SETTINGS } from "../shared/types";

test("default provider names migrate without changing identities, custom names or histories", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-labels-"));
  const file = join(root, "test.db");
  let store = new Store(file);
  try {
    const project = store.createProject("test", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "history");
    const agents = (["claude", "gpt", "gemini", "grok"] as const).map(kind => store.createAgent(chat.id, kind, "keep job"));
    for (const [i, old] of ["Claude", "짚피티", "Antigravity", "Grok"].entries()) {
      store.db.prepare("UPDATE agents SET nickname = ?, session_id = ?, status = 'released' WHERE id = ?").run(`${old} 1호`, `session-${i}`, agents[i].id);
    }
    store.db.prepare("UPDATE agents SET web_account_id = 'gemini-4' WHERE id = ?").run(agents[2].id);
    store.db.prepare("INSERT INTO agents(chat_id,kind,number,nickname,job,created_at) VALUES (?, 'gemini', 2, 'Antigravity 연구 담당', 'custom', 1)").run(chat.id);
    const before = store.listAgents(chat.id);
    store.close(); store = new Store(file);
    const after = store.listAgents(chat.id);
    assert.deepEqual(after.map(a => a.nickname), ["클로드 1호", "지피티 1호", "제미나이 1호", "그록 1호", "Antigravity 연구 담당"]);
    assert.deepEqual(after.map(({ nickname, ...a }) => a), before.map(({ nickname, ...a }) => a));
    store.close(); store = new Store(file);
    assert.deepEqual(store.listAgents(chat.id), after);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("authentication needs explicit evidence, never CLI installation or a model catalogue", () => {
  assert.equal(claudeAuthStatus('{"loggedIn":true}'), "authenticated");
  assert.equal(claudeAuthStatus('{"loggedIn":false}'), "required");
  for (const value of ["", "not json", "null", "{}", '{"loggedIn":"true"}']) assert.equal(claudeAuthStatus(value), "unknown");
  assert.equal(grokAuthMethod({ authMethods: [{ id: "oauth" }] }), undefined);
  assert.equal(grokAuthMethod({ _meta: { modelState: { availableModels: [{ modelId: "grok" }] } } }), undefined);
  assert.equal(grokAuthMethod({ authMethods: [{ id: "cached_token" }] }), "cached_token");
  assert.equal(grokAuthMethod({ _meta: { defaultAuthMethodId: "xai.api_key" } }), "xai.api_key");
});

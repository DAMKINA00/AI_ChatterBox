import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { DEFAULT_SETTINGS, type AgentKind, type ModelOption, type ProjectSettings, type TimelineEvent, type WorkerKind } from "../shared/types";
import type { ApprovalInput } from "./approvals";

const levels = ["medium", "high", "xhigh"];

function model(id: string, isDefault = false): ModelOption {
  return { id, label: id, isDefault, reasoningEfforts: levels };
}

function fixture(settings: ProjectSettings = DEFAULT_SETTINGS) {
  const root = mkdtempSync(join(tmpdir(), "cbx-approval-effort-settings-"));
  const dbPath = join(root, "test.db");
  const store = new Store(dbPath);
  const project = store.createProject("test", root, settings);
  const chat = store.createChat(project.id, "test");
  const events: TimelineEvent[] = [];
  const chats = new ChatManager(store, {
    agents() {},
    event(e) { events.push(e); },
    chat() {},
    consult() {},
    usage() {},
  }, root, "unused");
  const fakeModels: Record<AgentKind, ModelOption[]> = {
    claude: [model("opus", true), model("claude-worker")],
    codex: [model("gpt-6-astra", true), model("codex-worker")],
    gemini: [model("gemini-worker", true)],
    grok: [model("grok-worker", true)],
    deepseek: [model("deepseek-worker", true)],
  };
  chats.models = async (agent) => fakeModels[agent];
  return {
    root,
    dbPath,
    store,
    project,
    chat,
    chats,
    events,
    async close() {
      await chats.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("legacy project approval settings migrate delegation into orchestrator-all", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-approval-mode-migration-"));
  const dbPath = join(root, "test.db");
  let store: Store | undefined;
  try {
    store = new Store(dbPath);
    const project = store.createProject("legacy", root, DEFAULT_SETTINGS);
    const legacy = { ...DEFAULT_SETTINGS, approvalMode: "orchestrator" as const, delegateHighRisk: true };
    store.db.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").run(JSON.stringify(legacy), project.id);
    store.close();
    store = new Store(dbPath);

    const settings = store.project(project.id)!.settings;
    assert.equal(settings.approvalMode, "orchestrator-all");
    assert.equal(settings.delegateHighRisk, true);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ChatManager approval host applies the effective per-chat mode override", async () => {
  const f = fixture({ ...DEFAULT_SETTINGS, approvalMode: "orchestrator-all", delegateHighRisk: true });
  try {
    const host = (f.chats.approvals as any).host as { mode(chatId: number): { mode: string; delegateHighRisk: boolean } };
    assert.deepEqual(host.mode(f.chat.id), { mode: "orchestrator-all", delegateHighRisk: true });

    f.store.updateChat(f.chat.id, { approvalModeOverride: "orchestrator", touch: true });
    assert.deepEqual(host.mode(f.chat.id), { mode: "orchestrator", delegateHighRisk: false });

    f.chats.judge = async () => ({ decision: "allow", reason: "test" });
    const critical: ApprovalInput = { role: "orch", node: "orch", title: "Push", detail: "git push", key: "push", command: "git push" };
    const pending = f.chats.approvals.request(f.chat.id, f.root, critical);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = f.events.findLast((e) => e.event.type === "approval_request");
    assert.ok(request?.event.type === "approval_request");
    if (request?.event.type === "approval_request") f.chats.approvals.answer(f.chat.id, request.event.request.id, "once");
    assert.equal((await pending).verdict, "allow");

    f.store.updateChat(f.chat.id, { approvalModeOverride: null, touch: true });
    assert.deepEqual(host.mode(f.chat.id), { mode: "orchestrator-all", delegateHighRisk: true });
    assert.equal((await f.chats.approvals.request(f.chat.id, f.root, critical)).verdict, "allow");
  } finally {
    await f.close();
  }
});

test("workers ignore stale per-chat effort overrides and use project manual settings", async () => {
  const f = fixture({
    ...DEFAULT_SETTINGS,
    orchestratorModel: "claude:opus",
    claudeModel: "claude-worker",
    codexModel: "codex-worker",
    geminiModel: "gemini-worker",
    grokModel: "grok-worker",
    deepseekModel: "deepseek-worker",
    claudeEffort: "high",
    codexEffort: "medium",
    geminiEffort: "high",
    grokEffort: "xhigh",
    deepseekEffort: "medium",
  });
  try {
    f.store.updateChat(f.chat.id, {
      claudeEffortOverride: "legacy-stale",
      codexEffortOverride: "legacy-stale",
      geminiEffortOverride: "legacy-stale",
      grokEffortOverride: "legacy-stale",
      deepseekEffortOverride: "legacy-stale",
      touch: true,
    });
    const workers: Array<[WorkerKind, string]> = [
      ["claude", "high"],
      ["gpt", "medium"],
      ["gemini", "high"],
      ["grok", "xhigh"],
      ["deepseek", "medium"],
    ];
    for (const [kind, expected] of workers) {
      const worker = f.store.createAgent(f.chat.id, kind, `${kind} worker`);
      const chat = f.store.chat(f.chat.id)!;
      const project = f.store.project(f.project.id)!;
      assert.equal(f.chats.roleConfig(chat, project, worker.key).effort, expected, kind);
      assert.deepEqual(await f.chats.assignmentEffort(f.chat.id, worker.key, "medium"), { requestedEffort: "medium", effort: expected }, kind);
    }
  } finally {
    await f.close();
  }
});

test("master auto effort is empty while an explicit chat override is retained", async () => {
  const f = fixture({ ...DEFAULT_SETTINGS, orchestratorModel: "claude:opus", orchestratorEffort: "auto" });
  try {
    assert.deepEqual(await f.chats.assignmentEffort(f.chat.id, "orch"), { requestedEffort: "", effort: "" });
    f.store.updateChat(f.chat.id, { orchestratorEffortOverride: "high", touch: true });
    assert.deepEqual(await f.chats.assignmentEffort(f.chat.id, "orch"), { requestedEffort: "high", effort: "high" });
  } finally {
    await f.close();
  }
});

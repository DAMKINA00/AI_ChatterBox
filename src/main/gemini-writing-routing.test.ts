import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, GEMINI_WEB_MODEL, type AgentEvent, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { completionIssue } from "./dispatch";
import { Orchestrator } from "./orchestrator";

import type { AgentInput } from "./drivers/types";

type Sent = { role: Role; effort?: string; input: AgentInput };

function fixture(options: { geminiModel?: string; geminiStrengths?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cbx-gemini-writing-routing-"));
  const dbPath = join(root, "test.db");
  const geminiModel = options.geminiModel ?? GEMINI_WEB_MODEL;
  const settings = {
    ...DEFAULT_SETTINGS,
    geminiModel,
    geminiStrengths: options.geminiStrengths ?? DEFAULT_SETTINGS.geminiStrengths,
  };
  const store = new Store(dbPath);
  const project = store.createProject("test", root, settings);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.cliInfo = () => [
    { agent: "claude", path: null, error: "stub" },
    { agent: "codex", path: null, error: "stub" },
    { agent: "gemini", path: geminiModel === GEMINI_WEB_MODEL ? null : "agy.exe" },
  ];
  chats.models = async (agent) => [{
    id: agent === "claude" ? "opus" : agent === "codex" ? "gpt-6-astra" : geminiModel,
    label: agent,
    isDefault: true,
    reasoningEfforts: ["medium", "high", "xhigh"],
  }];
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, {
    id: 1,
    mode: "delegated",
    text: "writing routing regression",
    asks: 0,
    reviews: 0,
    startedAt: Date.now(),
    requests: new Map(),
    queued: [],
    pinned: [],
  });
  const sent: Sent[] = [];
  const codeChanges = new Set<Role>();
  chats.driver = async (_chatId, role, effort) => ({
    agent: store.agentByKey(chat.id, role)?.kind === "gemini" ? "gemini" as const : "claude" as const,
    running: false,
    stop: async () => {},
    dispose: async () => {},
    send: async (input: AgentInput) => {
      sent.push({ role, effort, input });
      if (codeChanges.has(role)) {
        const event: AgentEvent = {
          type: "file_change",
          id: `change-${role}`,
          ok: true,
          files: [{ path: "src/change.ts", kind: "update", diff: "+export const changed = true;" }],
        };
        chats.onDriverEvent?.(chat.id, role, event);
      }
      chats.onDriverEvent?.(chat.id, role, { type: "text", text: "작성 결과" });
      chats.onDriverEvent?.(chat.id, role, { type: "turn_end", ok: true });
    },
  });
  let closed = false;
  return {
    root,
    dbPath,
    store,
    project,
    chat,
    chats,
    engine,
    sent,
    codeChanges,
    async close(keepFiles = false) {
      if (closed) return;
      closed = true;
      await engine.judge.dispose();
      await chats.dispose();
      store.close();
      if (!keepFiles) rmSync(root, { recursive: true, force: true });
    },
  };
}

const call = (engine: any, chatId: number, caller: Role, kind: string, to: string) =>
  engine.call(chatId, caller, "ask", { to, kind, message: `${kind} 요청`, reason: "writing routing regression", effort: "medium" });

test("Antigravity accepts explicit code, review and writing; web retains local-tool limits", async () => {
  for (const geminiModel of [GEMINI_WEB_MODEL, "gemini-test-medium"]) {
    const f = fixture({ geminiModel });
    try {
      const worker = f.store.createAgent(f.chat.id, "gemini", "assigned work");
      if (geminiModel === GEMINI_WEB_MODEL) f.store.updateAgent(worker.id, { webAccountId: "gemini-4" });
      for (const kind of ["implement", "review", "opinion", "writing"] as const) {
        const result = await call(f.engine, f.chat.id, "orch", kind, worker.nickname);
        const blocked = geminiModel === GEMINI_WEB_MODEL && kind === "implement";
        assert.equal(result.isError, blocked, `${geminiModel} ${kind}`);
        if (!blocked) assert.equal(f.sent.at(-1)!.input.noWrites, kind !== "implement");
        else assert.match(result.content[0].text, /로컬 파일/);
      }
      assert.ok(f.store.listConsults(f.chat.id).every(c => c.status === "done"));
    } finally { await f.close(); }
  }
});

test("technical questions can cross Antigravity peers without granting implementation from review", async () => {
  const f = fixture({ geminiModel: "gemini-test-medium" });
  try {
    const gemini = f.store.createAgent(f.chat.id, "gemini", "technical peer");
    const claude = f.store.createAgent(f.chat.id, "claude", "technical work");
    for (const [from, to] of [[claude, gemini], [gemini, claude]]) {
      for (const kind of ["review", "opinion"]) {
        assert.equal((await call(f.engine, f.chat.id, from.key, kind, to.nickname)).isError, false);
      }
      assert.equal((await call(f.engine, f.chat.id, from.key, "implement", to.nickname)).isError, true);
    }
    assert.ok(f.sent.every(s => s.input.noWrites));
  } finally { await f.close(); }
});

test("explicit assignments override default specialities while preserving custom preferences", async () => {
  const f = fixture({ geminiModel: "legacy-gemini", geminiStrengths: "코드 분석과 구현을 우선 담당" });
  try {
    const worker = f.store.createAgent(f.chat.id, "gemini", "technical preference");
    const master = f.chats.instructionsFor!(f.chat, f.project, "orch", "claude")!;
    const instructions = f.chats.instructionsFor!(f.chat, f.project, worker.key, "gemini")!;
    assert.match(master, /코드 분석과 구현을 우선 담당/);
    assert.match(master, /명시적으로/);
    assert.doesNotMatch(instructions, /글쓰기 전용|코드 분석·구현·디버깅·테스트·기술 리뷰·교차검증은 맡지 않는다/);
    const capabilities = await f.chats.teamCapabilities(f.chat);
    assert.deepEqual(new Set(capabilities.gemini.supportedKinds), new Set(["implement", "review", "opinion", "writing"]));
    assert.equal(capabilities.gemini.fileWrites, true);
    assert.equal(capabilities.gemini.localTools, true);
    assert.equal(capabilities.gemini.webOnly, false);
  } finally { await f.close(); }
});

test("a writing result does not satisfy the code review gate, while its kind survives DB reload", async () => {
  const f = fixture({ geminiModel: "gemini-test-medium" });
  try {
    const claude = f.store.createAgent(f.chat.id, "claude", "implementation");
    const gemini = f.store.createAgent(f.chat.id, "gemini", "writing");
    f.codeChanges.add(claude.key);
    const implementation = await f.engine.call(f.chat.id, "orch", "ask", {
      to: claude.nickname,
      kind: "implement",
      message: "구현",
      reason: "코드 변경",
      effort: "medium",
      scope: ["src/change.ts"],
    });
    assert.equal(implementation.isError, false);
    const writing = await call(f.engine, f.chat.id, "orch", "writing", gemini.nickname);
    assert.equal(writing.isError, false);
    const records = f.store.listConsults(f.chat.id);
    assert.deepEqual(records.map((consult) => consult.kind), ["implement", "writing"]);
    assert.match(completionIssue(1, "delegated", records, true) ?? "", /교차 리뷰/);

    const dbPath = f.dbPath;
    await f.close(true);
    const reloaded = new Store(dbPath);
    try {
      assert.equal(reloaded.listConsults(f.chat.id).find((consult) => consult.kind === "writing")?.kind, "writing");
    } finally {
      reloaded.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  } catch (error) {
    await f.close();
    throw error;
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, GEMINI_WEB_MODEL, type AgentEvent, type AgentInput, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { completionIssue } from "./dispatch";
import { Orchestrator } from "./orchestrator";

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

test("Gemini web and CLI accept writing only, pass noWrites, and persist a writing consult", async () => {
  for (const geminiModel of [GEMINI_WEB_MODEL, "gemini-test-medium"]) {
    const f = fixture({ geminiModel });
    try {
      const worker = f.store.createAgent(f.chat.id, "gemini", "writing task");
      for (const kind of ["implement", "review", "opinion"] as const) {
        const rejected = await call(f.engine, f.chat.id, "orch", kind, worker.nickname);
        assert.equal(rejected.isError, true, `${geminiModel} should reject ${kind}`);
        assert.match(rejected.content.map((part) => part.text).join("\n"), /글쓰기 전용/);
      }
      assert.equal(f.store.listConsults(f.chat.id).length, 0);

      const accepted = await call(f.engine, f.chat.id, "orch", "writing", worker.nickname);
      assert.equal(accepted.isError, false);
      assert.deepEqual(f.store.listConsults(f.chat.id).map((consult) => [consult.kind, consult.status]), [["writing", "done"]]);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].input.noWrites, true);
      assert.match(f.sent[0].input.text, /글쓰기 요청/);
    } finally {
      await f.close();
    }
  }
});

test("technical requests cannot cross into or out of a Gemini worker", async () => {
  const f = fixture({ geminiModel: "gemini-test-medium" });
  try {
    const gemini = f.store.createAgent(f.chat.id, "gemini", "writing only");
    const claude = f.store.createAgent(f.chat.id, "claude", "technical work");
    for (const kind of ["implement", "review", "opinion"] as const) {
      const intoGemini = await call(f.engine, f.chat.id, claude.key, kind, gemini.nickname);
      const outOfGemini = await call(f.engine, f.chat.id, gemini.key, kind, claude.nickname);
      assert.equal(intoGemini.isError, true, `other worker -> Gemini ${kind}`);
      assert.equal(outOfGemini.isError, true, `Gemini -> other worker ${kind}`);
    }
    assert.equal(f.store.listConsults(f.chat.id).length, 0);
  } finally {
    await f.close();
  }
});

test("legacy technical Gemini preferences cannot widen prose-only instructions or capabilities", async () => {
  const f = fixture({ geminiModel: "legacy-gemini", geminiStrengths: "코드 분석과 구현을 우선 담당" });
  try {
    const worker = f.store.createAgent(f.chat.id, "gemini", "legacy technical preference");
    const masterInstructions = f.chats.instructionsFor!(f.chat, f.project, "orch", "claude")!;
    const workerInstructions = f.chats.instructionsFor!(f.chat, f.project, worker.key, "gemini")!;
    assert.match(masterInstructions, /코드 분석과 구현을 우선 담당/);
    assert.match(masterInstructions, /제미나이는 .*글쓰기 전용/);
    assert.match(workerInstructions, /글쓰기 전용/);
    assert.match(workerInstructions, /코드 분석·구현·디버깅·테스트·기술 리뷰·교차검증은 맡지 않는다/);

    const capabilities = await f.chats.teamCapabilities(f.chat);
    assert.deepEqual(capabilities.gemini.supportedKinds, ["writing"]);
    assert.equal(capabilities.gemini.fileWrites, false);
    assert.equal(capabilities.gemini.localTools, true);
    assert.equal(capabilities.gemini.webOnly, false);
  } finally {
    await f.close();
  }
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

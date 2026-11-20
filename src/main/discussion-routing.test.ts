import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentKind, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

import type { AgentInput } from "./drivers/types";

type Sent = { role: Role; effort?: string; input: AgentInput };
type Behavior = (input: AgentInput, role: Role) => Promise<void> | void;

function fixture(options: { dualInvestigation?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cbx-discussion-routing-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.models = async (agent) => [{
    id: agent === "claude" ? "opus" : agent === "codex" ? "gpt-6-astra" : "gemini-4-argon-medium",
    label: agent,
    isDefault: true,
    reasoningEfforts: ["medium", "high", "xhigh"],
  }];
  chats.cliInfo = () => [{ agent: "gemini", path: "fake-agy" }, { agent: "grok", path: "fake-grok" }, { agent: "claude", path: "fake-claude" }, { agent: "codex", path: "fake-codex" }];
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, {
    id: 1,
    mode: "delegated",
    dualInvestigation: !!options.dualInvestigation,
    text: "discussion routing regression",
    asks: 0,
    reviews: 0,
    startedAt: Date.now(),
    requests: new Map(),
    queued: [],
    pinned: [],
  });

  const sent: Sent[] = [];
  const behavior = new Map<Role, Behavior>();
  const cycleResponses: any[] = [];
  let writeGuardError: string | null = null;

  const finish = (role: Role, text = `${role} response`) => {
    chats.onDriverEvent?.(chat.id, role, { type: "text", text });
    chats.onDriverEvent?.(chat.id, role, { type: "turn_end", ok: true });
  };
  const agentFor = (role: Role): AgentKind => {
    if (role === "orch") return "claude";
    const kind = store.agentByKey(chat.id, role)?.kind;
    return kind === "gpt" ? "codex" : kind === "gemini" ? "gemini" : kind === "grok" ? "grok" : "claude";
  };

  chats.driver = async (_chatId, role, effort) => ({
    agent: agentFor(role),
    running: false,
    stop: async () => {},
    dispose: async () => {},
    send: async (input: AgentInput) => {
      sent.push({ role, effort, input });
      const action = behavior.get(role);
      if (action) await action(input, role);
      else finish(role);
    },
  });

  let closed = false;
  return {
    root,
    store,
    project,
    chat,
    chats,
    engine,
    sent,
    behavior,
    cycleResponses,
    get writeGuardError() { return writeGuardError; },
    setWriteGuardError(value: string | null) { writeGuardError = value; },
    finish,
    async close() {
      if (closed) return;
      closed = true;
      await engine.judge.dispose();
      await chats.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function ask(
  f: ReturnType<typeof fixture>,
  caller: Role,
  target: { nickname: string },
  kind: "opinion" | "writing" | "implement" | "review",
  options: { message?: string; effort?: string; discussion?: { topic: string; peers: string[] } } = {},
) {
  const args: any = {
    to: target.nickname,
    kind,
    message: options.message ?? `${kind} request`,
  };
  if (caller === "orch") {
    args.reason = "discussion routing regression";
    args.effort = options.effort ?? "high";
  }
  if (options.discussion !== undefined) { args.discussion = options.discussion; if (caller === "orch") args.summary = true; }
  return f.engine.call(f.chat.id, caller, "ask", args);
}

function textOf(result: any): string {
  return result.content.map((part: { text: string }) => part.text).join("\n");
}

test("group messages and peer results reach every inbox and remain visible without nested cards", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "writer");
    const b = f.store.createAgent(f.chat.id, "gpt", "reviewer");
    assert.equal((await f.engine.call(f.chat.id, "orch", "send_message", { to: "all", message: "공통 쟁점과 근거" })).isError, false);
    assert.match(textOf(await f.engine.call(f.chat.id, a.key, "read_messages", {})), /공통 쟁점과 근거/);
    assert.match(textOf(await f.engine.call(f.chat.id, b.key, "read_messages", {})), /공통 쟁점과 근거/);
    assert.doesNotMatch(textOf(await f.engine.call(f.chat.id, b.key, "read_messages", {})), /공통 쟁점과 근거/);
    f.behavior.set(a.key, async (_input, role) => {
      const sent = await f.engine.call(f.chat.id, role, "send_message", { to: "all", message: "반론: 실제 자료를 확인했습니다." });
      assert.equal(sent.isError, false);
      f.finish(role, "근거를 반영한 제안");
    });
    await ask(f, "orch", a, "opinion");
    const inbox = textOf(await f.engine.call(f.chat.id, b.key, "read_messages", {}));
    assert.match(inbox, /반론:/);
    assert.doesNotMatch(inbox, /근거를 반영한 제안/);
    const id = f.store.listConsults(f.chat.id)[0].id;
    assert.match(inbox, new RegExp(`협의 id=${id}`));
    assert.match(textOf(await f.engine.call(f.chat.id, b.key, "read_consult", { consultId: id })), /근거를 반영한 제안/);
    assert.equal(f.store.events(f.chat.id).filter(e => e.event.type === "room_message").length, 3);
  } finally { await f.close(); }
});

test("master receives only a receipt; workers can retrieve excerpts and full reports without data loss", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "report");
    const report = "RESULT_START\n" + "private detailed evidence\n".repeat(600) + "\nRESULT_END: remaining risk";
    const paths = Array.from({ length: 30 }, (_, i) => `output/result-${i}.md`);
    f.behavior.set(worker.key, (_input, role) => {
      f.chats.onDriverEvent!(f.chat.id, role, { type: "file_change", id: "write", ok: true, files: paths.map(path => ({ path, kind: "add" as const })) });
      f.finish(role, report);
    });
    const result = await ask(f, "orch", worker, "opinion");
    assert.equal(result.isError, false);
    const body = textOf(result);
    assert.doesNotMatch(body, /RESULT_START|RESULT_END|private detailed evidence/);
    assert.ok(body.length < 150, "ordinary master results contain only a small receipt");
    const saved = f.store.listConsults(f.chat.id)[0];
    assert.ok(saved.responseSummary!.endsWith(report), "stored report remains intact");
    assert.deepEqual(saved.filesChanged, paths);
    const excerpt = textOf(await f.engine.call(f.chat.id, worker.key, "read_consult", { consultId: saved.id }));
    assert.match(excerpt, /RESULT_START/);
    assert.match(excerpt, /RESULT_END: remaining risk/);
    assert.match(excerpt, /중간 내용 생략/);
    assert.ok(excerpt.length < 3000);
    const status = textOf(await f.engine.call(f.chat.id, "orch", "agents", {}));
    assert.doesNotMatch(status, /RESULT_START|private detailed evidence/);
    assert.match(status, /파일 30개/);
    const check = textOf(await f.engine.call(f.chat.id, "orch", "check_agent", { to: worker.nickname }));
    assert.ok(check.length < 3000);
    let full = "", offset: number | null = 0;
    f.engine.instructions.get(f.chat.id).queued.push({ text: "new user constraint", attachments: [] });
    while (offset !== null) {
      const response = await f.engine.call(f.chat.id, "orch", "read_consult", { consultId: saved.id, detail: true, offset, limit: 701 });
      const page = JSON.parse(response.content[0].text);
      if (!offset) assert.match(response.content[1].text, /new user constraint/);
      assert.ok(page.text.length <= 701);
      full += page.text;
      offset = page.nextOffset;
    }
    const decoded = JSON.parse(full);
    assert.equal(decoded.responseSummary, saved.responseSummary);
    assert.deepEqual(decoded.filesChanged, paths);
    assert.equal(f.sent.length, 1, "retrieval must never rerun a worker");
    assert.deepEqual(f.store.consult(saved.id), saved);
  } finally { await f.close(); }
});

test("saved result broadcasts are compacted while direct peer messages keep their full content", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "peer");
    await ask(f, "orch", worker, "opinion");
    const c = f.store.listConsults(f.chat.id)[0];
    f.store.addEvent(f.chat.id, "orch", worker.key, { type: "room_message", from: worker.key, kind: "result", consultId: c.id, status: "done", text: "OLD_REPORT_COPY".repeat(300) });
    f.store.addEvent(f.chat.id, "orch", worker.key, { type: "peer_message", from: worker.key, to: "orch", text: "Important direct question" });
    const inbox = textOf(await f.engine.call(f.chat.id, "orch", "read_messages", {}));
    assert.doesNotMatch(inbox, /OLD_REPORT_COPY/);
    assert.match(inbox, /협의 id=/);
    assert.match(inbox, /Important direct question/);
    assert.equal(textOf(await f.engine.call(f.chat.id, "orch", "read_messages", {})), "새 협업 메시지가 없습니다.");
    assert.ok(f.store.events(f.chat.id).some(e => e.event.type === "room_message" && e.event.text.includes("OLD_REPORT_COPY")), "legacy timeline remains intact");
  } finally { await f.close(); }
});

test("consult retrieval rejects foreign chats and invalid page parameters", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "peer");
    await ask(f, "orch", worker, "opinion");
    const c = f.store.listConsults(f.chat.id)[0];
    const other = f.store.createChat(f.project.id, "other");
    assert.equal((await f.engine.call(other.id, "orch", "read_consult", { consultId: c.id, detail: true })).isError, true);
    for (const invalid of [{ consultId: "1" }, { consultId: 99999 }, { detail: "true" }, { offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 8001 }]) {
      assert.equal((await f.engine.call(f.chat.id, "orch", "read_consult", { consultId: c.id, ...invalid })).isError, true);
    }
  } finally { await f.close(); }
});

test("parallel assignments are consolidated by a worker who can verify directly with peers", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "collector");
    const b = f.store.createAgent(f.chat.id, "gpt", "peer");
    let collected = false;
    f.behavior.set(a.key, async (input, role) => {
      if (!input.text.includes("[작업자 결과 취합]")) return f.finish(role, "RAW_A_REPORT");
      collected = true;
      const originals = f.store.listConsults(f.chat.id).filter(c => c.status === "done");
      assert.equal(originals.length, 2);
      for (const c of originals) assert.match(textOf(await f.engine.call(f.chat.id, role, "read_consult", { consultId: c.id })), /RAW_[AB]_REPORT/);
      const clarification = await f.engine.call(f.chat.id, role, "ask", { to: b.nickname, kind: "opinion", message: "confirm test evidence" });
      assert.match(textOf(clarification), /peer confirmed/);
      f.finish(role, "CONSOLIDATED: verification complete, output/result.md");
    });
    f.behavior.set(b.key, (input, role) => f.finish(role, input.text.includes("confirm test evidence") ? "peer confirmed" : "RAW_B_REPORT"));
    const result = await f.engine.call(f.chat.id, "orch", "ask_parallel", { coordinator: a.nickname, tasks: [a, b].map(w => ({ to: w.nickname, kind: "opinion", message: "bounded task", reason: "independent work" })) });
    assert.equal(result.isError, false);
    assert.ok(collected);
    assert.match(textOf(result), /CONSOLIDATED/);
    assert.doesNotMatch(textOf(result), /RAW_A_REPORT|RAW_B_REPORT|peer confirmed/);
    assert.equal(f.store.listConsults(f.chat.id).length, 4);
    assert.equal(f.engine.parallelBatches.size, 0);
  } finally { await f.close(); }
});

test("failed work cannot be hidden by a successful consolidated report", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "collector");
    const b = f.store.createAgent(f.chat.id, "gpt", "failed peer");
    f.behavior.set(a.key, (input, role) => f.finish(role, input.text.includes("[작업자 결과 취합]") ? "everything looks done" : "part A done"));
    f.behavior.set(b.key, (_input, role) => f.chats.onDriverEvent!(f.chat.id, role, { type: "turn_end", ok: false, error: "provider unavailable" }));
    const result = await f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [a, b].map(w => ({ to: w.nickname, kind: "opinion", message: "task", reason: "test" })) });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /error/);
    assert.equal(f.store.listConsults(f.chat.id).filter(c => c.status === "error").length, 1);
  } finally { await f.close(); }
});

test("independent reports return the completed result and the failure without a collector turn", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "reporter");
    const b = f.store.createAgent(f.chat.id, "gpt", "failed peer");
    f.behavior.set(a.key, (_input, role) => f.finish(role, "verified: part A"));
    f.behavior.set(b.key, (_input, role) => f.chats.onDriverEvent!(f.chat.id, role, { type: "turn_end", ok: false, error: "provider unavailable" }));
    const tasks = [a, b].map(w => ({ to: w.nickname, kind: "opinion", message: "independent check", reason: "test" }));
    assert.equal((await f.engine.call(f.chat.id, "orch", "ask_parallel", { coordinator: a.nickname, reportsOnly: true, tasks })).isError, true);
    assert.equal(f.sent.length, 0);

    const result = await f.engine.call(f.chat.id, "orch", "ask_parallel", { reportsOnly: true, tasks });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /verified: part A/);
    assert.match(textOf(result), /provider unavailable/);
    assert.deepEqual(new Set(result.structuredContent.consultIds), new Set(f.store.listConsults(f.chat.id).map(c => c.id)));
    assert.equal(f.sent.length, 2);
    assert.equal(f.engine.parallelBatches.size, 0);
  } finally { await f.close(); }
});

test("stop after parallel work never launches an automatic collector", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "a");
    const b = f.store.createAgent(f.chat.id, "gpt", "b");
    f.behavior.set(b.key, (_input, role) => { f.finish(role); f.engine.stopped.add(f.chat.id); });
    const result = await f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [a, b].map(w => ({ to: w.nickname, kind: "opinion", message: "task", reason: "test" })) });
    assert.equal(result.isError, true);
    assert.equal(f.sent.length, 2);
    assert.equal(f.engine.parallelBatches.size, 0);
  } finally { await f.close(); }
});

test("an interrupted master waits through worker consolidation before its continuation", async () => {
  const f = fixture();
  let releaseWork!: () => void, releaseCollector!: () => void, startedCollector!: () => void;
  const work = new Promise<void>(r => { releaseWork = r; });
  const collecting = new Promise<void>(r => { releaseCollector = r; });
  const started = new Promise<void>(r => { startedCollector = r; });
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "collector");
    const b = f.store.createAgent(f.chat.id, "gpt", "peer");
    const continuations: AgentInput[] = [];
    const master = { agent: "claude" as const, running: true, steer: async () => false, send: async (input: AgentInput) => { continuations.push(input); master.running = true; }, stop: async () => {}, dispose: async () => {} };
    const workerDriver = f.chats.driver;
    f.chats.driver = async (id, role, effort, model) => role === "orch" ? master : workerDriver(id, role, effort, model);
    f.chats.liveDriver = (_id, role) => role === "orch" ? master : undefined;
    for (const worker of [a, b]) f.behavior.set(worker.key, async (input, role) => {
      if (input.text.includes("[작업자 결과 취합]")) { startedCollector(); await collecting; f.finish(role, "final consolidated report"); }
      else { await work; f.finish(role, "part done"); }
    });
    f.store.updateChat(f.chat.id, { status: "working" });
    const pending = f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [a, b].map(w => ({ to: w.nickname, kind: "opinion", message: "task", reason: "test" })) });
    await f.chats.send(f.chat.id, "quick question", [], "now");
    assert.match(textOf(await pending), /quick question/);
    master.running = false;
    assert.equal(f.engine.checkCompletion(f.chat.id, { type: "turn_end", ok: true }), null);
    releaseWork();
    await started;
    await new Promise(r => setImmediate(r));
    assert.equal(continuations.length, 0, "part completion must not wake the master ahead of the collector");
    const batch = [...f.engine.parallelBatches.get(f.chat.id)] as Promise<unknown>[];
    releaseCollector();
    await Promise.all(batch);
    await new Promise(r => setImmediate(r));
    assert.equal(continuations.length, 1);
    assert.match(continuations[0].text, /협의 id=/);
    assert.equal(f.store.listConsults(f.chat.id).length, 3);
  } finally { releaseWork(); releaseCollector(); await f.close(); }
});

test("busy peer receives a live message; a failed steer leaves its inbox unread", async () => {
  const f = fixture();
  try {
    const peer = f.store.createAgent(f.chat.id, "gpt", "busy peer");
    const steers: string[] = [];
    let accept = false;
    f.chats.liveDriver = () => ({ running: true, steer: async (input: AgentInput) => { steers.push(input.text); return accept; } }) as any;
    await f.engine.call(f.chat.id, "orch", "send_message", { to: peer.nickname, message: "first" });
    await new Promise(r => setImmediate(r));
    assert.match(f.engine.readMessages(f.chat.id, peer.key, false), /first/);
    accept = true;
    await f.engine.call(f.chat.id, "orch", "send_message", { to: peer.nickname, message: "second" });
    await new Promise(r => setImmediate(r));
    assert.match(steers.at(-1)!, /first[\s\S]*second/);
    assert.equal(f.engine.readMessages(f.chat.id, peer.key, false), "");
    f.engine.graph(f.chat.id).set(peer.key, new Set(["w99"]));
    await f.engine.call(f.chat.id, "orch", "send_message", { to: peer.nickname, message: "keep the pending peer call alive" });
    await new Promise(r => setImmediate(r));
    assert.equal(steers.length, 2);
    assert.match(f.engine.readMessages(f.chat.id, peer.key, false), /keep the pending peer call alive/);
  } finally { await f.close(); }
});

function consultStarts(f: ReturnType<typeof fixture>) {
  return f.store.events(f.chat.id).filter((event) => event.event.type === "consult_start");
}

test("discussion dispatches a read-only coordinator, records nested worker roles, and returns the final merge", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "technical discussion leader");
    const peerGpt = f.store.createAgent(f.chat.id, "gpt", "independent technical view");
    const peerClaude = f.store.createAgent(f.chat.id, "claude", "second technical view");
    const topic = "safe state transition";
    const nestedResults: any[] = [];

    f.behavior.set(leader.key, async (_input, role) => {
      const [gptResult, claudeResult] = await Promise.all([
        f.engine.call(f.chat.id, role, "ask", { to: peerGpt.nickname, kind: "opinion", message: "초안과 근거를 검토하세요." }),
        f.engine.call(f.chat.id, role, "ask", { to: peerClaude.nickname, kind: "opinion", message: "반론과 확인 질문을 남기세요." }),
      ]);
      nestedResults.push(gptResult, claudeResult);
      f.finish(role, "공통 근거와 이견을 대조한 최종 병합");
    });

    const result = await ask(f, "orch", leader, "opinion", {
      effort: "high",
      message: "초안과 완료 기준을 함께 검토하세요.",
      discussion: { topic, peers: [peerGpt.nickname, peerClaude.nickname] },
    });

    assert.equal(result.isError, false);
    assert.match(textOf(result), /최종 병합/);
    assert.deepEqual(nestedResults.map((item) => item.isError), [false, false]);
    assert.equal(f.sent.length, 3);
    assert.ok(f.sent.every((item) => item.input.noWrites === false));
    assert.ok(f.sent.every((item) => item.effort === "high"));

    const records = f.store.listConsults(f.chat.id);
    assert.equal(records.length, 3);
    const outer = records.find((item) => item.fromRole === "orch");
    assert.ok(outer);
    assert.equal(outer.toRole, leader.key);
    assert.equal(outer.kind, "opinion");
    assert.equal(outer.status, "done");
    assert.match(outer.request, /\[토의 그룹: safe state transition\]/);
    assert.deepEqual(
      records.filter((item) => item.fromRole === leader.key).map((item) => [item.toRole, item.kind, item.status]),
      [[peerGpt.key, "opinion", "done"], [peerClaude.key, "opinion", "done"]],
    );
    assert.ok(records.filter((item) => item.fromRole === leader.key).every((item) => /\[토의 주제: safe state transition\]/.test(item.request)));

    const nestedCards = consultStarts(f).filter((event) => event.event.type === "consult_start" && event.event.from === leader.key);
    assert.equal(nestedCards.length, 2);
    assert.ok(nestedCards.every((event) => event.node === `consult:${outer.id}`));
  } finally {
    await f.close();
  }
});

test("invalid discussion groups dispatch no worker and never create a consult", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "leader");
    const peer = f.store.createAgent(f.chat.id, "claude", "peer");
    const gemini = f.store.createAgent(f.chat.id, "gemini", "writing peer");
    const cases: Array<{ caller: Role; target: { nickname: string }; kind: "opinion" | "writing"; discussion: { topic: string; peers: string[] } }> = [
      { caller: "orch", target: leader, kind: "opinion", discussion: { topic: " ", peers: [peer.nickname] } },
      { caller: "orch", target: leader, kind: "opinion", discussion: { topic: "duplicate", peers: [peer.nickname, peer.nickname] } },
      { caller: "orch", target: leader, kind: "opinion", discussion: { topic: "leader included", peers: [leader.nickname] } },
      { caller: "orch", target: leader, kind: "opinion", discussion: { topic: "unknown", peers: ["클로드 99호"] } },
      { caller: leader.key, target: peer, kind: "opinion", discussion: { topic: "worker expansion", peers: [gemini.nickname] } },
    ];

    for (const item of cases) {
      const result = await ask(f, item.caller, item.target, item.kind, { discussion: item.discussion });
      assert.equal(result.isError, true, JSON.stringify(item));
      assert.equal(f.sent.length, 0, JSON.stringify(item));
      assert.equal(f.store.listConsults(f.chat.id).length, 0, JSON.stringify(item));
    }
  } finally {
    await f.close();
  }
});

test("a coordinator may choose work kinds but must still obtain promised peer replies", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "leader");
    const peer = f.store.createAgent(f.chat.id, "gpt", "required peer");
    const missing = f.store.createAgent(f.chat.id, "claude", "missing peer");
    const outsider = f.store.createAgent(f.chat.id, "claude", "outside group");
    let expansion: any;
    let implementation: any;

    f.behavior.set(leader.key, async (_input, role) => {
      const guard = f.chats.approvalGuard?.(f.chat.id, {
        role,
        node: "orch",
        title: "Write",
        detail: "src/changed.ts",
        key: "Write",
        writes: true,
      });
      f.setWriteGuardError(guard);
      expansion = await f.engine.call(f.chat.id, role, "ask", {
        to: outsider.nickname,
        kind: "opinion",
        message: "expand the group",
        discussion: { topic: "expanded", peers: [peer.nickname, outsider.nickname] },
      });
      implementation = await f.engine.call(f.chat.id, role, "ask", {
        to: peer.nickname,
        kind: "implement",
        message: "write the proposed fix",
      });
      const peerResult = await f.engine.call(f.chat.id, role, "ask", {
        to: peer.nickname,
        kind: "opinion",
        message: "provide the required peer response",
      });
      assert.equal(peerResult.isError, false);
      f.finish(role, "returned before the missing peer participated");
    });

    const result = await ask(f, "orch", leader, "opinion", {
      discussion: { topic: "required participation", peers: [peer.nickname, missing.nickname] },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /토의 미완료/);
    assert.match(textOf(result), new RegExp(missing.nickname));
    assert.equal(f.writeGuardError, null);
    assert.equal(expansion.isError, true);
    assert.match(textOf(expansion), /진행자와 다른/);
    assert.equal(implementation.isError, true);
    assert.match(textOf(implementation), /겹치지 않는 별도 범위/);

    const records = f.store.listConsults(f.chat.id);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((item) => [item.fromRole, item.toRole, item.kind, item.status]), [
      ["orch", leader.key, "opinion", "error"],
      [leader.key, peer.key, "opinion", "done"],
    ]);
    assert.ok(f.sent.every((item) => item.input.noWrites === false));
    assert.equal(f.sent.some((item) => item.role === missing.key || item.role === outsider.key), false);
  } finally {
    await f.close();
  }
});

test("Antigravity participates in writing and technical discussions", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "writing leader");
    const gemini = f.store.createAgent(f.chat.id, "gemini", "prose reviewer");

    f.behavior.set(leader.key, async (_input, role) => {
      const response = await f.engine.call(f.chat.id, role, "ask", {
        to: gemini.nickname,
        kind: _input.text.includes("technical Gemini") ? "opinion" : "writing",
        message: "배정받은 주제를 검토해 주세요.",
      });
      assert.equal(response.isError, false);
      f.finish(role, "Claude와 Gemini의 문장 취합");
    });

    const writing = await ask(f, "orch", leader, "writing", {
      effort: "high",
      message: "장면의 공통 톤을 맞추세요.",
      discussion: { topic: "장면의 말투", peers: [gemini.nickname] },
    });
    assert.equal(writing.isError, false);
    assert.match(textOf(writing), /문장 취합/);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every((item) => item.input.noWrites === false));
    assert.ok(f.sent.every((item) => item.effort === "high"));
    assert.ok(f.store.listConsults(f.chat.id).every((item) => item.status === "done"));

    const sentBeforeTechnical = f.sent.length;
    const recordsBeforeTechnical = f.store.listConsults(f.chat.id).length;
    const technical = await ask(f, "orch", leader, "opinion", {
      discussion: { topic: "technical Gemini", peers: [gemini.nickname] },
    });
    assert.equal(technical.isError, false);
    assert.equal(f.sent.length, sentBeforeTechnical + 2);
    assert.equal(f.store.listConsults(f.chat.id).length, recordsBeforeTechnical + 2);
  } finally {
    await f.close();
  }
});

test("dual-investigation groups wait for independent Claude and GPT reports", async () => {
  const f = fixture({ dualInvestigation: true });
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "lead investigator");
    const peer = f.store.createAgent(f.chat.id, "gpt", "independent investigator");
    const discussionTopic = "intermittent restart";

    const blocked = await ask(f, "orch", leader, "opinion", {
      discussion: { topic: discussionTopic, peers: [peer.nickname] },
    });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /독립 조사 결과를 확보한 뒤 토의/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.listConsults(f.chat.id).length, 0);

    await ask(f, "orch", leader, "opinion", { effort: "medium", message: "independent report" });
    await ask(f, "orch", peer, "opinion", { effort: "medium", message: "independent report" });
    assert.deepEqual(
      f.store.listConsults(f.chat.id).map((item) => [item.fromRole, item.toRole, item.status]),
      [["orch", leader.key, "done"], ["orch", peer.key, "done"]],
    );

    f.behavior.set(leader.key, async (_input, role) => {
      const nested = await f.engine.call(f.chat.id, role, "ask", {
        to: peer.nickname,
        kind: "opinion",
        message: "독립 보고를 토의 주제와 대조해 주세요.",
      });
      assert.equal(nested.isError, false);
      f.finish(role, "독립 보고의 공통점과 차이를 최종 취합");
    });

    const grouped = await ask(f, "orch", leader, "opinion", {
      effort: "high",
      message: "두 보고를 직접 대조하세요.",
      discussion: { topic: discussionTopic, peers: [peer.nickname] },
    });
    assert.equal(grouped.isError, false);
    assert.match(textOf(grouped), /최종 취합/);
    assert.equal(f.store.listConsults(f.chat.id).length, 4);
  } finally {
    await f.close();
  }
});

test("group cycle guard and stop handling remain active", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "leader");
    const peer = f.store.createAgent(f.chat.id, "gpt", "peer");

    f.behavior.set(leader.key, async (_input, role) => {
      const nested = await f.engine.call(f.chat.id, role, "ask", { to: peer.nickname, kind: "opinion", message: "ask peer" });
      assert.equal(nested.isError, false);
      f.finish(role, "cycle-safe merge");
    });
    f.behavior.set(peer.key, async (_input, role) => {
      const cycle = await f.engine.call(f.chat.id, role, "ask", { to: leader.nickname, kind: "opinion", message: "ask leader back" });
      f.cycleResponses.push(cycle);
      f.finish(role, "peer answered without recursion");
    });

    const grouped = await ask(f, "orch", leader, "opinion", {
      discussion: { topic: "cycle guard", peers: [peer.nickname] },
    });
    assert.equal(grouped.isError, false);
    assert.equal(f.cycleResponses.length, 1);
    assert.equal(f.cycleResponses[0].isError, true);
    assert.match(textOf(f.cycleResponses[0]), /교착 방지/);
    assert.equal(f.store.listConsults(f.chat.id).some((item) => item.fromRole === peer.key && item.toRole === leader.key), false);

    const stopped = fixture();
    try {
      const stoppedLeader = stopped.store.createAgent(stopped.chat.id, "claude", "leader");
      const stoppedPeer = stopped.store.createAgent(stopped.chat.id, "gpt", "peer");
      await stopped.engine.stop(stopped.chat.id);
      const result = await ask(stopped, "orch", stoppedLeader, "opinion", {
        discussion: { topic: "stopped group", peers: [stoppedPeer.nickname] },
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /중지/);
      assert.equal(stopped.sent.length, 0);
      assert.equal(stopped.store.listConsults(stopped.chat.id).length, 0);
    } finally {
      await stopped.close();
    }
  } finally {
    await f.close();
  }
});

test("parallel parts exchange direct messages while both workers remain active", { timeout: 8000 }, async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "gemini", "API contract");
    const b = f.store.createAgent(f.chat.id, "grok", "UI contract");
    let ready = 0, release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    for (const [self, peer] of [[a, b], [b, a]]) f.behavior.set(self.key, async (_input, role) => {
      if (_input.text.includes("[작업자 결과 취합]")) return f.finish(role, "resultId contract confirmed by both workers");
      const sent = await f.engine.call(f.chat.id, role, "send_message", { to: peer.nickname, message: `${self.key}: use field resultId` });
      assert.equal(sent.isError, false);
      if (++ready === 2) release();
      await barrier;
      const inbox = await f.engine.call(f.chat.id, role, "read_messages", {});
      const all = textOf(sent) + textOf(inbox) + _input.text;
      assert.match(all, new RegExp(`${peer.key}: use field resultId`));
      assert.equal(textOf(await f.engine.call(f.chat.id, role, "read_messages", {})), "새 협업 메시지가 없습니다.");
      f.finish(role, "resultId contract applied");
    });
    const result = await f.engine.call(f.chat.id, "orch", "ask_parallel", { tasks: [a, b].map((w, i) => ({ to: w.nickname, kind: "implement", message: `part ${i}`, scope: [i ? "src/ui/**" : "src/api/**"], reason: "independent parts", effort: "medium" })) });
    assert.equal(result.isError, false);
    assert.equal(ready, 2);
    assert.equal(f.store.events(f.chat.id).filter(e => e.event.type === "peer_message").length, 2);
    assert.ok(f.store.listConsults(f.chat.id).every(c => c.status === "done"));
    assert.equal((await f.engine.call(f.chat.id, a.key, "send_message", { to: b.nickname, message: "after completion" })).isError, true);
  } finally { await f.close(); }
});

test("workers use ask_parallel for direct peer reviews and reject nested overlapping writes", { timeout: 8000 }, async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "grok", "implementation");
    const a = f.store.createAgent(f.chat.id, "claude", "first review");
    const b = f.store.createAgent(f.chat.id, "gemini", "second review");
    f.behavior.set(leader.key, async (_input, role) => {
      const blocked = await f.engine.call(f.chat.id, role, "ask", { to: a.nickname, kind: "implement", message: "overlap", scope: ["src/api/a.ts"] });
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /겹치지 않는/);
      const peers = await f.engine.call(f.chat.id, role, "ask_parallel", { tasks: [a, b].map(w => ({ to: w.nickname, kind: "review", message: "review this contract" })) });
      assert.equal(peers.isError, false);
      f.finish(role, "integrated both peer reviews");
    });
    const result = await f.engine.call(f.chat.id, "orch", "ask", { to: leader.nickname, kind: "implement", scope: ["src/api/**"], message: "implement and collaborate", reason: "named worker", effort: "high" });
    assert.equal(result.isError, false);
    const nested = f.store.listConsults(f.chat.id).filter(c => c.fromRole === leader.key);
    assert.equal(nested.length, 2);
    assert.ok(nested.every(c => c.kind === "review" && c.effort === "high" && c.status === "done"));
  } finally { await f.close(); }
});

test("explicit Antigravity and Grok images need a real artifact, not a completion claim", async () => {
  const f = fixture();
  try {
    for (const kind of ["gemini", "grok"] as const) {
      const worker = f.store.createAgent(f.chat.id, kind, "image");
      const args = { to: worker.nickname, kind: "implement", message: "generate requested image", requiresImage: true, reason: "user explicitly selected this worker", effort: "medium", scope: ["images/**"] };
      const missing = await f.engine.call(f.chat.id, "orch", "ask", args);
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /이미지 생성 미완료/);
      const file = join(f.root, `${kind}.png`);
      writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XkAAAAASUVORK5CYII=", "base64"));
      f.behavior.set(worker.key, async (input, role) => {
        assert.equal(input.requiresImage, true);
        assert.equal(input.noWrites, false);
        f.chats.onDriverEvent?.(f.chat.id, role, { type: "image_generation", id: "actual", status: "done", attachment: { id: 1, name: `${kind}.png`, mime: "image/png", path: file, size: 68 } });
        f.finish(role, "image attached");
      });
      assert.equal((await f.engine.call(f.chat.id, "orch", "ask", { ...args, message: "retry with image tool" })).isError, false);
    }
  } finally { await f.close(); }
});

test("Antigravity and Grok can lead a discussion and collect actual peer results", async () => {
  const f = fixture();
  try {
    const peer = f.store.createAgent(f.chat.id, "claude", "peer");
    for (const kind of ["gemini", "grok"] as const) {
      const leader = f.store.createAgent(f.chat.id, kind, "coordinator");
      f.behavior.set(leader.key, async (_input, role) => {
        assert.equal((await f.engine.call(f.chat.id, role, "ask", { to: peer.nickname, kind: "opinion", message: `verify ${kind} design` })).isError, false);
        f.finish(role, "peer evidence incorporated");
      });
      const result = await ask(f, "orch", leader, "opinion", { discussion: { topic: `design ${kind}`, peers: [peer.nickname] } });
      assert.equal(result.isError, false, JSON.stringify(result));
    }
    assert.equal(f.store.listConsults(f.chat.id).length, 4);
  } finally { await f.close(); }
});

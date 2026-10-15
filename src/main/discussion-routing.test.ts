import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentInput, type AgentKind, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

type Sent = { role: Role; effort?: string; input: AgentInput };
type Behavior = (input: AgentInput, role: Role) => Promise<void> | void;

function fixture(options: { dualInvestigation?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cbx-discussion-routing-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.models = async (agent) => [{
    id: agent === "claude" ? "opus" : agent === "codex" ? "gpt-6-astra" : "gemini-test-medium",
    label: agent,
    isDefault: true,
    reasoningEfforts: ["medium", "high", "xhigh"],
  }];
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
    return kind === "gpt" ? "codex" : kind === "gemini" ? "gemini" : "claude";
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
  if (options.discussion !== undefined) args.discussion = options.discussion;
  return f.engine.call(f.chat.id, caller, "ask", args);
}

function textOf(result: any): string {
  return result.content.map((part: { text: string }) => part.text).join("\n");
}

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
    assert.ok(f.sent.every((item) => item.input.noWrites === true));
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
      { caller: "orch", target: leader, kind: "opinion", discussion: { topic: "technical Gemini", peers: [gemini.nickname] } },
      { caller: "orch", target: gemini, kind: "writing", discussion: { topic: "Gemini leader", peers: [leader.nickname] } },
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

test("a coordinator cannot expand the group or write, and missing peer participation fails the outer consult", async () => {
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
    assert.match(f.writeGuardError ?? "", /(파일을 고치지 않습니다|구현을 맡은 동안)/);
    assert.equal(expansion.isError, true);
    assert.match(textOf(expansion), /토의 그룹 구성은 마스터가 지정/);
    assert.equal(implementation.isError, true);
    assert.match(textOf(implementation), /(같은 opinion\/writing 종류로만|구현을 맡길 수 없습니다)/);

    const records = f.store.listConsults(f.chat.id);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((item) => [item.fromRole, item.toRole, item.kind, item.status]), [
      ["orch", leader.key, "opinion", "error"],
      [leader.key, peer.key, "opinion", "done"],
    ]);
    assert.ok(f.sent.every((item) => item.input.noWrites === true));
    assert.equal(f.sent.some((item) => item.role === missing.key || item.role === outsider.key), false);
  } finally {
    await f.close();
  }
});

test("writing discussions may include Gemini, while technical Gemini groups remain forbidden", async () => {
  const f = fixture();
  try {
    const leader = f.store.createAgent(f.chat.id, "claude", "writing leader");
    const gemini = f.store.createAgent(f.chat.id, "gemini", "prose reviewer");

    f.behavior.set(leader.key, async (_input, role) => {
      const response = await f.engine.call(f.chat.id, role, "ask", {
        to: gemini.nickname,
        kind: "writing",
        message: "다음 장면의 대사를 다듬어 주세요.",
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
    assert.ok(f.sent.every((item) => item.input.noWrites === true));
    assert.ok(f.sent.every((item) => item.effort === "high"));
    assert.ok(f.store.listConsults(f.chat.id).every((item) => item.status === "done"));

    const sentBeforeTechnical = f.sent.length;
    const recordsBeforeTechnical = f.store.listConsults(f.chat.id).length;
    const technical = await ask(f, "orch", leader, "opinion", {
      discussion: { topic: "technical Gemini", peers: [gemini.nickname] },
    });
    assert.equal(technical.isError, true);
    assert.match(textOf(technical), /글쓰기 토의/);
    assert.equal(f.sent.length, sentBeforeTechnical);
    assert.equal(f.store.listConsults(f.chat.id).length, recordsBeforeTechnical);
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

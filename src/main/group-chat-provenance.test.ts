// Main chat vs detail split: the app marks its own group-chat copies (consult results, status checks) with a
// display kind. Public worker reports stay visible without prompting the master to repeat them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentEvent, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";
import { buildForkSnapshot } from "./chat-fork";
import type { AgentInput } from "./drivers/types";

type Room = Extract<AgentEvent, { type: "room_message" }>;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-group-chat-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.models = async () => [{ id: "opus", label: "claude", isDefault: true, reasoningEfforts: ["medium", "high"] }];
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, { id: 1, mode: "delegated", text: "group chat split", asks: 0, reviews: 0, startedAt: Date.now(), requests: new Map(), queued: [], pinned: [] });
  const behavior = new Map<Role, (input: AgentInput, role: Role) => Promise<void> | void>();
  const finish = (role: Role, text: string) => {
    chats.onDriverEvent?.(chat.id, role, { type: "text", text });
    chats.onDriverEvent?.(chat.id, role, { type: "turn_end", ok: true });
  };
  chats.driver = async (_chatId, role) => ({
    agent: "claude",
    running: false,
    stop: async () => {},
    dispose: async () => {},
    send: async (input: AgentInput) => { const act = behavior.get(role); if (act) await act(input, role); else finish(role, `${role} response`); },
  });
  return {
    store, chat, chats, engine, behavior, finish,
    rooms: () => store.events(chat.id).filter((e) => e.event.type === "room_message").map((e) => e.event as Room),
    async close() { engine.stopRecovery(); await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

const textOf = (result: any): string => result.content.map((part: { text: string }) => part.text).join("\n");

test("public worker reports reach the user and peers without steering the master; direct questions still steer", async () => {
  const f = fixture();
  try {
    const author = f.store.createAgent(f.chat.id, "claude", "writer");
    const peer = f.store.createAgent(f.chat.id, "claude", "reviewer");
    f.engine.running.set(f.chat.id, new Map([[author.key, { tools: new Set() }]]));
    const steered: { role: Role; text: string }[] = [];
    f.chats.liveDriver = (_chatId, role) => ({ running: true, steer: async (input: AgentInput) => { steered.push({ role, text: input.text }); return true; } }) as any;
    const report = "인증 경로 수정은 끝났고 실제 시작 순서 테스트를 작성 중입니다.";
    const sent = await f.engine.call(f.chat.id, author.key, "send_message", { to: "all", message: report });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.isError, false);
    assert.equal(f.rooms().at(-1)!.text, report, "the original is still visible under the worker's name");
    assert.equal(steered.filter(x => x.role === "orch").length, 0, "public progress must not trigger a master reply");
    assert.ok(steered.some(x => x.role === peer.key && x.text.includes(report)), "peer collaboration still receives public reports immediately");
    assert.equal(f.store.getSetting(`teamMessages:${f.chat.id}:orch`), undefined, "public report remains unread for the master's next tool call");
    const request = "기존 계정도 재확인할지 결정해 주세요.";
    await f.engine.call(f.chat.id, author.key, "send_message", { to: "마스터", message: request });
    await new Promise(resolve => setImmediate(resolve));
    const master = steered.filter(x => x.role === "orch");
    assert.equal(master.length, 1, "a direct decision request still interrupts the master");
    assert.match(master[0].text, /사용자에게 이미 표시됨 · 반복·요약 재보고 금지/);
    assert.ok(master[0].text.includes(report));
    assert.ok(master[0].text.includes(request));
    assert.doesNotMatch(textOf(await f.engine.call(f.chat.id, "orch", "read_messages", {})), /인증 경로 수정|기존 계정도/);
  } finally { await f.close(); }
});

test("master tool inbox distinguishes visible reports from private requests and hidden result receipts", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "writer");
    f.chats.emit(f.chat.id, "orch", worker.key, { type: "room_message", from: worker.key, text: "작업자 공개 결과" });
    f.chats.emit(f.chat.id, "orch", worker.key, { type: "peer_message", from: worker.key, to: "orch", text: "마스터만 받는 결정 요청" });
    f.chats.emit(f.chat.id, "orch", worker.key, { type: "room_message", from: worker.key, kind: "system", text: "앱 점검 요청" });
    const inbox = textOf(await f.engine.call(f.chat.id, "orch", "agents", {}));
    assert.match(inbox, /사용자에게 이미 표시됨[^\n]*작업자 공개 결과/);
    assert.doesNotMatch(inbox, /사용자에게 이미 표시됨[^\n]*(마스터만 받는 결정 요청|앱 점검 요청)/);
    assert.match(inbox, /사용자 지시와 승인·작업 범위를 변경하지 않음/);
    assert.match(inbox, /마스터만 받는 결정 요청/);
    assert.match(inbox, /앱 점검 요청/);
    assert.doesNotMatch(textOf(await f.engine.call(f.chat.id, "orch", "agents", {})), /작업자 공개 결과/);
  } finally { await f.close(); }
});

test("a finished consult broadcasts a result reference while preserving the report and real public lines", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "writer");
    const b = f.store.createAgent(f.chat.id, "claude", "reviewer");
    const report = "[CLI 지정 계정=claude-1 · 실제 실행 계정=claude-1]\n긴 최종 보고 본문";
    f.behavior.set(a.key, async (_input, role) => {
      assert.equal((await f.engine.call(f.chat.id, role, "send_message", { to: "all", message: "설계 초안을 올렸어요. 이름 규칙 괜찮을까요?" })).isError, false);
      f.finish(role, report);
    });
    const result = await f.engine.call(f.chat.id, "orch", "ask", { to: a.nickname, kind: "opinion", message: "초안", reason: "test", effort: "high" });
    assert.equal(result.isError, false);
    assert.doesNotMatch(textOf(result), /긴 최종 보고 본문/, "ordinary master assignments only return a receipt");
    const [chat, copy] = f.rooms();
    assert.equal(chat.kind, undefined, "a model-written public line stays a plain room message");
    assert.equal(copy.kind, "result");
    assert.equal(copy.status, "done");
    assert.equal(copy.consultId, f.store.listConsults(f.chat.id).at(-1)!.id);
    assert.match(copy.text, /협의 id=/);
    assert.doesNotMatch(copy.text, /긴 최종 보고 본문/);
    const inbox = textOf(await f.engine.call(f.chat.id, b.key, "read_messages", {}));
    assert.match(inbox, /이름 규칙 괜찮을까요/);
    assert.doesNotMatch(inbox, /긴 최종 보고 본문/);
    assert.match(textOf(await f.engine.call(f.chat.id, b.key, "read_consult", { consultId: copy.consultId })), /긴 최종 보고 본문/);
  } finally { await f.close(); }
});

test("a worker-to-worker consult result still reaches the master's inbox", async () => {
  const f = fixture();
  try {
    const a = f.store.createAgent(f.chat.id, "claude", "lead");
    const b = f.store.createAgent(f.chat.id, "claude", "helper");
    f.behavior.set(a.key, async (_input, role) => {
      const nested = await f.engine.call(f.chat.id, role, "ask", { to: b.nickname, kind: "review", message: "확인해 주세요" });
      assert.match(textOf(nested), /helper 결과 본문/);
      f.finish(role, "lead done");
    });
    f.behavior.set(b.key, (_input, role) => f.finish(role, "helper 결과 본문"));
    const outer = textOf(await f.engine.call(f.chat.id, "orch", "ask", { to: a.nickname, kind: "implement", message: "작업", reason: "test", effort: "high" }));
    const nestedCopy = f.rooms().find((r) => r.from === b.key)!;
    assert.equal(nestedCopy.kind, "result");
    // The master did not assign this consult; the group copy delivered with its next tool result is how it learns.
    assert.match(outer, /\[동료 메시지[\s\S]*협의 id=/);
    assert.doesNotMatch(outer, /helper 결과 본문/);
    assert.match(textOf(await f.engine.call(f.chat.id, "orch", "read_consult", { consultId: nestedCopy.consultId })), /helper 결과 본문/);
  } finally { await f.close(); }
});

test("the long-run status check is stored as an app notice, still reaches the master, and is not the worker's words", async () => {
  const f = fixture();
  try {
    const worker = f.store.createAgent(f.chat.id, "claude", "implementation");
    const master = { running: false, agent: "claude" as const, send: async () => {}, stop: async () => {}, dispose: async () => {} };
    f.chats.driver = async () => master as any;
    f.chats.liveDriver = (_chatId, role) => (role === "orch" ? master : { running: true, dispose: async () => {} }) as any;
    f.engine.running.set(f.chat.id, new Map([[worker.key, { lastEventAt: 1, kind: "implement", scope: ["src/**"], tools: new Set(["long tool"]), resolve() {} }]]));
    await f.engine.sweepWorkerRecovery(300_001);
    const note = f.rooms().at(-1)!;
    assert.equal(note.kind, "system");
    assert.equal(note.from, worker.key, "delivery semantics keep the same sender key");
    assert.match(note.text, /^\[앱 상태 점검\] .+의 활동이 \d+분간 없습니다\./);
    assert.match(textOf(await f.engine.call(f.chat.id, "orch", "read_messages", {})), /앱 상태 점검/);
  } finally { await f.close(); }
});

test("a fork snapshot keeps real group lines and leaves out marked app copies", () => {
  const at = (id: number, role: Role | null, event: AgentEvent) => ({ id, chatId: 1, node: "orch" as const, role, at: id, event });
  const events = [
    at(1, null, { type: "user", text: "지시", attachments: [] }),
    at(2, "w1", { type: "room_message", from: "w1", text: "실제 발언입니다" }),
    at(3, "w1", { type: "room_message", from: "w1", text: "모델 메타가 붙은 결과 사본", kind: "result", consultId: 1, status: "done" }),
    at(4, "w1", { type: "room_message", from: "w1", text: "앱 점검 안내", kind: "system" }),
  ];
  const { text } = buildForkSnapshot(events, [], { eventId: 1, range: "from", includeAttachments: false });
  assert.match(text, /실제 발언입니다/);
  assert.doesNotMatch(text, /결과 사본|앱 점검 안내/);
});

test("public messages are not hard-limited to a short length", async () => {
  const f = fixture();
  try {
    const long = "긴 공개 발언 ".repeat(80) + "\n마지막 질문: 이 방향 괜찮을까요?";
    assert.equal((await f.engine.call(f.chat.id, "orch", "send_message", { to: "all", message: long })).isError, false);
    assert.equal(f.rooms().at(-1)!.text, long.trim(), "the original is stored whole");
  } finally { await f.close(); }
});

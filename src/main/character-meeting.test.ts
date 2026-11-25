import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";
import { CharacterMeeting } from "./character-meeting";
import { parseCharacterModels, parseMeetingRequest, type MeetingEvent } from "../shared/character-meeting";
import type { ChatManager } from "./chats";
import { CharacterChat } from "./character-chat";

const id = "a".repeat(32);

test("room streams the assigned report, sends it to peers and synthesizes their replies with the selected models", async () => {
  const events: MeetingEvent[] = [];
  const calls: Array<{ agent: string; model?: string; input: Record<string, unknown> }> = [];
  const folder = resolve("example-sources");
  const room = new CharacterMeeting({
    configured: () => ["claude", "codex", "deepseek"],
    meetingReply: async (agent, model, input, _signal, onText) => {
      calls.push({ agent, model, input: input as Record<string, unknown> });
      if (!onText) return JSON.stringify({ assignee: "deepseek", task: "문서 검토", keywords: ["정책"] });
      if (agent === "deepseek") { onText("문서 첫 줄"); return "문서 첫 줄과 결론"; }
      if ("reviews" in input) { onText("회의 결"); return "회의 결론"; }
      onText("다른 관점");
      return `${agent} 검토`;
    },
  }, () => ({ orch: { agent: "codex", model: "chair-test" }, deepseek: { agent: "deepseek", model: "worker-test" } }),
  event => events.push(event), async (path, term, kind) => {
    assert.equal(path, folder);
    assert.equal(term, "정책");
    assert.equal(kind, "grep");
    return { evidence: [{ path: "guide.md", line: 3, excerpt: "정책 본문" }], coverage: { visited: 1, read: 1, skipped: 0, limited: false }, note: "" };
  });

  await room.start({ requestId: id, text: "정책 알려줘", folder });
  const roster = events.find(event => event.type === "roster");
  assert.deepEqual(roster?.connected, ["orch", "claude", "gpt", "deepseek"]);
  assert.deepEqual(calls.slice(0, 2).map(({ agent, model }) => [agent, model]), [["codex", "chair-test"], ["deepseek", "worker-test"]]);
  const reportDraft = events.find(event => event.type === "draft" && event.message.text === "문서 첫 줄");
  const report = room.snapshot().messages.find(message => message.kind === "report");
  assert.equal(report?.id, reportDraft && "message" in reportDraft ? reportDraft.message.id : undefined);
  assert.equal(report?.text, "문서 첫 줄과 결론");
  assert.match(JSON.stringify(calls[1]?.input.research), /guide\.md/);
  assert.equal(JSON.stringify(calls[2]?.input.report).includes("문서 첫 줄과 결론"), true);
  assert.equal((calls.at(-1)?.input.reviews as unknown[]).length, 2);
  assert.equal(room.snapshot().requestId, null);
  assert.equal(room.snapshot().drafts.length, 0);
  assert.deepEqual(room.snapshot().messages.map(message => message.kind), [undefined, "assignment", "report", "review", "review", "summary"]);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
});

test("a stopped report withdraws its draft and releases the room for another agenda", async () => {
  const events: MeetingEvent[] = [];
  let reporting!: () => void;
  const ready = new Promise<void>(resolve => { reporting = resolve; });
  const room = new CharacterMeeting({
    configured: () => ["codex"],
    meetingReply: async (_agent, _model, _input, signal, onText) => {
      if (!onText) return '{"assignee":"gpt","task":"발표"}';
      onText("미완성");
      reporting();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  }, () => ({}), event => events.push(event));
  const pending = room.start({ requestId: id, text: "질문" });
  assert.throws(() => room.start({ requestId: "b".repeat(32), text: "충돌" }), /다른 회의 안건/);
  await ready;
  assert.equal(room.snapshot().requestId, id);
  room.cancel("c".repeat(32));
  assert.equal(room.snapshot().drafts[0]?.text, "미완성");
  room.cancel(id);
  await pending;
  assert.equal(room.snapshot().requestId, null);
  assert.equal(room.snapshot().drafts.length, 0);
  assert.ok(events.some(event => event.type === "withdraw"));
  assert.match(room.snapshot().status, /중단/);
});

test("a personal question uses its conversation model and rejects incompatible settings", async () => {
  const settings = parseCharacterModels({
    gpt: { agent: "codex", model: "choice" },
    grok: { agent: "claude", model: "unrelated" },
    orch: { agent: "deepseek", model: "" },
  });
  assert.deepEqual(settings, { gpt: { agent: "codex", model: "choice" }, orch: { agent: "deepseek", model: "" } });
  const chat = new CharacterChat({} as ChatManager, async (agent, _input, _signal, model) => `${agent}/${model}`, () => settings);
  assert.deepEqual(await chat.ask({ requestId: id, character: "gpt", text: "안녕" }), { status: "answer", text: "codex/choice" });
  assert.equal(parseMeetingRequest({ requestId: id, text: " " }), undefined);
});

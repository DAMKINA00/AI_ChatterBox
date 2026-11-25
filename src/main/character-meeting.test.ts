import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve } from "node:path";
import { CharacterMeeting } from "./character-meeting";
import { parseCharacterModels, parseMeetingRequest, type MeetingEvent } from "../shared/character-meeting";
import type { ChatManager } from "./chats";
import { CharacterChat } from "./character-chat";
import { BoardroomMemory } from "./boardroom-memory";
import { agendaUrls, parseWebSources, type WebLookup } from "./boardroom-web";

const id = "a".repeat(32);

test("room narrows the first question, passes each finished contribution to the next speaker and concludes dynamically", async () => {
  const events: MeetingEvent[] = [];
  const calls: Array<{ agent: string; model?: string; input: Record<string, unknown> }> = [];
  const folder = resolve("example-sources");
  const replies = ["배편부터 정해요.", "배편에 맞춰 이동 수단을 정하죠.", "렌터카면 첫날 북부만 둘러봐요.", "그러면 둘째 날은 복귀에 여유를 두죠."];
  const topics = [
    { speaker: "deepseek", focus: "먼저 배편만 어떻게 잡을까요?", keywords: ["정책"] },
    { speaker: "claude", focus: "배편에 맞는 이동 수단은?" },
    { speaker: "gpt", focus: "렌터카 기준 첫날 범위는?" },
    { speaker: "deepseek", focus: "귀국일에 얼마나 여유를 둘까요?" },
  ];
  let floor = 0;
  let spoken = 0;
  const room = new CharacterMeeting({
    configured: () => ["claude", "codex", "deepseek"],
    meetingEligibility: () => "available",
    meetingReply: async (agent, model, input, _signal, onText) => {
      calls.push({ agent, model, input: input as Record<string, unknown> });
      if (!onText) return JSON.stringify(topics[floor++] ?? { action: "conclude" });
      if ((input as { stage: string }).stage === "conclude") { onText("회의 결"); return "회의 결론"; }
      const reply = replies[spoken++]!;
      onText(reply.slice(0, 4));
      return reply;
    },
  }, () => ({ orch: { agent: "codex", model: "chair-test" }, deepseek: { agent: "deepseek", model: "worker-test" } }),
  event => events.push(event), async (path, term, kind) => {
    assert.equal(path, folder);
    assert.equal(term, "정책");
    assert.equal(kind, "grep");
    return { evidence: [{ path: "guide.md", line: 3, excerpt: "정책 본문" }], coverage: { visited: 1, read: 1, skipped: 0, limited: false }, note: "" };
  });

  await room.start({ requestId: id, text: "여행 동선을 함께 정해줘", folder });
  const roster = events.find(event => event.type === "roster");
  assert.deepEqual(roster?.connected, ["orch", "claude", "gpt", "deepseek"]);
  assert.deepEqual(calls.slice(0, 2).map(({ agent, model }) => [agent, model]), [["codex", "chair-test"], ["deepseek", "worker-test"]]);
  const firstDraft = events.find(event => event.type === "draft" && event.message.text === replies[0]!.slice(0, 4));
  const posts = room.snapshot().messages.filter(message => message.kind === "discussion");
  assert.equal(posts[0]?.id, firstDraft && "message" in firstDraft ? firstDraft.message.id : undefined);
  assert.deepEqual(posts.map(message => message.sender), ["deepseek", "claude", "gpt", "deepseek"]);
  assert.equal(new Set(posts.map(message => message.id)).size, posts.length);
  assert.deepEqual(posts.map(message => message.text), replies);
  assert.equal(calls[1]?.input.focus, topics[0]?.focus);
  assert.match(JSON.stringify(calls[1]?.input.research), /guide\.md/);
  assert.deepEqual(calls.map(({ input }) => input.stage),
    ["opening", "speak", "moderate", "speak", "moderate", "speak", "moderate", "speak", "moderate", "conclude"]);
  for (const [index, { input }] of calls.filter(call => call.input.stage === "speak").entries())
    assert.deepEqual((input.discussion as { text: string }[]).map(turn => turn.text), replies.slice(0, index));
  assert.deepEqual((calls.at(-1)?.input.discussion as { text: string }[]).map(turn => turn.text), replies);
  assert.equal(room.snapshot().requestId, null);
  assert.equal(room.snapshot().drafts.length, 0);
  assert.deepEqual(room.snapshot().messages.map(message => message.kind), [undefined, "assignment", "discussion", "discussion", "discussion", "discussion", "summary"]);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
});

test("a stopped contribution withdraws its draft and releases the room for another agenda", async () => {
  const events: MeetingEvent[] = [];
  let reporting!: () => void;
  const ready = new Promise<void>(resolve => { reporting = resolve; });
  const room = new CharacterMeeting({
    configured: () => ["codex"],
    meetingEligibility: () => "available",
    meetingReply: async (_agent, _model, _input, signal, onText) => {
      if (!onText) return '{"speaker":"gpt","focus":"첫 발언"}';
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

test("the floor moves to a successful participant and permits conclusion without requiring every provider", async () => {
  const spoken: string[] = [];
  const room = new CharacterMeeting({
    configured: () => ["claude", "codex", "deepseek"],
    meetingEligibility: () => "available",
    meetingReply: async (agent, _model, input) => {
      const { stage, mayConclude } = input as { stage: string; mayConclude?: boolean };
      if (stage === "opening") return '{"speaker":"claude","focus":"첫 발언"}';
      if (stage === "moderate") return '{"action":"conclude"}';
      if (stage === "conclude") return "회의 결론";
      assert.equal(mayConclude, undefined);
      spoken.push(agent);
      if (agent === "claude") throw new Error("Unavailable");
      return agent;
    },
  }, () => ({}), () => {});
  await room.start({ requestId: id, text: "질문" });
  assert.deepEqual(spoken, ["claude", "codex", "deepseek"]);
  assert.ok(room.snapshot().messages.some(message => message.sender === "system" && message.text.includes("다음 참가자")));
  assert.equal(room.snapshot().messages.at(-1)?.kind, "summary");
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

test("resting participants stay on the roster while a healthy account chairs and alternating speakers continue", async () => {
  const events: MeetingEvent[] = [];
  const calls: string[] = [];
  const room = new CharacterMeeting({
    configured: () => ["claude", "codex", "grok", "deepseek"],
    meetingEligibility: agent => agent === "claude" || agent === "deepseek" ? "resting" : "available",
    meetingReply: async (agent, model, input) => {
      const { stage, discussion, members } = input as { stage: string; discussion: unknown[]; members?: { id: string }[] };
      if (members) assert.ok(members.every(member => ["gpt", "grok"].includes(member.id)));
      calls.push(`${stage}/${agent}/${model ?? ""}`);
      if (stage === "opening") return '{"speaker":"gpt","focus":"첫 쟁점"}';
      if (stage === "moderate") return discussion.length === 1
        ? '{"speaker":"grok","focus":"다음 쟁점"}' : '{"action":"conclude"}';
      return "발언";
    },
  }, () => ({ orch: { agent: "claude", model: "configured-chair" }, gpt: { agent: "codex", model: "active-chair" } }),
  event => events.push(event));
  await room.start({ requestId: id, text: "회의 질문" });
  assert.deepEqual(room.snapshot().resting, ["claude", "deepseek"]);
  assert.deepEqual(room.snapshot().connected, ["orch", "claude", "gpt", "grok", "deepseek"]);
  assert.deepEqual(calls, ["opening/codex/", "speak/codex/active-chair", "moderate/codex/",
    "speak/grok/", "moderate/codex/", "conclude/codex/"]);
  assert.deepEqual(events.find(event => event.type === "roster")?.resting, ["claude", "deepseek"]);
});

test("a room with only low budgets ends without a provider call", async () => {
  const room = new CharacterMeeting({
    configured: () => ["codex", "deepseek"],
    meetingEligibility: () => "resting",
    meetingReply: async () => { assert.fail("A low-budget provider was called"); },
  }, () => ({}), () => {});
  await room.start({ requestId: id, text: "회의 질문" });
  assert.equal(room.snapshot().messages.length, 1);
  assert.deepEqual(room.snapshot().resting, ["orch", "gpt", "deepseek"]);
  assert.match(room.snapshot().status, /잔여 사용량/);
});

test("two speakers can return to each other, followed by a new voice, a short agreement and an objection with evidence", async () => {
  const store = new Map<string, string>();
  const storage = { getSetting: (key: string) => store.get(key), setSetting: (key: string, value: string) => { store.set(key, value); } };
  const memory = new BoardroomMemory(storage);
  const url = "https://www.iana.org/help/example-domains";
  const first = { speaker: "gpt", focus: "첫날 항구에서 이동하는 법", webQuery: "히타카츠항 대중교통 공식" };
  const turns = [
    first, { speaker: "claude", focus: "배편 도착 뒤 이동" }, { speaker: "gpt", focus: "짐을 맡길 시간" },
    { speaker: "grok", focus: "해 지기 전에 전망대를 보는 조건", mode: "interject" },
    { speaker: "gemini", focus: "도착 직후 짐 보관", mode: "reaction" },
    { speaker: "deepseek", focus: "마지막 버스", mode: "reaction" },
    { action: "conclude", credits: [{ turn: 4, strength: "risks" }, { turn: 7, strength: "verification" }] },
  ];
  const searches: WebLookup[] = [];
  const observed: Array<{ stage: string; input: Record<string, unknown> }> = [];
  let floor = 0;
  const room = new CharacterMeeting({
    configured: () => ["claude", "codex", "grok", "gemini", "deepseek"],
    meetingEligibility: () => "available",
    meetingReply: async (agent, _model, data, _signal, _onText, onModel) => {
      const input = data as Record<string, unknown>;
      const stage = String(input.stage);
      observed.push({ stage, input });
      if (stage === "opening" || stage === "moderate") return JSON.stringify(turns[floor++]);
      onModel?.(`${agent}-current`);
      if (stage === "react") return agent === "gemini" ? '{"kind":"agree","text":"짐부터 맡기면 동선이 짧아요."}'
        : '{"kind":"object","text":"마지막 버스가 있다는 전제에는 이의가 있어요.","webQuery":"히타카츠 최종 버스 공식 시간표"}';
      return stage === "evidence" ? "공식 시간표의 막차 조건을 확인했습니다." : "대화를 이어갑니다.";
    },
  }, () => ({}), () => {}, undefined, { memory, web: async query => {
    searches.push(query);
    return [{ url, title: "공식 자료", note: "확인한 공개 자료 요약", kind: "page" }];
  } });

  await room.start({ requestId: id, text: `여행 동선을 확인해 줘. ${url}` });
  const posts = room.snapshot().messages;
  assert.deepEqual(posts.map(post => [post.sender, post.kind]), [
    ["user", undefined], ["orch", "assignment"], ["system", "sources"], ["gpt", "discussion"],
    ["claude", "discussion"], ["gpt", "discussion"], ["grok", "interjection"], ["gemini", "agreement"],
    ["deepseek", "objection"], ["deepseek", "evidence"], ["orch", "summary"],
  ]);
  assert.deepEqual(searches.map(value => value.query), [first.webQuery, "히타카츠 최종 버스 공식 시간표"]);
  assert.deepEqual(searches[0]?.urls, [url]);
  assert.match(JSON.stringify(observed.find(entry => entry.stage === "evidence")?.input.web), /공개 자료 요약/);
  const reloaded = new BoardroomMemory(storage);
  assert.equal(reloaded.hints("grok", "grok-current")?.strengths[0]?.strength, "빠진 예외나 위험 발견");
  assert.equal(reloaded.hints("grok", "grok-other"), undefined);
  assert.equal(store.values().next().value?.includes("항구"), false);

  floor = 0;
  await room.start({ requestId: "b".repeat(32), text: "다음 여행을 준비해 줘" });
  const next = observed.filter(entry => entry.stage === "opening").at(-1);
  assert.match(JSON.stringify(next?.input.members), /빠진 예외나 위험 발견/);
});

test("web evidence only includes public URLs observed in completed page events", () => {
  const url = "https://www.iana.org/help/example-domains";
  assert.deepEqual(agendaUrls(`로컬 http://127.0.0.1:9222/json, 사설 https://printer.local/docs, 공개 [자료](${url}#main).`), [url]);
  const items = [
    { url, title: "IANA", note: "공개 자료" },
    { url: "https://www.iana.org/guess", title: "Guess", note: "추측한 페이지" },
    { url: "file:///test", title: "Local", note: "로컬" },
  ];
  const search = "https://www.iana.org/domains/reserved";
  const observed = new Map([[url, { kind: "page" as const }], [search, { kind: "search" as const, title: "색인", snippet: "실제 검색 발췌" }]]);
  assert.deepEqual(parseWebSources(JSON.stringify({ sources: items }), observed),
    [{ ...items[0], kind: "page" }, { url: search, title: "색인", note: "실제 검색 발췌", kind: "search" }]);
});

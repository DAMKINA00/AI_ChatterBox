import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatAgent, Consult } from "../shared/types";
import { CharacterEventFeed, summarize, type CharacterEvent } from "./character-events";

const agent = (id: number, kind: ChatAgent["kind"], nickname: string) =>
  ({ id, chatId: 1, key: `w${id}`, kind, number: 1, nickname, job: "", sessionId: null, status: "active", createdAt: 0 } as unknown as ChatAgent);
const consult = (over: Partial<Consult>): Consult =>
  ({ id: 7, chatId: 1, seq: 1, fromRole: "orch", toRole: "w1", scope: [], kind: "implement", request: "로그인 화면 버튼 정렬 수정", status: "running", startedAt: 1000, endedAt: null, ...over } as unknown as Consult);

function feed(now = 1000) {
  const events: CharacterEvent[] = [];
  const f = new CharacterEventFeed(e => events.push(e), () => now);
  f.agentsUpdated(1, [agent(1, "claude", "클로드 1호"), agent(2, "deepseek", "딥시크 1호")]);
  return { f, events };
}

test("an assignment is announced once by Orch with the worker's name and a short summary; its result once by the worker", () => {
  const { f, events } = feed();
  f.consultUpdated(consult({}));
  f.consultUpdated(consult({})); // streaming/duplicate update
  f.consultUpdated(consult({ status: "done", endedAt: 2000 }));
  f.consultUpdated(consult({ status: "done", endedAt: 2000 })); // reconnect replay
  f.consultUpdated(consult({ id: 8, toRole: "w2", kind: "review", status: "error", endedAt: 2100 }));
  assert.deepEqual(events.map(e => [e.id, e.character, e.kind, e.ok, e.text]), [
    ["assign:7", "orch", "assign", undefined, "클로드 1호에게 구현 작업을 맡겼어요: 로그인 화면 버튼 정렬 수정"],
    ["result:7", "claude", "result", true, "구현 작업 결과를 보고했어요."],
    ["assign:8", "orch", "assign", undefined, "딥시크 1호에게 리뷰 작업을 맡겼어요: 로그인 화면 버튼 정렬 수정"],
    ["result:8", "deepseek", "result", false, "리뷰 작업에 실패했어요."],
  ]);
});

test("nothing from before the feed started is replayed; worker→master questions and unknown roles are ignored", () => {
  const { f, events } = feed(5000);
  f.consultUpdated(consult({ startedAt: 1000, status: "done", endedAt: 2000 })); // finished before start
  f.consultUpdated(consult({ id: 9, startedAt: 1000 })); // started before start: no assignment
  f.consultUpdated(consult({ id: 9, startedAt: 1000, status: "stopped", endedAt: 6000 })); // ends live: result only
  f.consultUpdated(consult({ id: 10, fromRole: "w1", toRole: "orch", startedAt: 6000 }));
  f.consultUpdated(consult({ id: 11, toRole: "w99", startedAt: 6000 }));
  assert.deepEqual(events.map(e => [e.id, e.ok, e.text]), [["result:9", false, "구현 작업이 중지됐어요."]]);
});

test("chat notices go to Orch once per transition; reminders and pre-start notices are not events", () => {
  const { f, events } = feed(1000);
  f.notice(1, "approval", 1500);
  f.notice(1, "approval", 1500);
  f.notice(1, "reminder", 1600);
  f.notice(1, "done", 900);
  f.notice(1, "error", 1700);
  f.notice(1, "done", 1800);
  assert.deepEqual(events.map(e => [e.character, e.kind, e.text]), [
    ["orch", "approval", "승인이나 답변이 필요해요."], ["orch", "error", "작업 중 오류가 났어요."], ["orch", "done", "전체 작업을 마쳤어요."],
  ]);
});

test("summaries never carry raw paths, links, mails, secrets or account headers and stay short", () => {
  const s = summarize("[CLI 지정 계정=claude-1 · 실제 실행 계정=claude-1] D:\\work\\secret\\a.ts 와 /home/u/x/y 수정, https://x.io/a?t=1 참고 a@b.co token=abc123 sk-ABCDEFGHIJKLMNOP " + "길게 ".repeat(40) + "\n둘째 줄");
  assert.doesNotMatch(s, /claude-1|D:|\/home|https|a@b|abc123|sk-|둘째/);
  assert.match(s, /\[경로\].*\[링크\].*\[메일\].*\[비공개\]/);
  assert.ok(s.length <= 60);
});

test("results include an actual sanitized finding instead of only the completion label", () => {
  const { f, events } = feed();
  const responseSummary = [
    "[CLI account=claude-2]", "### 요약", "**완료**",
    '- 로그인 중복 호출을 한 번으로 줄였습니다. 비밀번호: "very private value" https://internal.example/path',
    "Traceback: raw log",
  ].join("\n");
  f.consultUpdated(consult({ status: "done", endedAt: 2000, responseSummary }));
  const result = events.find(event => event.kind === "result");
  assert.match(result?.text ?? "", /로그인 중복 호출을 한 번으로 줄였습니다/);
  assert.doesNotMatch(result?.text ?? "", /claude-2|very private|internal\.example|Traceback/);
  assert.ok((result?.text.length ?? 121) <= 120);
});

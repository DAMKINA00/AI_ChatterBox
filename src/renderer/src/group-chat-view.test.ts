// The main view reads as the group chat; the master/worker/consult views keep every original.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent, NodeId, Role, TimelineEvent } from "../../shared/types";
import { consultReason, roomProvenance, systemBrief } from "../../shared/room-message";
import { buildItems, createTimelineBuilder, type Item } from "./timeline";
import { seenReplies, unseenReplies } from "./lib/new-responses";

let nextId = 1;
const ev = (node: NodeId, role: Role | null, event: AgentEvent): TimelineEvent => {
  const id = nextId++;
  return { id, chatId: 1, node, role, at: id, event };
};

const LONG_REPORT = "[CLI 지정 계정=claude-1 · 실제 실행 계정=claude-1]\n" + "검증 로그 ".repeat(200);
const CHECK = "[앱 상태 점검] 클로드 1호의 활동이 6분간 없습니다. 긴 도구 실행·동료 대기일 수 있으며 실패로 단정하지 않습니다. 마스터는 check_agent(to=\"클로드 1호\")로 확인하세요.";

function history(): TimelineEvent[] {
  return [
    ev("orch", null, { type: "user", text: "작업해 줘", attachments: [] }),
    ev("orch", "orch", { type: "text", text: "나눠서 맡길게요." }),
    ev("orch", "orch", { type: "tool_call", id: "t1", name: "Read", input: "{}" }),
    ev("orch", "orch", { type: "tool_result", id: "t1", ok: true, output: "file" }),
    ev("orch", "orch", { type: "consult_start", consultId: 1, kind: "implement", from: "orch", to: "w1", request: "구현", attachments: [] }),
    ev("orch", "orch", { type: "consult_start", consultId: 2, kind: "review", from: "orch", to: "w2", request: "리뷰", attachments: [] }),
    ev("consult:1", "w1", { type: "text", text: "작업자 내부 보고" }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "초안 올렸어요. 이름 규칙 괜찮을까요?" }),
    ev("consult:1", "orch", { type: "peer_message", from: "orch", to: "w1", text: "현재 진행 상황·남은 작업·막힌 이유를 알려주세요." }),
    ev("orch", "w2", { type: "peer_message", from: "w2", to: "orch", text: "1:1 상세 보고" }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: CHECK, kind: "system" }),
    ev("orch", "orch", { type: "consult_end", consultId: 1, status: "done", summary: LONG_REPORT, files: [] }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: `[구현 · done · 협의 1]\n${LONG_REPORT}`, kind: "result", consultId: 1, status: "done" }),
    ev("orch", "orch", { type: "consult_end", consultId: 2, status: "error", summary: "[CLI 지정 계정=gpt-3 · 실제 실행 계정=gpt-3]\nrate limit reached\n세부 로그", files: [] }),
    // Recorded before kind existed: recognized only because consult 2 really ended with this status for w2.
    // The orchestrator wrote the summary with whitespace collapsed.
    ev("orch", "w2", { type: "room_message", from: "w2", text: "[리뷰 · error · 협의 2 · gpt-6]\n[CLI 지정 계정=gpt-3 · 실제 실행 계정=gpt-3] rate limit reached 세부 로그" }),
    ev("orch", "orch", { type: "ask_user", id: "q1", question: "배포할까요?", options: ["예", "아니오"] }),
    ev("orch", "orch", { type: "approval_request", request: { id: "a1", role: "orch", title: "Write", detail: "x", risk: "low" } }),
  ];
}

const kinds = (items: Item[]) => items.map((i) => (i.kind === "message" ? `message:${i.role}${i.origin ? `:${i.origin}` : ""}` : i.kind === "notice" ? `notice${i.origin ? `:${i.origin}` : ""}` : i.kind));

test("main view: real group lines, consult cards, questions and approvals stay; result copies, 1:1 and tool logs leave", () => {
  const main = buildItems(history(), undefined, false);
  assert.deepEqual(kinds(main), ["user", "message:orch", "consult", "consult", "message:w1", "notice:system", "ask", "approval"]);
  const text = JSON.stringify(main.filter((i) => i.kind !== "consult"));
  assert.doesNotMatch(text, /검증 로그|1:1 상세 보고|현재 진행 상황/);
  const system = main.find((i) => i.kind === "notice")!;
  assert.equal(system.kind === "notice" && system.text, "앱 상태 점검 · 클로드 1호의 활동이 6분간 없습니다. 실패로 단정하지 않습니다.");
  assert.equal(system.kind === "notice" && system.detail, CHECK, "the full original stays expandable");
  const failed = main.find((i) => i.kind === "consult" && i.consultId === 2)!;
  assert.equal(failed.kind === "consult" && failed.status, "error", "a failure keeps its state on the card");
  const card = main.find((i) => i.kind === "consult" && i.consultId === 1)!;
  assert.deepEqual(card.kind === "consult" && card.children.map((c) => c.kind), ["message"], "the check_agent prompt is not in the main card either");
});

test("master and worker views keep every original, marking the app's copy and notice", () => {
  const master = buildItems(history(), "orch", false);
  assert.ok(master.some((i) => i.kind === "tool"), "the master's tool log");
  assert.ok(master.some((i) => i.kind === "peer" && i.text === "1:1 상세 보고"));
  const copies = master.filter((i) => i.kind === "message" && i.origin === "result");
  assert.equal(copies.length, 2, "new and legacy result copies");
  assert.match(copies[0].kind === "message" ? copies[0].text : "", /검증 로그/);
  assert.ok(master.some((i) => i.kind === "notice" && i.origin === "system"), "the status check is never a worker bubble");
  const worker = buildItems(history(), "w1", false);
  assert.ok(worker.some((i) => i.kind === "message" && i.origin === "result" && i.text.includes("검증 로그")));
});

test("legacy wrappers are recognized only when the consult facts match; people typing the same words keep their message", () => {
  const typed = [
    ev("orch", "orch", { type: "consult_start", consultId: 5, kind: "implement", from: "orch", to: "w1", request: "x", attachments: [] }),
    ev("orch", "orch", { type: "consult_end", consultId: 5, status: "done", summary: "진짜\n  사본", files: [] }),
    ev("orch", "w2", { type: "room_message", from: "w2", text: "[구현 · done · 협의 5]\n다른 발신자" }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "[구현 · error · 협의 5]\n상태 불일치" }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "[구현 · done · 협의 9]\n없는 협의" }),
    ev("orch", "orch", { type: "room_message", from: "orch", text: "[앱 상태 점검] 클로드 1호의 활동이 6분간 없습니다. 마스터 본인 발언" }),
    // Same sender, id and status, but a correction written after the header: a real message.
    ev("orch", "w1", { type: "room_message", from: "w1", text: "[구현 · done · 협의 5]\n앞선 결과에 정정이 필요합니다." }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "[구현 · done · 협의 5]\n진짜 사본" }),
  ];
  const main = buildItems(typed, undefined, false);
  assert.deepEqual(main.filter((i) => i.kind === "message").map((i) => i.kind === "message" && i.text.split("\n")[1]), ["다른 발신자", "상태 불일치", "없는 협의", undefined, "앞선 결과에 정정이 필요합니다."]);
  assert.ok(!JSON.stringify(main).includes("진짜 사본"), "the exact copy of the recorded summary is the app's");
  assert.equal(roomProvenance({ type: "room_message", from: "w1", text: "그냥 대화" }).kind, "chat");
});

test("a hidden top-level tool call still closes the master's open stream", () => {
  const events = [
    ev("orch", "orch", { type: "text_delta", text: "앞 문장" }),
    ev("orch", "orch", { type: "tool_call", id: "t", name: "Bash", input: "{}" }),
    ev("orch", "orch", { type: "text_delta", text: "뒷 문장" }),
  ];
  const main = buildItems(events, undefined, true);
  assert.deepEqual(main.map((i) => i.kind === "message" && [i.text, i.streaming]), [["앞 문장", false], ["뒷 문장", true]]);
});

test("incremental main fold matches the full fold, including legacy recognition across checkpoints", () => {
  const events = history();
  const build = createTimelineBuilder();
  for (let n = 1; n <= events.length; n++) build(events.slice(0, n), undefined, false);
  assert.deepEqual(build(events, undefined, false), buildItems(events, undefined, false));
  const many: TimelineEvent[] = [];
  for (let i = 0; i < 300; i++) many.push(ev("orch", "orch", { type: "text", text: `m${i}` }));
  const all = [...many, ...events];
  const incremental = createTimelineBuilder();
  incremental(all.slice(0, 280), undefined, false);
  assert.deepEqual(incremental(all, undefined, false), buildItems(all, undefined, false));
});

test("new responses in the main view count group lines, not workers' folded internals or result copies", () => {
  const start = history().slice(0, 6);
  const build = createTimelineBuilder();
  const seen = seenReplies(build(start, undefined, true), true);
  const later = [...start,
    ev("consult:1", "w1", { type: "text", text: "내부 진행" }),
    ev("orch", "orch", { type: "consult_end", consultId: 1, status: "done", summary: "보고", files: [] }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "[구현 · done · 협의 1]\n보고", kind: "result", consultId: 1, status: "done" }),
  ];
  assert.equal(unseenReplies(build(later, undefined, true), seen, true).count, 0);
  const spoken = [...later, ev("orch", "w1", { type: "room_message", from: "w1", text: "끝났어요. 확인 부탁해요." })];
  assert.equal(unseenReplies(build(spoken, undefined, true), seen, true).count, 1);
  assert.equal(unseenReplies(build(spoken, undefined, true), seen, true).count, 1, "a replayed build counts once");
  // Other views keep counting every reply.
  assert.equal(unseenReplies(buildItems(spoken, "orch", true), seenReplies(buildItems(start, "orch", true))).count, 2);
});

test("failure reasons skip account metadata but keep limit notices; status brief names who is quiet", () => {
  assert.equal(consultReason("[CLI 지정 계정=gpt-3 · 실제 실행 계정=gpt-3]\nrate limit reached\n로그"), "rate limit reached");
  assert.match(consultReason("[CLI 지정 계정=a]\n[CLI 한도 소진 — 자동 계정 전환·재시도 없음.]\n오류")!, /^\[CLI 한도 소진/);
  assert.equal(consultReason("x".repeat(300))!.length, 200);
  assert.equal(consultReason(undefined), undefined);
  assert.equal(systemBrief(CHECK), "앱 상태 점검 · 클로드 1호의 활동이 6분간 없습니다. 실패로 단정하지 않습니다.");
});

test("rendered main view folds long group lines and consult reports; detail views show them whole", async () => {
  Object.assign(globalThis, { React, window: { chatterbox: {} }, localStorage: { getItem: () => null } });
  const { ItemList, MainTimeline } = await import("./components/Items");
  const question = "마지막 줄 질문: 이 계약으로 진행해도 될까요?";
  const events = [...history(),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "근거 설명 ".repeat(150) + "\n" + question }),
    ev("orch", "orch", { type: "text", text: "마스터 답변 ".repeat(150) }),
  ];
  const render = (main: boolean, view: NodeId | undefined) =>
    renderToStaticMarkup(createElement(MainTimeline.Provider, { value: main }, createElement(ItemList, { items: buildItems(events, view, false), chatId: 1, paginate: false })));
  const main = render(true, undefined);
  assert.match(main, /data-testid="message-expand"[^>]*aria-expanded="false"/);
  assert.match(main, new RegExp(`data-testid="message-tail"[^>]*>끝부분 · ${question}`), "the closing question stays visible");
  assert.equal((main.match(/data-testid="message-long"/g) ?? []).length, 1, "the master's own answer is not folded");
  assert.doesNotMatch(main, /data-testid="consult-summary"/);
  assert.match(main, /data-testid="consult-summary-toggle"/);
  assert.match(main, /data-testid="consult-error-line"[^>]*><span[^>]*>rate limit reached/);
  assert.match(main, /data-testid="room-system-notice"/);
  assert.doesNotMatch(main, /자동 결과/);
  const master = render(false, "orch");
  assert.match(master, /data-testid="consult-summary"/);
  assert.doesNotMatch(master, /data-testid="message-expand"/);
  assert.doesNotMatch(master, /data-testid="consult-error-line"/);
  assert.match(master, /자동 결과/);
});

test("structured reviews: main view and remote show verdict, counts and only what must be acted on; detail views keep the full report", async () => {
  Object.assign(globalThis, { React, window: { chatterbox: {} }, localStorage: { getItem: () => null } });
  const { ItemList, MainTimeline } = await import("./components/Items");
  const { ReviewBlock } = await import("./remote/Improvements");
  const review = {
    verdict: "changes_requested" as const,
    revision: "r1",
    summary: "FULL_REVIEW_BODY ".repeat(300),
    findings: [
      { severity: "high" as const, path: "a.ts", line: 3, message: "필수 수정 사항\n두 번째 줄 상세" },
      { severity: "low" as const, message: "LOW_DETAIL_FINDING" },
    ],
    tests: [
      { name: "unit", status: "passed" as const, detail: "PASSED_TEST_DETAIL" },
      { name: "e2e", status: "failed" as const, detail: "FAILED_TEST_DETAIL" },
    ],
  };
  const events = [
    ev("orch", "orch", { type: "consult_start", consultId: 40, kind: "review", from: "orch", to: "w1", request: "리뷰", attachments: [] }),
    ev("consult:40", "w1", { type: "review_result", consultId: 40, review }),
    ev("orch", "orch", { type: "consult_end", consultId: 40, status: "done", summary: "자유 문장 보고", files: [] }),
  ];
  const render = (main: boolean, view: NodeId | undefined) =>
    renderToStaticMarkup(createElement(MainTimeline.Provider, { value: main }, createElement(ItemList, { items: buildItems(events, view, false), chatId: 1, paginate: false })));
  const main = render(true, undefined);
  assert.match(main, /data-compact="true"/);
  assert.match(main, /data-testid="review-verdict"[^>]*>수정 요청/);
  assert.match(main, /지적 높음 1 · 중간 0 · 낮음 1 · 테스트 통과 1 · 실패 1 · 미실행 0/);
  assert.match(main, /a\.ts:3 <\/span><span[^>]*>필수 수정 사항<\/span>/, "high finding: first line only");
  assert.match(main, /테스트 실패 · <span[^>]*>e2e/);
  assert.match(main, /data-testid="consult-summary-toggle"/);
  for (const hidden of ["FULL_REVIEW_BODY", "LOW_DETAIL_FINDING", "PASSED_TEST_DETAIL", "FAILED_TEST_DETAIL", "두 번째 줄 상세", "자유 문장 보고"]) assert.ok(!main.includes(hidden), hidden);
  const master = render(false, "orch");
  for (const shown of ["FULL_REVIEW_BODY", "LOW_DETAIL_FINDING", "FAILED_TEST_DETAIL", "자유 문장 보고"]) assert.ok(master.includes(shown), shown);
  assert.doesNotMatch(master, /data-compact/);
  const remote = renderToStaticMarkup(createElement(ReviewBlock, { review, status: "done" }));
  assert.match(remote, /수정 요청/);
  assert.match(remote, /data-testid="remote-review-counts"/);
  assert.match(remote, /필수 수정 사항/);
  for (const hidden of ["FULL_REVIEW_BODY", "LOW_DETAIL_FINDING", "PASSED_TEST_DETAIL", "FAILED_TEST_DETAIL", "두 번째 줄 상세"]) assert.ok(!remote.includes(hidden), `remote ${hidden}`);
  // A review without a structured report is never shown as a pass.
  assert.match(renderToStaticMarkup(createElement(ReviewBlock, { status: "done" })), /통과로 간주하지 않음/);
});

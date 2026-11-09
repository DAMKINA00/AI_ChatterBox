// Renderer helpers for checklist dependencies, structured reviews, run statistics rows and conversation forks.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, ChatAgent, Consult, NodeId, PlanStep, ReviewResult, Role, TimelineEvent } from "../../../shared/types";
import { buildItems, createTimelineBuilder, type Item } from "../timeline";
import { forkEventId, forkOriginText } from "./fork";
import { consultCardIds, planConsultLinks, planStepViews } from "./plan-view";
import { consultCardReview, consultCardStatus, reviewOf, reviewsFromEvents, reviewTotalsText, summarizeReviews } from "./review-summary";
import { formatDuration, PENDING_TOOL_LABEL, RUN_STATS_NOTE, runStatsFlags, runStatsRows } from "./run-stats-view";

let nextId = 1;
const ev = (node: NodeId, role: Role | null, event: AgentEvent, at = nextId): TimelineEvent => ({ id: nextId++, chatId: 1, node, role, at, event });

const pass: ReviewResult = { verdict: "pass", revision: "r1", summary: "ok", findings: [], tests: [{ name: "unit", status: "passed" }] };
const changes: ReviewResult = {
  verdict: "changes_requested", revision: "r2", summary: "fix",
  findings: [{ severity: "high", message: "bug", path: "a.ts", line: 3 }, { severity: "low", message: "nit" }],
  tests: [{ name: "unit", status: "failed", detail: "1 fail" }, { name: "e2e", status: "not_run" }],
};
function consult(id: number, status: Consult["status"], kind: Consult["kind"] = "review", review?: ReviewResult): Consult {
  return { id, chatId: 1, seq: id, fromRole: "orch", toRole: "w1", scope: [], kind, request: "r", responseSummary: null, filesChanged: [], status, startedAt: 0, endedAt: null, review };
}

// ---------- checklist

test("legacy checklist keeps a plain list: no blockers, no 'ready' noise", () => {
  const views = planStepViews([{ title: "[클로드 1호] A", status: "pending" }, { title: "B", status: "inProgress" }]);
  assert.deepEqual(views.map((v) => [v.blockers.length, v.ready]), [[0, false], [0, false]]);
  assert.notEqual(views[0].key, views[1].key);
});

test("structured checklist shows unfinished prerequisites and ready steps; completion is never inferred", () => {
  const steps: PlanStep[] = [
    { id: "api", title: "API", status: "completed", owner: "클로드 1호" },
    { id: "ui", title: "UI", status: "pending", dependsOn: ["api", "types"] },
    { id: "types", title: "", status: "inProgress" },
    { id: "docs", title: "문서", status: "pending", dependsOn: ["api"] },
  ];
  const views = planStepViews(steps);
  assert.deepEqual(views[1].blockers.map((s) => s.id), ["types"]);
  assert.equal(views[1].ready, false);
  assert.equal(views[3].ready, true);
  assert.equal(views[0].ready, false, "completed is not 'ready'");
  assert.deepEqual(views.map((v) => v.step.status), steps.map((s) => s.status));
});

test("consult links resolve loaded consults and keep unknown ids visible", () => {
  const links = planConsultLinks({ title: "x", status: "pending", consultIds: [5, 9, 5] }, [consult(5, "error", "implement")]);
  assert.deepEqual(links.map((l) => [l.consultId, l.consult?.status]), [[5, "error"], [9, undefined]]);
});

test("consult links can target every card on the page, nested ones too, and nothing else", () => {
  const events = [
    ev("orch", "orch", { type: "consult_start", consultId: 30, kind: "implement", from: "orch", to: "w1", request: "parent", attachments: [] }),
    ev("consult:30", "w1", { type: "consult_start", consultId: 31, kind: "review", from: "w1", to: "w2", request: "nested", attachments: [] }),
    ev("orch", "orch", { type: "text", text: "not a card" }),
  ];
  assert.deepEqual([...consultCardIds(buildItems(events, undefined, false))].sort(), [30, 31]);
  assert.equal(consultCardIds([]).size, 0, "nothing loaded: links stay disabled");
});

// ---------- structured review

test("a pass reported before an error/stop/limit is never counted as a finished pass", () => {
  const consults = [consult(1, "error", "review", pass), consult(2, "stopped", "review", pass), consult(3, "limited", "review", pass), consult(4, "done", "review", pass)];
  const t = summarizeReviews(consults);
  assert.equal(t.pass, 1);
  assert.equal(t.incomplete, 3);
  assert.equal(t.tests.passed, 1, "only finished reviews add test counts");
  assert.match(reviewTotalsText(t), /실행 미완료 3/);
});

test("finished review without a report is '구조화 결과 없음', running review is pending, other kinds ignored", () => {
  const t = summarizeReviews([consult(1, "done"), consult(2, "running", "review", pass), consult(3, "done", "implement", pass), consult(4, "done", "review", changes)]);
  assert.deepEqual([t.total, t.missing, t.running, t.pass, t.changesRequested], [3, 1, 1, 0, 1]);
  assert.deepEqual(t.findings, { high: 1, medium: 0, low: 1 });
  assert.deepEqual(t.tests, { passed: 0, failed: 1, notRun: 1 });
  assert.match(reviewTotalsText(t), /구조화 결과 없음 1/);
});

test("the latest review_result event wins over an older consult record", () => {
  const events = [ev("consult:7", "w1", { type: "review_result", consultId: 7, review: changes }), ev("consult:7", "w1", { type: "review_result", consultId: 7, review: pass })];
  const fromEvents = reviewsFromEvents(events);
  assert.equal(reviewOf(7, consult(7, "done", "review", changes), fromEvents)?.verdict, "pass");
  assert.equal(reviewOf(8, consult(8, "done", "review", changes), fromEvents)?.verdict, "changes_requested", "record covers histories without the event");
  assert.equal(summarizeReviews([consult(7, "done", "review", changes)], fromEvents).pass, 1);
});

test("review_result folds onto the consult card in unified, nested, worker and consult views", () => {
  const events = [
    ev("orch", "orch", { type: "consult_start", consultId: 10, kind: "implement", from: "orch", to: "w1", request: "parent", attachments: [] }),
    ev("consult:10", "w1", { type: "consult_start", consultId: 11, kind: "review", from: "w1", to: "w2", request: "nested", attachments: [] }),
    ev("consult:11", "w2", { type: "text", text: "looking" }),
    ev("consult:11", "w2", { type: "review_result", consultId: 11, review: changes }),
    ev("consult:10", "w1", { type: "consult_end", consultId: 11, status: "done", summary: "자유문장 요약", files: [] }),
  ];
  const outer = buildItems(events, undefined, false)[0] as Extract<Item, { kind: "consult" }>;
  const inner = outer.children.find((x) => x.kind === "consult") as Extract<Item, { kind: "consult" }>;
  assert.equal(inner.review?.verdict, "changes_requested");
  assert.equal(inner.summary, "자유문장 요약", "free-text summary kept");
  assert.equal(outer.review, undefined);
  for (const view of ["w2", "consult:11"] as const) {
    const card = buildItems(events, view, false).find((x) => x.kind === "consult") as Extract<Item, { kind: "consult" }> | undefined;
    assert.equal(card?.review?.verdict, "changes_requested", view);
  }
  // Incremental builder gives the same result as a full fold.
  const build = createTimelineBuilder();
  for (let n = 1; n <= events.length; n++) build(events.slice(0, n), undefined, true);
  assert.deepEqual(build(events, undefined, false), buildItems(events, undefined, false));
});

test("review card: latest report first, record as fallback, run state from the record", () => {
  const record = consult(9, "done", "review", changes);
  assert.deepEqual(consultCardReview({ status: "stopped" }, record), { review: changes, status: "done" }, "record-only history");
  assert.deepEqual(consultCardReview({ review: pass, status: "running" }, record), { review: pass, status: "done" }, "the event outranks an older record");
  assert.deepEqual(consultCardReview({ review: pass, status: "error" }, undefined), { review: pass, status: "error" }, "record not loaded yet");
  assert.deepEqual(consultCardReview({ status: "done" }, consult(9, "error")), { review: undefined, status: "error" });
});

test("card header and review block share one run state when the timeline has no consult_end", () => {
  // Record-only review (verdict on the row) and a review a restart marked stopped: neither wrote consult_end,
  // so the timeline item still says running while the record is final.
  const events = [
    ev("orch", "orch", { type: "consult_start", consultId: 40, kind: "review", from: "orch", to: "w1", request: "record only", attachments: [] }),
    ev("orch", "orch", { type: "consult_start", consultId: 41, kind: "review", from: "orch", to: "w2", request: "crash resume", attachments: [] }),
    ev("consult:41", "w2", { type: "review_result", consultId: 41, review: pass }),
  ];
  const cards = buildItems(events, undefined, false).filter((x) => x.kind === "consult") as Extract<Item, { kind: "consult" }>[];
  assert.deepEqual(cards.map((c) => c.status), ["running", "running"], "timeline copy is stale");
  const records = [consult(40, "done", "review", changes), consult(41, "stopped")];
  for (const card of cards) {
    const record = records.find((r) => r.id === card.consultId);
    const header = consultCardStatus(card, record);
    assert.equal(header, record?.status, `header follows the record (${card.consultId})`);
    assert.equal(consultCardReview(card, record).status, header, `review block matches the header (${card.consultId})`);
  }
  assert.equal(consultCardReview(cards[1], records[1]).review?.verdict, "pass", "a report before the stop stays visible");
  assert.equal(consultCardStatus(cards[0], undefined), "running", "record not loaded yet: timeline copy");
});

// ---------- fork

test("only user and master messages are fork points, in every view", () => {
  const events = [
    ev("orch", null, { type: "user", text: "지시", attachments: [] }),
    ev("orch", "orch", { type: "text", text: "마스터 본문" }),
    ev("orch", "orch", { type: "consult_start", consultId: 20, kind: "implement", from: "orch", to: "w1", request: "r", attachments: [] }),
    ev("consult:20", "w1", { type: "text", text: "작업자 본문" }),
    ev("orch", "w1", { type: "room_message", from: "w1", text: "작업자 그룹 발언" }),
    ev("orch", "orch", { type: "room_message", from: "orch", text: "마스터 그룹 발언" }),
  ];
  const offered = (view?: Parameters<typeof buildItems>[1]) => buildItems(events, view, false).filter((i) => forkEventId(i) !== undefined).map((i) => (i as { text: string }).text);
  assert.deepEqual(offered(undefined), ["지시", "마스터 본문"]);
  assert.deepEqual(offered("orch"), ["지시", "마스터 본문"]);
  const workerText = buildItems(events, "w1", false).filter((i) => i.kind === "message").map((i) => (i as { text: string }).text);
  assert.ok(workerText.includes("작업자 본문") && workerText.includes("작업자 그룹 발언"), "the worker view does show them");
  assert.deepEqual(offered("w1"), []);
  assert.deepEqual(offered("consult:20"), []);
});

test("fork_context is a top-level item; user/master messages expose their persisted event id", () => {
  const events = [
    ev("orch", null, { type: "fork_context", text: "관리자: 안녕\n마스터: 네", attachments: [] }),
    ev("orch", null, { type: "user", text: "이어서", attachments: [] }),
    ev("orch", "orch", { type: "text_delta", text: "작성" }),
  ];
  const live = buildItems(events, undefined, true);
  assert.equal(live[0].kind, "fork");
  assert.equal(forkEventId(live[1]), events[1].id);
  assert.equal(forkEventId(live[2]), undefined, "streaming preview cannot be a fork point");
  const done = buildItems([...events, ev("orch", "orch", { type: "text", text: "완료" })], undefined, false);
  assert.equal(forkEventId(done[2]), nextId - 1, "final text carries its event id");
  const tool = buildItems([ev("orch", "orch", { type: "tool_call", id: "t", name: "Bash", input: "ls" })], undefined, false);
  assert.equal(forkEventId(tool[0]), undefined, "tool cards are not fork points");
  const liveOnly = buildItems([{ id: 0, chatId: 1, node: "orch", role: null, at: 1, event: { type: "user", text: "x", attachments: [] } }], undefined, true);
  assert.equal(forkEventId(liveOnly[0]), undefined, "unsaved event has no id");
});

test("fork origin text names the source even after it is deleted", () => {
  const text = forkOriginText({ sourceChatId: 3, sourceEventId: 42, sourceTitle: "원본", range: "from", includeAttachments: false });
  assert.match(text, /원본.*채팅 3.*#42부터.*첨부 제외/);
});

// ---------- run statistics rows

test("run stats rows: total/role/consult; finished work does not grow with now", () => {
  const agents: ChatAgent[] = [
    { id: 1, chatId: 1, key: "w1", kind: "claude", number: 1, nickname: "클로드 1호", job: "", sessionId: null, status: "active", createdAt: 0 },
    { id: 2, chatId: 1, key: "w2", kind: "gpt", number: 1, nickname: "지피티 1호", job: "", sessionId: null, status: "released", createdAt: 0 },
  ];
  const events = [
    ev("orch", "orch", { type: "text", text: "a" }, 1000),
    ev("consult:1", "w1", { type: "tool_call", id: "t", name: "Bash", input: "x" }, 2000),
    ev("consult:2", "w2", { type: "text", text: "done" }, 2500),
    ev("consult:2", "w2", { type: "turn_end", ok: true }, 3000),
  ];
  const consults = [{ ...consult(1, "running", "implement"), toRole: "w1" as Role }, { ...consult(2, "done", "review"), toRole: "w2" as Role }];
  const rows = runStatsRows(events, agents, consults, 10_000);
  assert.equal(rows.total.elapsedMs, 9000);
  const w1 = rows.roles.find((r) => r.key === "w1")!.stats;
  const w2 = rows.roles.find((r) => r.key === "w2")!.stats;
  assert.equal(w1.pendingTools, 1);
  assert.ok(w1.toolMs >= 8000, "running tool extends to now");
  assert.equal(w2.elapsedMs, 500, "released worker ends at its last record");
  assert.equal(rows.consults.find((r) => r.key === "consult:2")!.stats.elapsedMs, 500);
  assert.equal(rows.consults[0].key, "consult:2", "newest consult first");
  assert.equal(runStatsRows([], agents, consults).total.eventCount, 0);
});

test("a tool call without a result reads as unconfirmed, not as running", () => {
  const call = ev("consult:1", "w1", { type: "tool_call", id: "x", name: "Bash", input: "x" }, 1000);
  const ended = runStatsRows([call, ev("consult:1", "w1", { type: "turn_end", ok: true }, 2000)], undefined, undefined).total;
  const open = runStatsRows([call], undefined, undefined, 5000).total;
  for (const stats of [ended, open]) {
    assert.equal(stats.pendingTools, 1);
    assert.deepEqual(runStatsFlags(stats), [`도구 ${PENDING_TOOL_LABEL} 1`]);
  }
  assert.equal(ended.toolMs, 1000, "the closed call stops at its turn end");
  assert.equal(open.toolMs, 4000, "the open call runs to now");
  assert.ok(RUN_STATS_NOTE.includes(PENDING_TOOL_LABEL) && !RUN_STATS_NOTE.includes("진행 중·대기 중"), RUN_STATS_NOTE);
});

test("master row: a finished turn stops the clock while workers run; the next turn restarts it", () => {
  const consults = [{ ...consult(1, "running", "implement"), toRole: "w1" as Role }];
  const now = 10_000;
  const master = (events: TimelineEvent[]) => runStatsRows(events, undefined, consults, now).roles.find((r) => r.key === "orch")!.stats.elapsedMs;
  const finished = [
    ev("orch", null, { type: "user", text: "지시", attachments: [] }, 900),
    ev("orch", "orch", { type: "text", text: "a" }, 1000),
    ev("orch", "orch", { type: "turn_end", ok: true }, 2000),
    ev("consult:1", "w1", { type: "text", text: "worker" }, 3000),
  ];
  assert.equal(master(finished), 1000, "pendingFinal: worker alive, master done");
  const between = [...finished,
    ev("orch", "orch", { type: "notice", text: "합류" }, 3500),
    ev("orch", "orch", { type: "agent_usage", metrics: {} as never }, 3600),
    ev("orch", "orch", { type: "consult_end", consultId: 1, status: "done", summary: "s", files: [] }, 4000),
  ];
  assert.equal(master(between), 3000, "notices and consult results are records, not a new turn");
  assert.equal(master([...between, ev("orch", null, { type: "user", text: "추가", attachments: [], queued: true, delivery: "next" }, 5000)]), 3000, "a queued instruction waits for the next boundary");
  assert.equal(master([...between, ev("orch", null, { type: "notice", text: "알림" }, 5000)]), 3000);
  assert.equal(master([...between, ev("orch", null, { type: "user", text: "새 지시", attachments: [] }, 5000)]), 9000, "a new instruction opens a turn");
  assert.equal(master([...between, ev("orch", "orch", { type: "text_delta", text: "다음" }, 5000)]), 9000, "master output opens a turn");
  assert.equal(master([...between, ev("orch", "orch", { type: "tool_call", id: "n", name: "Bash", input: "" }, 5000)]), 9000);
  assert.equal(master([...finished.slice(0, 2)]), 9000, "first turn, no turn_end yet");
  assert.equal(master([...between, ev("orch", "orch", { type: "text", text: "다음" }, 5000), ev("orch", "orch", { type: "turn_end", ok: true }, 6000)]), 5000, "the later turn ends too");
  const rows = runStatsRows(between, undefined, consults, now);
  assert.equal(rows.total.elapsedMs, 9100, "the whole chat is still running");
});

test("duration format", () => {
  assert.deepEqual([0, 12_400, 184_000, 3_720_000].map(formatDuration), ["0초", "12초", "3분 4초", "1시간 2분"]);
});

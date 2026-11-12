// Long-chat history pages: correctness (every event exactly once, consult anchors, pinned state from the
// context) and a performance guard on a synthetic chat far larger than one core frame would carry whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serialize } from "node:v8";
import { Store } from "./db";
import { CLIP_AT, CONTEXT_MAX_CHARS, EVENT_MAX_CHARS, EVENT_PAGE_LIMITS, eventChars, historyFromPage, PAGE_MAX_BYTES, pageEvent, prependPage, reduceContext, minimalContextEvent, REMOTE_TEXT_MAX_BYTES, replayLive, SNAPSHOT_LIMITS, stateEvents, type EventPage } from "../shared/event-page";
import { FULL_EVENT_MAX_CHARS } from "./db";
import { oneAtATime } from "../renderer/src/lib/full-event";
import { RunStatsCache } from "./run-stats-cache";
import { runStatsRows } from "../renderer/src/lib/run-stats-view";
import { appendEvent } from "../renderer/src/timeline";
import { emptyTeamUpdates, mergeTeamUpdates, withoutAnswered } from "../renderer/src/lib/history-load";
import type { ChatAgent, Consult } from "../shared/types";
import { DEFAULT_SETTINGS, type AgentEvent, type TimelineEvent } from "../shared/types";
import { buildItems, eventText, markClipped, planOf } from "../renderer/src/timeline";
import { summarizeRunStats } from "../shared/run-stats";

function withStore(run: (store: Store, chatId: number) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-pages-"));
  const store = new Store(join(dir, "chatterbox.db"));
  try {
    const project = store.createProject("P", dir, DEFAULT_SETTINGS);
    run(store, store.createChat(project.id, "긴 채팅").id);
  } finally {
    (store as unknown as { db: { close(): void } }).db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const big = (n: number) => "가".repeat(n); // two-byte text, as Korean tool output is in a real chat

/** A chat shaped like the one that never opened: long turns, many tool logs with huge outputs, consults, a plan. */
function fillLongChat(store: Store, chatId: number, turns = 8, toolsPerTurn = 300) {
  const db = (store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec("BEGIN");
  const add = (event: AgentEvent, node: TimelineEvent["node"] = "orch", role: TimelineEvent["role"] = "orch") => store.addEvent(chatId, node, role, event);
  let consult = 0;
  for (let t = 0; t < turns; t++) {
    add({ type: "user", text: t === 0 ? "/plan 클라이언트 개선" : `지시 ${t}`, attachments: [] }, "orch", null);
    if (t === 0) add({ type: "plan_update", steps: [{ title: "분석", status: "completed" }, { title: "구현", status: "inProgress" }], planId: 1 } as AgentEvent);
    add({ type: "expression", expression: "thinking" });
    for (let i = 0; i < toolsPerTurn; i++) {
      add({ type: "tool_call", id: `c${t}-${i}`, name: "Bash", input: `cmd ${i}` });
      add({ type: "tool_result", id: `c${t}-${i}`, ok: true, output: i % 20 === 0 ? big(300_000) : `ok ${i}` });
      if (i % 50 === 0) add({ type: "agent_usage", metrics: { inputTokens: 10, outputTokens: 5 } } as AgentEvent);
    }
    // A consult that spans the rest of the turn: its worker events come long after its start.
    const id = ++consult;
    add({ type: "consult_start", consultId: id, kind: "implement", from: "orch", to: "w1", request: `작업 ${id}`, attachments: [] });
    for (let i = 0; i < 60; i++) add({ type: "text", text: `작업자 진행 ${i}` }, `consult:${id}`, "w1");
    add({ type: "consult_end", consultId: id, status: "done", summary: `요약 ${id}`, files: [] });
    add({ type: "text", text: `마스터 정리 ${t}` });
    add({ type: "turn_end", ok: true } as AgentEvent);
  }
  db.exec("COMMIT");
}

const light = (event: AgentEvent) => pageEvent({ id: 1, chatId: 1, node: "orch", role: "orch", at: 1, event });

test("page events shorten long tool text and keep the original length", () => {
  const long = "x".repeat(CLIP_AT + 1);
  const result = light({ type: "tool_result", id: "a", ok: true, output: long });
  assert.equal(result.event.type === "tool_result" && result.event.clipped, long.length);
  assert.ok(result.clipped && result.event.type === "tool_result" && result.event.output.length < 6000 && result.event.output.startsWith("xxxx") && result.event.output.includes("자 생략"));
  const short = { id: 2, chatId: 1, node: "orch", role: "orch", at: 1, event: { type: "tool_result", id: "b", ok: true, output: "짧음" } } as TimelineEvent;
  assert.equal(pageEvent(short), short);
  const call = light({ type: "tool_call", id: "c", name: "Write", input: long });
  assert.equal(call.event.type === "tool_call" && call.event.clipped, long.length);
});

test("any large field is shortened: diffs, approval details, long messages; each event stays under EVENT_MAX_CHARS", () => {
  const diff = (n: number) => ({ path: `src/f${n}.ts`, kind: "update", diff: big(200_000) });
  const call = light({ type: "tool_call", id: "d", name: "Edit", input: "짧은 입력", diffs: Array.from({ length: 40 }, (_, i) => diff(i)) } as AgentEvent);
  assert.ok(call.clipped && eventChars(call) <= EVENT_MAX_CHARS + 200, `tool call is ${eventChars(call)}`);
  assert.equal(call.event.type, "tool_call");
  const approval = light({ type: "approval_request", request: { id: "a", role: "w1", title: "큰 변경", detail: big(500_000), risk: "high", diffs: Array.from({ length: 20 }, (_, i) => diff(i)) } } as AgentEvent);
  assert.ok(approval.clipped && eventChars(approval) <= EVENT_MAX_CHARS + 200);
  assert.equal(approval.event.type === "approval_request" && approval.event.request.id, "a", "ids survive");
  const message = light({ type: "text", text: big(70_000) });
  assert.ok(message.clipped && eventChars(message) <= EVENT_MAX_CHARS + 200);
  assert.ok(message.event.type === "text" && message.event.text.length > 40_000, "a long message keeps most of its text");
});

test("pages of a long chat: bounded, fast, every event exactly once, full text on demand", () => {
  withStore((store, chatId) => {
    fillLongChat(store, chatId);
    const all = store.events(chatId);
    // The whole history no longer fits one core frame; a page does, many times over.
    assert.ok(serialize(all).length > 64 * 1024 * 1024, "fixture is large");
    let started = performance.now();
    const first = store.eventsPage(chatId);
    const firstMs = performance.now() - started;
    assert.ok(firstMs < 1500, `first page took ${Math.round(firstMs)}ms`);
    assert.ok(serialize(first).length < PAGE_MAX_BYTES, `first page is ${serialize(first).length} bytes`);
    assert.ok(first.hasMore && first.context!.length > 0);
    assert.ok(first.events.length <= EVENT_PAGE_LIMITS.events + 20);

    // Walk back to the beginning: the pages together hold every stored event once (anchors aside).
    const seen = new Map<number, number>();
    let page: EventPage = first;
    for (;;) {
      for (const e of page.events) if (e.id >= page.start) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      if (!page.hasMore) break;
      started = performance.now();
      page = store.eventsPage(chatId, page.start);
      assert.ok(performance.now() - started < 1500);
    }
    assert.equal(seen.size, all.length);
    assert.ok([...seen.values()].every(n => n === 1));

    // A shortened output is complete when asked for alone.
    const clipped = first.events.find(e => e.event.type === "tool_result" && e.event.clipped);
    if (clipped) {
      const full = store.event(chatId, clipped.id);
      assert.equal(full?.event.type === "tool_result" && full.event.output.length, 300_000);
    }
    // Run statistics aggregated in the core match the full history, also after more events arrive.
    const cache = new RunStatsCache(store);
    assert.deepEqual(cache.rows(chatId), runStatsRows(all, store.listAgents(chatId), store.listConsults(chatId)));
    store.addEvent(chatId, "orch", "orch", { type: "tool_call", id: "late", name: "Bash", input: "x" });
    const now = Date.now() + 5000;
    assert.deepEqual(cache.rows(chatId, now), runStatsRows(store.events(chatId), store.listAgents(chatId), store.listConsults(chatId), now));
    assert.equal(summarizeRunStats(store.events(chatId)).pendingTools, cache.rows(chatId).total.pendingTools);
  });
});

test("a page that starts inside a consult carries the consult's start, so its worker events still fold into a card", () => {
  withStore((store, chatId) => {
    store.addEvent(chatId, "orch", null, { type: "user", text: "시작", attachments: [] });
    store.addEvent(chatId, "orch", "orch", { type: "consult_start", consultId: 7, kind: "review", from: "orch", to: "w2", request: "리뷰", attachments: [] });
    // More visible events than one page holds, all inside the open consult.
    for (let i = 0; i < EVENT_PAGE_LIMITS.visible + 50; i++) store.addEvent(chatId, "consult:7", "w2", { type: "text", text: `리뷰 ${i}` });
    const page = store.eventsPage(chatId);
    assert.ok(page.hasMore);
    assert.equal(page.events[0].event.type, "consult_start");
    assert.ok(page.events[0].id < page.start);
    const items = buildItems(page.events, undefined, true);
    const card = items.find(i => i.kind === "consult");
    assert.ok(card && card.kind === "consult" && card.children.length === EVENT_PAGE_LIMITS.visible);
    // Loading the older page does not duplicate the anchor.
    const merged = prependPage(historyFromPage(page), store.eventsPage(chatId, page.start));
    assert.equal(merged.events.filter(e => e.event.type === "consult_start").length, 1);
    assert.equal(merged.events.length, store.events(chatId).length);
    assert.equal(merged.hasMore, false);
  });
});

test("pinned state from the context equals the state of the whole history", () => {
  withStore((store, chatId) => {
    fillLongChat(store, chatId, 8, 150);
    const all = store.events(chatId);
    const first = historyFromPage(store.eventsPage(chatId));
    assert.ok(first.hasMore);
    // The plan was made in the first turn, far outside the newest page.
    assert.ok(!first.events.some(e => e.event.type === "plan_update"));
    assert.deepEqual(planOf(stateEvents(first)), planOf(all));
    // Live events appended after loading stay at the end through an older-page merge.
    const live: TimelineEvent = { id: 0, chatId, node: "orch", role: "orch", at: Date.now(), event: { type: "text_delta", text: "작성 중" } };
    const withLive = { ...first, events: [...first.events, live] };
    const merged = prependPage(withLive, store.eventsPage(chatId, first.start));
    assert.equal(merged.events.at(-1), live);
    assert.ok(merged.context.every(e => e.id < merged.start));
  });
});

test("an older page that is not older than what is loaded is ignored", () => {
  const history = { events: [{ id: 10, chatId: 1, node: "orch", role: "orch", at: 1, event: { type: "text", text: "a" } }] as TimelineEvent[], context: [], start: 10, hasMore: true };
  assert.equal(prependPage(history, { events: [], start: 10, hasMore: true }), history);
});

test("attachment ownership is looked up without reading tool output", () => {
  withStore((store, chatId) => {
    store.addEvent(chatId, "orch", null, { type: "user", text: "그림", attachments: [{ id: 41, name: "a.png", mime: "image/png", size: 1, path: "C:/x/a.png" }] });
    store.addEvent(chatId, "orch", "orch", { type: "tool_result", id: "t", ok: true, output: '{"id":42,"name":"b.png","mime":"image/png"}' });
    assert.equal(store.chatHasAttachment(chatId, 41), true);
    assert.equal(store.chatHasAttachment(chatId, 42), false);
    assert.equal(store.chatHasAttachment(chatId + 1, 41), false);
  });
});

test("hard size bound: big old instructions, approvals with diffs and huge tool diffs never push a page past PAGE_MAX_BYTES", () => {
  withStore((store, chatId) => {
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    db.exec("BEGIN");
    for (let i = 0; i < 200; i++) {
      // Old history: long instructions and approvals with large diffs, all context types.
      store.addEvent(chatId, "orch", null, { type: "user", text: big(20_000), attachments: [] });
      store.addEvent(chatId, "w1", "w1", { type: "approval_request", request: { id: `a${i}`, role: "w1", title: "변경", detail: big(20_000), risk: "low", diffs: [{ path: "a.ts", kind: "update", diff: big(20_000) }] } } as AgentEvent);
      if (i % 2) store.addEvent(chatId, "w1", "w1", { type: "approval_resolved", id: `a${i}`, decision: "once" });
      store.addEvent(chatId, "orch", "orch", { type: "plan_update", steps: Array.from({ length: 30 }, () => ({ title: big(2000), status: "pending" })), planId: i } as AgentEvent);
    }
    // The newest events: tool calls whose diffs are huge.
    for (let i = 0; i < 60; i++) store.addEvent(chatId, "orch", "orch", { type: "tool_call", id: `t${i}`, name: "Edit", input: "e", diffs: [{ path: "b.ts", kind: "update", diff: big(400_000) }] } as AgentEvent);
    db.exec("COMMIT");
    const first = store.eventsPage(chatId);
    const bytes = serialize({ type: "result", id: 1, value: first }).length;
    assert.ok(bytes < PAGE_MAX_BYTES, `first page is ${bytes} bytes`);
    assert.ok(first.events.every(e => eventChars(e) <= EVENT_MAX_CHARS + 200));
    assert.ok(first.context!.reduce((n, e) => n + eventChars(e), 0) + JSON.stringify(first.snapshot).length <= CONTEXT_MAX_CHARS);
    // Unanswered approvals are counted (the newest few listed, without detail); answered ones are not.
    const { approvals } = first.snapshot!;
    const older = store.events(chatId).filter(e => e.id < first.start);
    const answered = new Set(older.flatMap(e => (e.event.type === "approval_resolved" ? [e.event.id] : [])));
    assert.equal(approvals.total, older.filter(e => e.event.type === "approval_request" && !answered.has(e.event.request.id)).length);
    assert.ok(approvals.total > SNAPSHOT_LIMITS.approvals);
    // Unanswered where the page begins (an answer inside the page is folded from the page itself).
    assert.ok(approvals.pending.length === SNAPSHOT_LIMITS.approvals && approvals.pending.every(a => !answered.has(a.id)));
    assert.ok(Number(approvals.pending[0].id.slice(1)) > Number(approvals.pending[1].id.slice(1)), "newest first");
    let page = first;
    while (page.hasMore) {
      page = store.eventsPage(chatId, page.start);
      assert.ok(serialize(page).length < PAGE_MAX_BYTES);
    }
    // The shortened diff is whole when the event is asked for alone.
    const shortened = first.events.find(e => e.clipped && e.event.type === "tool_call");
    const full = shortened && store.event(chatId, shortened.id);
    assert.equal(full?.event.type === "tool_call" && full.event.diffs?.[0].diff.length, 400_000);
  });
});

test("a preview replayed after loading is dropped when the page already has its final text", () => {
  const at = (id: number, event: AgentEvent): TimelineEvent => ({ id, chatId: 1, node: "orch", role: "orch", at: id, event });
  // The page was read after the reply finished (id 11); the stream sent deltas, then the final text.
  const snapshot = [at(10, { type: "user", text: "질문", attachments: [] }), at(11, { type: "text", text: "완성된 답" })];
  const buffered = [at(0, { type: "text_delta", text: "완성" }), at(0, { type: "text_delta", text: "된 답" }), at(11, { type: "text", text: "완성된 답" })];
  assert.deepEqual(replayLive(snapshot, buffered, appendEvent).map(e => e.event.type), ["user", "text"]);
  // A reply still streaming after the page keeps its preview, and newer events are added.
  const streaming = [at(0, { type: "text_delta", text: "작성 중" }), at(12, { type: "notice", text: "알림" })];
  assert.deepEqual(replayLive(snapshot, streaming, appendEvent).map(e => e.event.type), ["user", "text", "text_delta", "notice"]);
});

test("worker and consult updates sent while a chat loads win over the slower list answers", () => {
  const consult = (id: number, status: Consult["status"]) => ({ id, chatId: 1, status } as Consult);
  const agent = (id: number, status: ChatAgent["status"]) => ({ id, status } as ChatAgent);
  const updates = emptyTeamUpdates();
  updates.agents = [agent(1, "released")];
  updates.consults.set(5, consult(5, "done"));
  updates.consults.set(6, consult(6, "running"));
  const merged = mergeTeamUpdates([agent(1, "active")], [consult(5, "running")], updates);
  assert.deepEqual(merged.agents.map(a => a.status), ["released"]);
  assert.deepEqual(merged.consults.map(c => [c.id, c.status]), [[5, "done"], [6, "running"]]);
  assert.deepEqual(mergeTeamUpdates([agent(2, "active")], [], emptyTeamUpdates()).agents.map(a => a.id), [2]);
});

test("over the context budget the current state survives: an old running plan, its checklist and unanswered approvals", () => {
  const at = (id: number, event: AgentEvent, role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id, chatId: 1, node: "orch", role, at: id, event });
  const all: TimelineEvent[] = [
    at(1, { type: "user", text: "/plan 오래된 계획", attachments: [] }, null),
    at(2, { type: "plan_update", steps: [{ title: "1단계", status: "completed" }, { title: "2단계", status: "inProgress" }], planId: 1 } as AgentEvent),
    at(3, { type: "plan_state", state: "proposed", planId: 1 } as AgentEvent),
    at(4, { type: "user", text: "계획 실행", attachments: [] }, null),
    at(5, { type: "plan_state", state: "running", planId: 1 } as AgentEvent),
    at(6, { type: "approval_request", request: { id: "old", role: "w1", title: "오래된 승인", detail: "", risk: "high" } }, "w1"),
    at(7, { type: "goal_update", goal: { objective: "목표", status: "active", progress: "", turns: 1, updatedAt: 7 } } as AgentEvent),
  ];
  // Then a flood of follow-up instructions (the plan keeps running) and review reports.
  let id = 8;
  for (let i = 0; i < 6000; i++) all.push(at(id++, { type: "user", text: big(1000), attachments: [] }, null));
  for (let i = 0; i < 3000; i++) all.push(at(id++, { type: "review_result", consultId: i, review: { verdict: "pass", summary: big(600), findings: [], tests: [] } } as unknown as AgentEvent, "w2"));
  all.push(at(id++, { type: "plan_update", steps: [{ title: "1단계", status: "completed" }, { title: "2단계", status: "completed" }, { title: "3단계", status: "inProgress" }], planId: 1 } as AgentEvent));
  const minimal = all.flatMap(e => { const m = minimalContextEvent(e); return m ? [m] : []; });
  assert.ok(minimal.reduce((n, e) => n + eventChars(e), 0) > CONTEXT_MAX_CHARS, "the history is over the budget");
  const { context, snapshot } = reduceContext(minimal);
  assert.ok(context.reduce((n, e) => n + eventChars(e), 0) + JSON.stringify(snapshot).length <= CONTEXT_MAX_CHARS);
  const state = stateEvents({ events: [], context, snapshot, snapshotAt: id });
  assert.deepEqual(planOf(state), planOf(all), "the running plan and its latest checklist");
  assert.equal(planOf(state)?.state, "running");
  assert.deepEqual(snapshot.approvals, { pending: [{ eventId: 6, at: 6, id: "old", role: "w1", title: "오래된 승인", risk: "high" }], total: 1 });
  assert.equal(snapshot.goal?.objective, "목표");
  assert.equal(snapshot.lastUserAt, 6007, "the latest instruction time survives the cut");
  // Past history (reviews) was cut, newest kept.
  const reviews = context.filter(e => e.event.type === "review_result");
  assert.ok(reviews.length > 0 && reviews.length < 3000 && reviews.at(-1)!.event.type === "review_result");
});

test("the snapshot is bounded however plan updates, state changes and approvals pile up", () => {
  const at = (id: number, event: AgentEvent, node: TimelineEvent["node"] = "orch", role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id, chatId: 1, node, role, at: id, event });
  const all: TimelineEvent[] = [at(1, { type: "user", text: "/plan 큰 계획", attachments: [] }, "orch", null)];
  let id = 2;
  // 20,000 alternating checklist updates and state changes across plan ids, 600 unanswered approvals,
  // 300 conversations, then a final plan of 300 steps.
  for (let i = 0; i < 10_000; i++) {
    all.push(at(id++, { type: "plan_update", steps: [{ title: big(200), status: "inProgress" }], planId: i % 7 } as AgentEvent));
    all.push(at(id++, { type: "plan_state", state: i % 3 ? "running" : "proposed", planId: i % 7, reason: big(100) } as AgentEvent));
  }
  for (let i = 0; i < 600; i++) all.push(at(id++, { type: "approval_request", request: { id: `p${i}`, role: "w1", title: big(500), detail: "", risk: "low" } }, "w1", "w1"));
  for (let i = 0; i < 300; i++) all.push(at(id++, { type: "expression", expression: "thinking" }, `consult:${i}`, `w${i}`));
  all.push(at(id++, { type: "plan_update", steps: Array.from({ length: 300 }, (_, k) => ({ title: `단계 ${k}`, status: "pending" })), planId: 6 } as AgentEvent));
  all.push(at(id++, { type: "plan_state", state: "running", planId: 6 } as AgentEvent));
  const minimal = all.flatMap(e => { const m = minimalContextEvent(e); return m ? [m] : []; });
  const started = performance.now();
  const { snapshot, context } = reduceContext(minimal);
  assert.ok(performance.now() - started < 2000);
  const size = JSON.stringify(snapshot).length;
  assert.ok(size < 200_000, `snapshot is ${size} characters`);
  assert.ok(context.reduce((n, e) => n + eventChars(e), 0) + size <= CONTEXT_MAX_CHARS);
  assert.equal(snapshot.plan.view?.steps.length, SNAPSHOT_LIMITS.planSteps);
  assert.equal(snapshot.plan.stepsOmitted, 100);
  assert.equal(snapshot.plan.state, "running");
  assert.equal(snapshot.approvals.total, 600);
  assert.equal(snapshot.approvals.pending.length, SNAPSHOT_LIMITS.approvals);
  assert.equal(snapshot.approvals.pending[0].id, "p599");
  assert.equal(snapshot.conversations.length, SNAPSHOT_LIMITS.conversations);
  // Folding the snapshot gives the same plan as the whole history (apart from the step cap).
  const view = planOf(stateEvents({ events: [], context, snapshot, snapshotAt: id }));
  const whole = planOf(all);
  assert.deepEqual({ ...view, steps: view?.steps.length }, { ...whole, steps: SNAPSHOT_LIMITS.planSteps });
});

test("the snapshot keeps the state where it applies when older pages are loaded in front", () => {
  withStore((store, chatId) => {
    store.addEvent(chatId, "orch", null, { type: "user", text: "/plan 계획", attachments: [] });
    store.addEvent(chatId, "orch", "orch", { type: "plan_update", steps: [{ title: "가", status: "inProgress" }], planId: 1 } as AgentEvent);
    store.addEvent(chatId, "orch", "orch", { type: "plan_state", state: "running", planId: 1 } as AgentEvent);
    for (let i = 0; i < EVENT_PAGE_LIMITS.visible * 2 + 10; i++) store.addEvent(chatId, "orch", "orch", { type: "text", text: `진행 ${i}` });
    const all = store.events(chatId);
    let history = historyFromPage(store.eventsPage(chatId));
    assert.ok(history.snapshot && history.hasMore);
    assert.deepEqual(planOf(stateEvents(history)), planOf(all));
    while (history.hasMore) {
      history = prependPage(history, store.eventsPage(chatId, history.start));
      assert.deepEqual(planOf(stateEvents(history)), planOf(all));
    }
  });
});

test("unanswered approvals beyond the snapshot load page by page", () => {
  withStore((store, chatId) => {
    for (let i = 0; i < 600; i++) store.addEvent(chatId, "w1", "w1", { type: "approval_request", request: { id: `q${i}`, role: "w1", title: `승인 ${i}`, detail: big(1000), risk: i % 2 ? "high" : "low" } });
    store.addEvent(chatId, "w1", "w1", { type: "approval_resolved", id: "q599", decision: "deny" });
    for (let i = 0; i < EVENT_PAGE_LIMITS.visible + 5; i++) store.addEvent(chatId, "orch", "orch", { type: "text", text: `t${i}` });
    const first = store.eventsPage(chatId);
    assert.equal(first.snapshot!.approvals.total, 599);
    const second = store.pendingApprovals(chatId, first.start, SNAPSHOT_LIMITS.approvals);
    assert.equal(second.total, 599);
    assert.deepEqual(second.items.map(a => a.id).slice(0, 2), ["q548", "q547"]);
    assert.ok(second.items.every(a => !("detail" in a)));
  });
});

test("remote original text: text messages only, {id, type, text}, size-limited; desktop originals have a hard cap", () => {
  withStore((store, chatId) => {
    const user = store.addEvent(chatId, "orch", null, { type: "user", text: "원문 지시", attachments: [{ id: 1, name: "a.png", mime: "image/png", size: 1, path: "C:/secret/a.png" }] });
    const tool = store.addEvent(chatId, "orch", "orch", { type: "tool_result", id: "t", ok: true, output: "C:/secret/output" });
    const consult = store.addEvent(chatId, "orch", "orch", { type: "consult_start", consultId: 1, kind: "review", from: "orch", to: "w1", request: "요청 원문", attachments: [], scope: ["C:/secret"] });
    const hugeChars = Math.ceil(REMOTE_TEXT_MAX_BYTES / 3) + 10; // three UTF-8 bytes each
    const huge = store.addEvent(chatId, "orch", "orch", { type: "text", text: "가".repeat(hugeChars) });
    assert.deepEqual(store.eventText(chatId, user.id), { ok: true, id: user.id, type: "user", text: "원문 지시" });
    assert.deepEqual(store.eventText(chatId, consult.id), { ok: true, id: consult.id, type: "consult_start", text: "요청 원문" });
    assert.deepEqual(store.eventText(chatId, tool.id), { ok: false, reason: "type" });
    assert.deepEqual(store.eventText(chatId, huge.id), { ok: false, reason: "size", length: hugeChars });
    assert.deepEqual(store.eventText(chatId + 1, user.id), { ok: false, reason: "missing" });
    const tooBig = store.addEvent(chatId, "orch", "orch", { type: "text", text: "x".repeat(FULL_EVENT_MAX_CHARS) });
    assert.throws(() => store.event(chatId, tooBig.id), /너무 커서/);
    assert.equal(store.event(chatId, user.id)?.event.type, "user");
  });
});

test("originals load one at a time", async () => {
  let running = 0, most = 0;
  const slow = () => oneAtATime(async () => { running++; most = Math.max(most, running); await new Promise(ok => setTimeout(ok, 10)); running--; });
  const failing = oneAtATime(async () => { throw new Error("x"); });
  await Promise.all([slow(), failing.catch(() => undefined), slow(), slow()]);
  assert.equal(most, 1);
});

test("shortened messages are marked for the view; tool and approval cards keep their own handling", () => {
  const at = (id: number, event: AgentEvent, node: TimelineEvent["node"] = "orch", role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id, chatId: 1, node, role, at: id, event });
  const events = [
    at(1, { type: "user", text: big(70_000), attachments: [] }, "orch", null),
    at(2, { type: "text", text: big(70_000) }),
    at(3, { type: "consult_start", consultId: 9, kind: "implement", from: "orch", to: "w1", request: big(70_000), attachments: [] }),
    at(4, { type: "consult_end", consultId: 9, status: "done", summary: "짧은 요약", files: [] }),
    at(5, { type: "text", text: "짧은 답" }),
  ].map(pageEvent);
  assert.deepEqual(events.map(e => !!e.clipped), [true, true, true, false, false]);
  const items = markClipped(buildItems(events, undefined, false), events);
  const user = items.find(i => i.kind === "user");
  const message = items.find(i => i.kind === "message" && i.text.length > 1000);
  const consult = items.find(i => i.kind === "consult");
  assert.deepEqual(user?.clippedEventIds, [1]);
  assert.deepEqual(message?.clippedEventIds, [2]);
  assert.deepEqual(consult?.clippedEventIds, [3]);
  assert.equal(items.find(i => i.kind === "message" && i.text === "짧은 답")?.clippedEventIds, undefined);
  // Nothing shortened: the same array comes back (no re-render).
  const plain = buildItems([at(6, { type: "text", text: "a" })], undefined, false);
  assert.equal(markClipped(plain, [at(6, { type: "text", text: "a" })]), plain);
  assert.equal(eventText({ type: "consult_start", consultId: 1, kind: "review", from: "orch", to: "w1", request: "요청 원문", attachments: [] }), "요청 원문");
});

test("a long checklist (300 steps, long titles) keeps its first 200 steps and says 100 are omitted, in pages and in the snapshot", () => {
  const plan: AgentEvent = { type: "plan_update", steps: Array.from({ length: 300 }, (_, k) => ({ title: `${k}번 단계 ${"가".repeat(300)}`, status: "pending" as const })), planId: 3 };
  const at = (id: number, event: AgentEvent, role: TimelineEvent["role"] = "orch"): TimelineEvent => ({ id, chatId: 1, node: "orch", role, at: id, event });
  // As an event of a page.
  const sent = pageEvent(at(2, plan));
  assert.ok(sent.clipped && sent.event.type === "plan_update");
  if (sent.event.type !== "plan_update") return;
  assert.equal(sent.event.steps.length, SNAPSHOT_LIMITS.planSteps);
  assert.equal(sent.event.stepsTotal, 300);
  assert.ok(sent.event.steps.every((s, k) => s.title.startsWith(`${k}번 단계`) && s.title.length <= 251));
  // In the snapshot of older history.
  const all = [at(1, { type: "user", text: "/plan 긴 계획", attachments: [] }, null), at(2, plan), at(3, { type: "plan_state", state: "running", planId: 3 } as AgentEvent)];
  const minimal = all.flatMap(e => { const m = minimalContextEvent(e); return m ? [m] : []; });
  const { snapshot, context } = reduceContext(minimal);
  assert.equal(snapshot.plan.view?.steps.length, SNAPSHOT_LIMITS.planSteps);
  assert.equal(snapshot.plan.stepsOmitted, 100);
  const state = stateEvents({ events: [], context, snapshot, snapshotAt: 10 });
  assert.equal(planOf(state)?.steps.length, SNAPSHOT_LIMITS.planSteps);
  const last = state.findLast(e => e.event.type === "plan_update");
  assert.equal(last?.event.type === "plan_update" && last.event.stepsTotal, 300, "the view can say how many were left out");
  // A short plan is sent as it is.
  const small: AgentEvent = { type: "plan_update", steps: [{ title: "하나", status: "pending" }], planId: 1 };
  assert.equal(pageEvent(at(4, small)).event, small);
});

test("older unanswered approvals drop what was answered since; the core count includes later answers", () => {
  const list = { items: [{ id: "a" }, { id: "b" }, { id: "c" }], total: 70 };
  assert.deepEqual(withoutAnswered(list, new Set(["b", "zz"])), { items: [{ id: "a" }, { id: "c" }], total: 69 });
  assert.equal(withoutAnswered(list, new Set()), list);
  withStore((store, chatId) => {
    for (let i = 0; i < 5; i++) store.addEvent(chatId, "w1", "w1", { type: "approval_request", request: { id: `r${i}`, role: "w1", title: `승인 ${i}`, detail: "", risk: "low" } });
    const before = store.addEvent(chatId, "orch", "orch", { type: "text", text: "경계" }).id;
    assert.equal(store.pendingApprovals(chatId, before).total, 5);
    // Answered after the page boundary (e.g. from another view): no longer pending.
    store.addEvent(chatId, "w1", "w1", { type: "approval_resolved", id: "r2", decision: "deny" });
    const after = store.pendingApprovals(chatId, before);
    assert.equal(after.total, 4);
    assert.ok(!after.items.some(a => a.id === "r2"));
  });
});

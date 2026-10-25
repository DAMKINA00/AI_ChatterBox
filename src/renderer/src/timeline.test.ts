// Run: node --test src/renderer/src/timeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, NodeId, Role, TimelineEvent } from "../../shared/types";
import { apply, buildItems, createTimelineBuilder, createTimelineCache, currentExpression, latestExpression, normalizePlanStepTitle } from "./timeline.ts";

let nextId = 1;
function event(node: NodeId, role: Role | null, payload: AgentEvent): TimelineEvent {
  const id = nextId++;
  return { id, chatId: 1, node, role, at: id, event: payload };
}

function liveEvent(node: NodeId, role: Role | null, payload: AgentEvent, at: number): TimelineEvent {
  return { id: 0, chatId: 1, node, role, at, event: payload };
}

const emptyAttachments = [];

test("chat timeline cache survives switches, isolates views, and applies background updates", () => {
  const cache = createTimelineCache();
  const a = [event("orch", "orch", { type: "text_delta", text: "draft" })];
  const b = [event("orch", "orch", { type: "text", text: "other chat" })];
  const first = cache.build(1, a, undefined, true);
  cache.build(2, b, undefined, false);
  cache.build(1, a, "orch", true);
  assert.equal(cache.build(1, a, undefined, true), first);
  const updated = [...a, event("orch", "orch", { type: "text", text: "final" }), event("orch", "orch", { type: "turn_end", ok: true })];
  assert.deepEqual(cache.build(1, updated, undefined, false), buildItems(updated, undefined, false));
  assert.equal(first[0].text, "draft");
  cache.delete(1);
  assert.notEqual(cache.build(1, a, undefined, true), first);
});

test("chat timeline cache evicts the least recently visited view", () => {
  const cache = createTimelineCache(2);
  const events = [event("orch", "orch", { type: "text", text: "history" })];
  const first = cache.build(1, events, undefined, false);
  const second = cache.build(2, events, undefined, false);
  assert.equal(cache.build(1, events, undefined, false), first);
  cache.build(3, events, undefined, false);
  assert.equal(cache.build(1, events, undefined, false), first);
  assert.notEqual(cache.build(2, events, undefined, false), second);
});

test("plan step display normalizes only legacy Gemini worker prefixes", () => {
  assert.equal(normalizePlanStepTitle("[Antigravity 1호] 멕시코 조사"), "[제미나이 1호] 멕시코 조사");
  assert.equal(normalizePlanStepTitle("[Gemini 2호] 초안 작성"), "[제미나이 2호] 초안 작성");
  assert.equal(normalizePlanStepTitle("[Antigravity 연구 담당] CLI 확인"), "[Antigravity 연구 담당] CLI 확인");
  assert.equal(normalizePlanStepTitle("설정에서 Antigravity 1호 CLI 확인"), "설정에서 Antigravity 1호 CLI 확인");
});

test("direct collaboration messages appear in sender and recipient views", () => {
  const events = [event("consult:2", "w1", { type: "peer_message", from: "w1", to: "w2", text: "resultId contract" })];
  for (const view of ["w1", "w2", "consult:2"] as const) {
    const items = buildItems(events, view);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { kind: "peer", key: `e${events[0].id}`, from: "w1", to: "w2", text: "resultId contract" });
  }
  assert.equal(buildItems(events, "w3").length, 0);
});

test("master conversation relays worker approvals and resolutions while preserving original request roles", () => {
  const events = [
    event("consult:1", "w1", { type: "approval_request", request: { id: "a1", role: "w1", title: "Write", detail: "one", risk: "low" } }),
    event("consult:2", "w2", { type: "approval_request", request: { id: "a2", role: "w2", title: "PowerShell", detail: "two", risk: "high" } }),
    event("consult:1", "w1", { type: "approval_resolved", id: "a1", decision: "once" }),
  ];
  for (const view of [undefined, "orch"] as const) {
    const items = buildItems(events, view, true).filter((item) => item.kind === "approval");
    assert.deepEqual(items.map((item) => [item.request.role, item.request.id, item.decision]), [["w1", "a1", "once"], ["w2", "a2", undefined]]);
  }
  assert.equal(buildItems(events, "w1", true).filter((item) => item.kind === "approval").length, 1);
});

test("expression metadata stays attached to the next message for parallel consult roles", () => {
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 1, kind: "implement", from: "orch", to: "w1", request: "one", attachments: emptyAttachments }),
    event("orch", "orch", { type: "consult_start", consultId: 2, kind: "review", from: "orch", to: "w2", request: "two", attachments: emptyAttachments }),
    event("consult:1", "w1", { type: "expression", expression: "happy" }),
    event("consult:2", "w2", { type: "expression", expression: "worried" }),
    event("consult:1", "w1", { type: "text", text: "worker one" }),
    event("consult:2", "w2", { type: "text", text: "worker two" }),
  ];
  const items = buildItems(events, undefined, false);
  const one = items.find((x) => x.kind === "consult" && x.consultId === 1)!;
  const two = items.find((x) => x.kind === "consult" && x.consultId === 2)!;
  assert.equal(one.kind, "consult");
  assert.equal(two.kind, "consult");
  assert.equal(one.children.find((x) => x.kind === "message")?.expression, "happy");
  assert.equal(two.children.find((x) => x.kind === "message")?.expression, "worried");
});

test("nested consult dialogue remains inside its parent card", () => {
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 10, kind: "implement", from: "orch", to: "w1", request: "parent", attachments: emptyAttachments }),
    event("consult:10", "w1", { type: "consult_start", consultId: 11, kind: "review", from: "w1", to: "w2", request: "nested", attachments: emptyAttachments }),
    event("consult:11", "w2", { type: "expression", expression: "happy" }),
    event("consult:11", "w2", { type: "text", text: "nested answer" }),
  ];
  const parent = buildItems(events, undefined, false).find((x) => x.kind === "consult" && x.consultId === 10)!;
  assert.equal(parent.kind, "consult");
  const nested = parent.children.find((x) => x.kind === "consult" && x.consultId === 11)!;
  assert.equal(nested.kind, "consult");
  assert.equal(nested.children.find((x) => x.kind === "message")?.expression, "happy");
});

test("indexed consult updates preserve duplicate-id and missing-parent history behavior", () => {
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 1, kind: "implement", from: "orch", to: "w1", request: "first", attachments: [] }),
    event("orch", "orch", { type: "text", text: "separate top-level message" }),
    event("orch", "orch", { type: "consult_start", consultId: 1, kind: "implement", from: "orch", to: "w1", request: "duplicate", attachments: [] }),
    event("consult:1", "w1", { type: "text", text: "both legacy cards" }),
    event("consult:999", "w2", { type: "text", text: "missing parent" }),
  ];
  const items = buildItems(events, undefined, false);
  assert.equal(items.length, 3);
  const cards = items.filter(item => item.kind === "consult");
  assert.deepEqual(cards.map(card => card.children.map(child => child.kind === "message" ? child.text : "")), [["both legacy cards"], ["both legacy cards"]]);
});

test("invalid expressions and old history use safe defaults; turn completion closes streams", () => {
  const events: TimelineEvent[] = [
    event("w1", "w1", { type: "expression", expression: "made-up" as never }),
    event("w1", "w1", { type: "text", text: "old" }),
    event("w1", "w1", { type: "expression", expression: "confident" }),
    event("w1", "w1", { type: "text_delta", text: "live" }),
    event("w1", "w1", { type: "turn_end", ok: true }),
    event("w1", "w1", { type: "text", text: "next turn" }),
  ];
  const items = buildItems(events, "w1", true).filter((x) => x.kind === "message");
  assert.deepEqual(
    items.map((x) => [x.text, x.expression, x.streaming]),
    [
      ["old", "neutral", false],
      ["live", "confident", false],
      ["next turn", "neutral", false],
    ],
  );
  assert.equal(currentExpression("unknown"), "neutral");
  assert.equal(currentExpression("happy"), "happy");
});

test("streaming without expression is speaking and expression helper tool noise is hidden", () => {
  const events: TimelineEvent[] = [
    event("w1", "w1", { type: "text_delta", text: "stream" }),
    event("w1", "w1", { type: "tool_call", id: "e1", name: "set_expression", input: "{}" }),
    event("w1", "w1", { type: "tool_call", id: "e2", name: "mcp__chatterbox_bridge__set_expression", input: "{}" }),
  ];
  const items = buildItems(events, "w1", true);
  assert.equal(items.filter((x) => x.kind === "message").at(0)?.expression, "speaking");
  assert.equal(items.some((x) => x.kind === "tool"), false);
});

test("interleaved role deltas update their own open message in place", () => {
  const first = event("w1", "w1", { type: "text_delta", text: "one" });
  const second = event("w2", "w2", { type: "text_delta", text: "two" });
  const continuation = event("w1", "w1", { type: "text_delta", text: " again" });
  const items = apply(apply(apply([], first), second), continuation);
  assert.deepEqual(
    items.filter((x) => x.kind === "message").map((x) => [x.role, x.text, x.streaming]),
    [
      ["w1", "one again", true],
      ["w2", "two", true],
    ],
  );
});

test("agent usage snapshots do not close a live message", () => {
  const items = buildItems(
    [
      liveEvent("w1", "w1", { type: "text_delta", text: "still writing" }, 1),
      liveEvent(
        "w1",
        "w1",
        { type: "agent_usage", metrics: { turnId: "turn-1", inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, elapsedMs: 1000 } },
        2,
      ),
    ],
    "w1",
    true,
  );
  assert.deepEqual(items.filter((x) => x.kind === "message").map((x) => [x.text, x.streaming]), [["still writing", true]]);
});

test("nested bridge events close a stream and history closes nested items", () => {
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 20, kind: "implement", from: "orch", to: "w1", request: "parent", attachments: emptyAttachments }),
    event("consult:20", "w1", { type: "consult_start", consultId: 21, kind: "review", from: "w1", to: "w2", request: "nested", attachments: emptyAttachments }),
    event("consult:21", "w2", { type: "text_delta", text: "first" }),
    event("consult:21", "w2", { type: "tool_call", id: "bridge", name: "mcp__chatterbox_bridge__set_expression", input: "{}" }),
    event("consult:21", "w2", { type: "text_delta", text: "second" }),
    event("consult:21", "w2", {
      type: "approval_request",
      request: { id: "nested-approval", role: "w2", title: "명령 실행", detail: "echo", risk: "low" },
    }),
  ];
  const parent = buildItems(events, undefined, false).find((x) => x.kind === "consult" && x.consultId === 20)!;
  assert.equal(parent.kind, "consult");
  const nested = parent.children.find((x) => x.kind === "consult" && x.consultId === 21)!;
  assert.equal(nested.kind, "consult");
  const messages = nested.children.filter((x) => x.kind === "message");
  assert.deepEqual(messages.map((x) => [x.text, x.streaming]), [["first", false], ["second", false]]);
  assert.equal(buildItems(events, undefined, false).find((x) => x.kind === "approval")?.decision, "expired");
});

test("explicit expression persists while a stream speaks and resets at turn end", () => {
  const events: TimelineEvent[] = [
    event("w1", "w1", { type: "expression", expression: "surprised" }),
    event("w1", "w1", { type: "text_delta", text: "hello" }),
    event("w1", "w1", { type: "text_delta", text: " world" }),
  ];
  assert.equal(latestExpression(events, "w1"), "surprised");
  assert.equal(latestExpression([...events, event("w1", "w1", { type: "turn_end", ok: true })], "w1"), "neutral");
  const message = buildItems(events, "w1", true).find((x) => x.kind === "message");
  assert.equal(message?.expression, "surprised");
});

test("live stream keys stay unique after an expression tool closes a stream", () => {
  const events: TimelineEvent[] = [
    liveEvent("w1", "w1", { type: "text_delta", text: "first" }, 1),
    event("w1", "w1", { type: "tool_call", id: "expression-1", name: "mcp__chatterbox_bridge__set_expression", input: "{}" }),
    liveEvent("w1", "w1", { type: "text_delta", text: "second" }, 3),
  ];
  const messages = buildItems(events, "w1", true).filter((x) => x.kind === "message");
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].key, messages[1].key);
  assert.deepEqual(messages.map((x) => [x.text, x.streaming]), [["first", false], ["second", true]]);
});

test("live stream keys stay unique after an interrupted turn restarts", () => {
  const events: TimelineEvent[] = [
    liveEvent("w1", "w1", { type: "text_delta", text: "partial" }, 10),
    event("w1", "w1", { type: "turn_end", ok: false, interrupted: true }),
    liveEvent("w1", "w1", { type: "text_delta", text: "next" }, 12),
  ];
  const messages = buildItems(events, "w1", true).filter((x) => x.kind === "message");
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].key, messages[1].key);
  assert.deepEqual(messages.map((x) => [x.text, x.streaming]), [["partial", false], ["next", true]]);
});

test("image status events upsert by role, node, and generation id when replayed", () => {
  const output = { id: 901, name: "result.png", mime: "image/png", size: 12, path: "C:/result.png" };
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 31, kind: "implement", from: "orch", to: "w1", request: "first", attachments: emptyAttachments }),
    event("orch", "orch", { type: "consult_start", consultId: 32, kind: "implement", from: "orch", to: "w2", request: "second", attachments: emptyAttachments }),
    event("orch", "orch", { type: "consult_start", consultId: 33, kind: "implement", from: "orch", to: "w1", request: "third", attachments: emptyAttachments }),
    event("consult:31", "w1", { type: "image_generation", id: "same-job", status: "running", prompt: "first image" }),
    event("consult:32", "w2", { type: "image_generation", id: "same-job", status: "running", prompt: "second image" }),
    event("consult:33", "w1", { type: "image_generation", id: "same-job", status: "running", prompt: "third image" }),
    event("consult:31", "w1", { type: "image_generation", id: "same-job", status: "done", attachment: output }),
    event("consult:32", "w2", { type: "image_generation", id: "same-job", status: "error", error: "provider failed" }),
  ];

  const replayed = buildItems(events, undefined, false);
  const first = replayed.find((x) => x.kind === "consult" && x.consultId === 31)!;
  const second = replayed.find((x) => x.kind === "consult" && x.consultId === 32)!;
  const third = replayed.find((x) => x.kind === "consult" && x.consultId === 33)!;
  assert.equal(first.kind, "consult");
  assert.equal(second.kind, "consult");
  assert.equal(third.kind, "consult");
  const firstImages = first.children.filter((x) => x.kind === "image");
  const secondImages = second.children.filter((x) => x.kind === "image");
  const thirdImages = third.children.filter((x) => x.kind === "image");
  assert.equal(firstImages.length, 1);
  assert.equal(secondImages.length, 1);
  assert.equal(thirdImages.length, 1);
  assert.deepEqual([firstImages[0].role, firstImages[0].node, firstImages[0].status], ["w1", "consult:31", "done"]);
  assert.equal(firstImages[0].attachment?.id, output.id);
  assert.deepEqual([secondImages[0].role, secondImages[0].node, secondImages[0].status], ["w2", "consult:32", "error"]);
  assert.equal(secondImages[0].error, "provider failed");
  assert.deepEqual([thirdImages[0].role, thirdImages[0].node, thirdImages[0].status], ["w1", "consult:33", "running"]);

  const liveImages = buildItems(
    [
      liveEvent("w1", "w1", { type: "image_generation", id: "live-one", status: "running" }, 1),
      liveEvent("w1", "w1", { type: "image_generation", id: "live-two", status: "running" }, 2),
      liveEvent("w1", "w1", { type: "image_generation", id: "live-one", status: "done", attachment: output }, 3),
    ],
    "w1",
    true,
  ).filter((x) => x.kind === "image");
  assert.equal(liveImages.length, 2);
  assert.notEqual(liveImages[0].key, liveImages[1].key);
  assert.deepEqual(liveImages.map((x) => [x.id, x.status]), [["live-one", "done"], ["live-two", "running"]]);
});

test("consult reasons and summaries stay with their own worker and request", () => {
  const events: TimelineEvent[] = [
    event("orch", "orch", { type: "consult_start", consultId: 40, kind: "implement", from: "orch", to: "w1", request: "implement the parser", attachments: emptyAttachments, reason: "Claude has the code context" }),
    event("orch", "orch", { type: "consult_start", consultId: 41, kind: "review", from: "orch", to: "w2", request: "review the parser", attachments: emptyAttachments, reason: "GPT can independently review it" }),
    event("consult:40", "w1", { type: "text", text: "parser implementation" }),
    event("consult:41", "w2", { type: "text", text: "parser review" }),
    event("orch", "orch", { type: "consult_end", consultId: 40, status: "done", summary: "parser implemented", files: ["parser.ts"] }),
    event("orch", "orch", { type: "consult_end", consultId: 41, status: "done", summary: "review complete", files: [] }),
  ];
  const items = buildItems(events, undefined, false);
  const first = items.find((x) => x.kind === "consult" && x.consultId === 40)!;
  const second = items.find((x) => x.kind === "consult" && x.consultId === 41)!;
  assert.equal(first.kind, "consult");
  assert.equal(second.kind, "consult");
  assert.deepEqual([first.request, first.reason, first.summary], ["implement the parser", "Claude has the code context", "parser implemented"]);
  assert.deepEqual([second.request, second.reason, second.summary], ["review the parser", "GPT can independently review it", "review complete"]);
  assert.deepEqual(first.children.filter((x) => x.kind === "message").map((x) => [x.role, x.text]), [["w1", "parser implementation"]]);
  assert.deepEqual(second.children.filter((x) => x.kind === "message").map((x) => [x.role, x.text]), [["w2", "parser review"]]);
});

test("dispatch decisions appear as readable timeline notices", () => {
  const items = buildItems([event("orch", "orch", { type: "dispatch", instructionId: 4, mode: "delegated", reason: "image creation needs the image tool" })], undefined, false);
  assert.deepEqual(items.filter((x) => x.kind === "notice").map((x) => x.text), ["마스터가 작업을 나눕니다 · image creation needs the image tool"]);
});

test("critical routing explains that both families investigate without changing legacy notices", () => {
  const items = buildItems([event("orch", "orch", { type: "dispatch", instructionId: 5, mode: "delegated", reason: "safety impact", dualInvestigation: true })], undefined, false);
  assert.ok(items.some((x) => x.kind === "notice" && x.text.includes("클로드와 지피티") && x.text.includes("safety impact")));
});

function expectBuilderOracle(builder: ReturnType<typeof createTimelineBuilder>, events: TimelineEvent[], view: NodeId | undefined, live: boolean) {
  const actual = builder(events, view, live);
  assert.deepEqual(actual, buildItems(events, view, live));
  return actual;
}

function builderFixture(): TimelineEvent[] {
  return [
    event("orch", "orch", { type: "consult_start", consultId: 501, kind: "implement", from: "orch", to: "w1", request: "parent", attachments: emptyAttachments }),
    event("consult:501", "w1", { type: "expression", expression: "happy" }),
    event("consult:501", "w1", { type: "consult_start", consultId: 502, kind: "review", from: "w1", to: "w2", request: "nested", attachments: emptyAttachments }),
    event("consult:502", "w2", { type: "expression", expression: "worried" }),
    event("consult:502", "w2", { type: "text", text: "nested answer" }),
    event("consult:502", "w2", { type: "approval_request", request: { id: "nested-approval", role: "w2", title: "명령 실행", detail: "echo nested", risk: "low" } }),
    event("consult:502", "w2", { type: "approval_resolved", id: "nested-approval", decision: "once" }),
    event("consult:501", "w1", { type: "text_delta", text: "parent answer" }),
    event("orch", "orch", { type: "consult_start", consultId: 503, kind: "opinion", from: "orch", to: "w2", request: "parallel", attachments: emptyAttachments }),
    event("consult:503", "w2", { type: "expression", expression: "confident" }),
    event("consult:503", "w2", { type: "text_delta", text: "worker two" }),
    event("consult:501", "w1", { type: "tool_call", id: "parent-tool", name: "read_file", input: "{}" }),
    event("consult:501", "w1", { type: "tool_result", id: "parent-tool", ok: true, output: "contents" }),
    event("consult:501", "w1", { type: "consult_end", consultId: 502, status: "done", summary: "nested complete", files: [] }),
    event("orch", "orch", { type: "consult_end", consultId: 501, status: "done", summary: "parent complete", files: ["parent.ts"] }),
    event("orch", "orch", { type: "consult_end", consultId: 503, status: "done", summary: "parallel complete", files: [] }),
    event("orch", "orch", { type: "approval_request", request: { id: "top-approval", role: "orch", title: "Write", detail: "parent.ts", risk: "high" } }),
    event("orch", "orch", { type: "approval_resolved", id: "top-approval", decision: "deny" }),
  ];
}

test("timeline builder matches the oracle and preserves unchanged item identity on append", () => {
  const builder = createTimelineBuilder();
  const base = [event("w1", "w1", { type: "text", text: "stable" })];
  const before = expectBuilderOracle(builder, base, "w1", true);

  const appended = [...base, event("w1", "w1", { type: "text_delta", text: "tail" })];
  const afterAppend = expectBuilderOracle(builder, appended, "w1", true);
  assert.strictEqual(afterAppend[0], before[0]);

  const replaced = [...appended.slice(0, -1), event("w1", "w1", { type: "text_delta", text: "replacement" })];
  const afterReplace = expectBuilderOracle(builder, replaced, "w1", true);
  assert.notStrictEqual(afterReplace[1], afterAppend[1]);
  assert.equal(afterReplace[1].kind, "message");
  if (afterReplace[1].kind === "message") assert.equal(afterReplace[1].text, "replacement");
});

test("timeline builder handles interleaved worker replacement and removal, nested metadata, decisions, and view changes", () => {
  const events = builderFixture();
  const builder = createTimelineBuilder();
  const all = expectBuilderOracle(builder, events, undefined, true);
  const parent = all.find((item) => item.kind === "consult" && item.consultId === 501)!;
  assert.equal(parent.kind, "consult");
  const nested = parent.children.find((item) => item.kind === "consult" && item.consultId === 502)!;
  assert.equal(nested.kind, "consult");
  assert.equal(nested.children.find((item) => item.kind === "message")?.expression, "worried");
  assert.equal(all.find((item) => item.kind === "approval" && item.request.id === "nested-approval")?.decision, "once");
  assert.equal(all.find((item) => item.kind === "approval" && item.request.id === "top-approval")?.decision, "deny");

  const replaced = [...events.slice(0, 4), event("consult:502", "w2", { type: "text", text: "nested replacement" }), ...events.slice(5)];
  const afterReplace = expectBuilderOracle(builder, replaced, undefined, true);
  const replacedParent = afterReplace.find((item) => item.kind === "consult" && item.consultId === 501)!;
  assert.equal(replacedParent.kind, "consult");
  const replacedNested = replacedParent.children.find((item) => item.kind === "consult" && item.consultId === 502)!;
  assert.equal(replacedNested.kind, "consult");
  assert.equal(replacedNested.children.find((item) => item.kind === "message")?.text, "nested replacement");

  const removed = replaced.filter((_, index) => index !== 5);
  const afterRemoval = expectBuilderOracle(builder, removed, undefined, true);
  const removedParent = afterRemoval.find((item) => item.kind === "consult" && item.consultId === 501)!;
  assert.equal(removedParent.kind, "consult");
  const removedNested = removedParent.children.find((item) => item.kind === "consult" && item.consultId === 502)!;
  assert.equal(removedNested.kind, "consult");
  assert.equal(afterRemoval.some((item) => item.kind === "approval" && item.request.id === "nested-approval"), false);

  const workerView = expectBuilderOracle(builder, events, "w1", true);
  assert.equal(workerView.find((item) => item.kind === "message")?.expression, "happy");
  expectBuilderOracle(builder, events, "consult:502", true);
  expectBuilderOracle(builder, events, undefined, true);
});

test("timeline builder invalidates truncated and reset histories", () => {
  const events = builderFixture();
  const builder = createTimelineBuilder();
  expectBuilderOracle(builder, events, undefined, false);
  const truncated = events.slice(0, 11);
  const truncatedItems = expectBuilderOracle(builder, truncated, undefined, false);
  assert.equal(truncatedItems.some((item) => item.kind === "notice" && item.text.includes("stale")), false);

  const reset = [event("w2", "w2", { type: "text", text: "fresh history" })];
  const resetItems = expectBuilderOracle(builder, reset, "w2", false);
  assert.deepEqual(resetItems.map((item) => item.kind), ["message"]);
  const empty = expectBuilderOracle(builder, [], undefined, false);
  assert.deepEqual(empty, []);
});

test("toggling historical mode closes prompts and streams without corrupting the live fold", () => {
  const events: TimelineEvent[] = [
    event("w1", "w1", { type: "expression", expression: "surprised" }),
    event("w1", "w1", { type: "text_delta", text: "partial" }),
    event("orch", "orch", { type: "approval_request", request: { id: "history-approval", role: "orch", title: "Write", detail: "file.ts", risk: "low" } }),
  ];
  const builder = createTimelineBuilder();
  const live = expectBuilderOracle(builder, events, undefined, true);
  const historical = expectBuilderOracle(builder, events, undefined, false);
  assert.equal(historical.find((item) => item.kind === "message")?.streaming, false);
  assert.equal(historical.find((item) => item.kind === "approval")?.decision, "expired");
  const liveAgain = expectBuilderOracle(builder, events, undefined, true);
  assert.equal(liveAgain.find((item) => item.kind === "message")?.streaming, true);
  assert.equal(liveAgain.find((item) => item.kind === "approval")?.decision, undefined);
  assert.equal(live.find((item) => item.kind === "message")?.expression, "surprised");
});

function largeTimelineFixture(): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (let consultIndex = 0; consultIndex < 100; consultIndex++) {
    const consultId = 10000 + consultIndex;
    const role = `w${(consultIndex % 3) + 1}` as Role;
    const node = `consult:${consultId}` as NodeId;
    events.push(event("orch", "orch", { type: "consult_start", consultId, kind: "implement", from: "orch", to: role, request: `task ${consultIndex}`, attachments: emptyAttachments }));
    for (let toolIndex = 0; toolIndex < 42; toolIndex++) {
      const toolId = `large-${consultIndex}-${toolIndex}`;
      events.push(event(node, role, { type: "tool_call", id: toolId, name: "worker_tool", input: `{"index":${toolIndex}}` }));
      events.push(event(node, role, { type: "tool_result", id: toolId, ok: true, output: `result-${toolIndex}` }));
    }
    events.push(event(node, role, { type: "text", text: `completed-${consultIndex}` }));
  }
  return events;
}

test("timeline builder reuses the unchanged prefix for a large append", () => {
  const events = largeTimelineFixture();
  assert.equal(events.length, 8600);
  const builder = createTimelineBuilder();
  const before = expectBuilderOracle(builder, events, undefined, true);
  const appended = [...events, event("consult:10099", "w1", { type: "text_delta", text: " final token" })];
  const after = expectBuilderOracle(builder, appended, undefined, true);
  assert.strictEqual(after[0], before[0]);
  if (before[0].kind === "consult" && after[0].kind === "consult") {
    assert.strictEqual(after[0].children[0], before[0].children[0]);
  }

  const earlyReplacement = [
    ...events.slice(0, 85),
    event("consult:10000", "w1", { type: "text", text: "changed early completion" }),
    ...events.slice(86),
  ];
  expectBuilderOracle(builder, earlyReplacement, undefined, true);
});

// Run: node --test src/renderer/src/timeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, NodeId, Role, TimelineEvent } from "../../shared/types";
import { apply, buildItems, currentExpression, latestExpression } from "./timeline.ts";

let nextId = 1;
function event(node: NodeId, role: Role | null, payload: AgentEvent): TimelineEvent {
  const id = nextId++;
  return { id, chatId: 1, node, role, at: id, event: payload };
}

function liveEvent(node: NodeId, role: Role | null, payload: AgentEvent, at: number): TimelineEvent {
  return { id: 0, chatId: 1, node, role, at, event: payload };
}

const emptyAttachments = [];

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

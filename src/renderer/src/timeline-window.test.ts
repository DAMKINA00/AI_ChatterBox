import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "./timeline";
import { needsAttention, windowItems } from "./timeline-window";

const message = (key: string): Item => ({ kind: "message", key, role: "orch", node: "orch", text: key, streaming: false, expression: "neutral", at: 1 });

test("history window keeps active work and unanswered requests without duplicating the tail", () => {
  const pending: Item = { kind: "approval", key: "approval", request: { id: "a", role: "orch", title: "confirm", detail: "detail", risk: "low" } };
  const ask: Item = { kind: "ask", key: "ask", id: "q", question: "question", options: [] };
  const running: Item = { ...message("stream"), streaming: true } as Item;
  const tool: Item = { kind: "tool", key: "tool", role: "orch", id: "t", name: "Read", input: "" };
  const items = [message("old"), pending, ask, running, tool, message("recent")];
  const result = windowItems(items, 5, true);
  assert.deepEqual(result.visible, [pending, ask, running, tool, items[5]]);
  assert.equal(result.hidden, 1);
  assert.deepEqual(windowItems(items, 5, false).visible, [pending, ask, items[5]]);
  assert.equal(needsAttention({ ...pending, decision: "once" }, true), false);
  assert.equal(needsAttention({ ...ask, answer: "" }, true), false);
  assert.deepEqual(windowItems(items, 0, true).visible, items);
});

test("nested running work stays reachable and all older history can be revealed", () => {
  const child: Item = { kind: "consult", key: "child", consultId: 2, from: "w1", to: "w2", consultKind: "review", request: "review", attachments: [], status: "running", children: [], at: 1 };
  const parent: Item = { ...child, key: "parent", consultId: 1, status: "done", children: [child] };
  const items = [parent, ...Array.from({ length: 205 }, (_, i) => message(String(i)))];
  assert.equal(windowItems(items, 106, true).visible[0], parent);
  assert.equal(windowItems(items, 106, true).visible.length, 101);
  assert.equal(windowItems(items, 106, false).visible.length, 100);
  assert.deepEqual(windowItems(items, 0, false).visible, items);
});

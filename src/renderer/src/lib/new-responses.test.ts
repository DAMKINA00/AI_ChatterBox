import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeId, Role, TimelineEvent } from "../../../shared/types";
import { appendEvent, createTimelineBuilder, type Item } from "../timeline";
import { seenReplies, statusAnnouncement, unseenLabel, unseenReplies } from "./new-responses";

const ev = (id: number, event: TimelineEvent["event"], node: NodeId = "orch", role: Role = "orch"): TimelineEvent => ({ id, chatId: 1, node, role, at: id || Date.now(), event });

/** The store's path: every incoming event goes through appendEvent, the view through the incremental builder. */
function chat(initial: TimelineEvent[] = [], view?: NodeId) {
  const build = createTimelineBuilder();
  let events = initial;
  return {
    receive(...list: TimelineEvent[]) { for (const e of list) events = appendEvent(events, e); return this; },
    items: (): Item[] => build(events, view, true),
  };
}

test("a reply read while streaming is not new once it is saved, and a longer final text reads as continued", () => {
  const c = chat([ev(1, { type: "user", text: "지시", attachments: [] })]).receive(ev(0, { type: "text_delta", text: "같은 응답" }));
  const seen = seenReplies(c.items());
  c.receive(ev(2, { type: "text", text: "같은 응답" }));
  assert.deepEqual(unseenReplies(c.items(), seen), { count: 0, growing: false }, "live preview replaced by the saved message");

  const d = chat().receive(ev(0, { type: "text_delta", text: "앞부분" }));
  const seenMid = seenReplies(d.items());
  d.receive(ev(0, { type: "text_delta", text: " 뒷부분" }), ev(3, { type: "text", text: "앞부분 뒷부분" }), ev(4, { type: "turn_end", ok: true }));
  assert.deepEqual(unseenReplies(d.items(), seenMid), { count: 0, growing: true });
  assert.equal(unseenLabel(unseenReplies(d.items(), seenMid)), "새 응답");
});

test("tokens and replayed events count a reply once; a really new reply after it still counts", () => {
  const c = chat([ev(1, { type: "text", text: "읽음" })]);
  const seen = seenReplies(c.items());
  c.receive(ev(0, { type: "text_delta", text: "새 " }), ev(0, { type: "text_delta", text: "응답" }));
  assert.equal(unseenReplies(c.items(), seen).count, 1, "many tokens, one reply");
  const reply = ev(2, { type: "text", text: "새 응답" });
  c.receive(reply, reply);
  assert.equal(unseenReplies(c.items(), seen).count, 1, "the same saved event twice");
  c.receive(ev(3, { type: "text", text: "둘째" }));
  assert.equal(unseenLabel(unseenReplies(c.items(), seen)), "새 응답 2");
  assert.equal(unseenReplies(c.items(), seenReplies(c.items())).count, 0, "nothing is new at the bottom");
});

test("workers' replies inside consult cards of the unified view count, and finishing them does not count again", () => {
  const c = chat([ev(1, { type: "consult_start", consultId: 7, kind: "implement", from: "orch", to: "w1", request: "작업", attachments: [], scope: [], instructionId: 1, reason: "r" })]);
  const seen = seenReplies(c.items());
  c.receive(ev(0, { type: "text_delta", text: "작업자 응답" }, "consult:7", "w1"));
  assert.equal(unseenReplies(c.items(), seen).count, 1);
  const seenWorker = seenReplies(c.items());
  c.receive(ev(5, { type: "text", text: "작업자 응답" }, "consult:7", "w1"));
  assert.equal(unseenReplies(c.items(), seenWorker).count, 0);
});

test("status lines: only later changes; a stop is not reported as a success", () => {
  assert.equal(statusAnnouncement(undefined, "approval"), null, "opening a chat already waiting");
  assert.equal(statusAnnouncement("approval", "approval"), null, "a replayed update");
  assert.match(statusAnnouncement("working", "approval")!, /승인/);
  assert.match(statusAnnouncement("working", "done", { ok: true })!, /완료/);
  // chats.ts orchTurnEnded: interrupted -> idle, ok -> done, otherwise error.
  assert.match(statusAnnouncement("working", "idle", { ok: false, interrupted: true })!, /중단/);
  assert.doesNotMatch(statusAnnouncement("working", "idle", { ok: false, interrupted: true })!, /완료/);
  assert.doesNotMatch(statusAnnouncement("working", "idle")!, /완료/, "idle without evidence stays neutral");
  assert.match(statusAnnouncement("working", "error", { ok: false })!, /오류/);
  assert.equal(statusAnnouncement("idle", "working"), null, "starting is not announced");
  assert.equal(statusAnnouncement("error", "idle"), null, "dismissing an error is not an ending");
});

test("a streaming reply renders without highlighting and gets it back once it ends", async () => {
  // The unit bundler uses the classic JSX runtime for renderer imports.
  Object.assign(globalThis, { React, window: { chatterbox: {} }, localStorage: { getItem: () => null } });
  const { Markdown } = await import("../components/Markdown");
  const text = "설명\n\n```\nfunction add(a, b) {\n  return a + b;\n}\n```\n";
  const live = renderToStaticMarkup(createElement(Markdown, { text, streaming: true }));
  const ended = renderToStaticMarkup(createElement(Markdown, { text, streaming: false }));
  assert.match(live, /function add/);
  assert.doesNotMatch(live, /hljs/);
  assert.match(ended, /hljs/, "detected highlighting is unchanged after the reply ends");
  assert.equal(renderToStaticMarkup(createElement(Markdown, { text })), ended, "the default stays highlighted");

  // Ending by success, error or a stop all close the stream on the store's path.
  for (const terminal of [{ type: "turn_end", ok: true }, { type: "turn_end", ok: false, interrupted: true }, { type: "error", kind: "runtime", message: "x" }] as TimelineEvent["event"][]) {
    const c = chat().receive(ev(0, { type: "text_delta", text: "```\nconst a = 1;\n```" }), ev(9, terminal));
    assert.ok(c.items().filter((i) => i.kind === "message").every((i) => i.kind === "message" && !i.streaming), JSON.stringify(terminal));
  }
});

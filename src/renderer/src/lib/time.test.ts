import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, TimelineEvent } from "../../../shared/types";
import { formatElapsed, latestInstructionAt, timeAgo } from "./time.ts";

function event(at: number, payload: AgentEvent): TimelineEvent {
  return { id: at, chatId: 1, node: "orch", role: null, at, event: payload };
}

test("latestInstructionAt ignores queued messages and background events", () => {
  const events = [
    event(1_000, { type: "user", text: "first", attachments: [] }),
    event(2_000, { type: "user", text: "queued", attachments: [], queued: true, delivery: "next" }),
    event(3_000, { type: "text", text: "background" }),
    event(4_000, { type: "user", text: "current", attachments: [], delivery: "now" }),
  ];
  assert.equal(latestInstructionAt(events, 500), 4_000);
  assert.equal(latestInstructionAt([events[1]], 500), 500);
});

test("formatElapsed supports hours and clamps negative elapsed time", () => {
  assert.equal(formatElapsed(0), "0분 0초");
  assert.equal(formatElapsed(123_000), "2분 3초");
  assert.equal(formatElapsed(3_723_000), "1시간 2분 3초");
  assert.equal(formatElapsed(-1), "0분 0초");
});

test("timeAgo accepts a clock value and clamps future timestamps", () => {
  assert.equal(timeAgo(110_000, 100_000), "방금");
  assert.equal(timeAgo(40_000, 100_000), "1분 전");
  assert.equal(timeAgo(0, 86_400_000), "1일 전");
});

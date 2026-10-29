import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chat, Consult, TimelineEvent } from "../../../shared/types";
import { buildItems } from "../timeline";
import { withoutDeleted } from "./logic";
import { applyChatUpdate, applyMessage, mergeChats, mergeSnapshot, type StreamMessage } from "./stream";

const ev = (id: number, event: TimelineEvent["event"], chatId = 1): TimelineEvent => ({ id, chatId, node: "orch", role: "orch", at: id, event });
const approval = ev(12, { type: "approval_request", request: { id: "a1", role: "w1", title: "명령 실행", detail: "npm test", risk: "low" } });
const msg = (seq: number, channel: string, ...args: unknown[]): StreamMessage => ({ seq, channel, args });

test("an approval emitted after the snapshot was read but before it arrived is not lost", () => {
  // Snapshot started at seq 5 and was read before the approval (seq 7) was stored.
  const snapshot = { seq: 5, events: [ev(10, { type: "user", text: "작업", attachments: [] })], agents: [], consults: [] };
  const buffered = [msg(4, "chat:event", ev(9, { type: "text", text: "이전" })), msg(7, "chat:event", approval)];
  const merged = mergeSnapshot(snapshot, buffered, 1);
  assert.deepEqual(merged.events.map(e => e.id), [10, 12]);
});

const delta = (text: string): TimelineEvent => ({ id: 0, chatId: 1, node: "orch", role: "orch", at: 11, event: { type: "text_delta", text } });

test("events already in the snapshot are not duplicated; a preview the snapshot already finished is removed", () => {
  const final = ev(11, { type: "text", text: "작성 완료" });
  const snapshot = { seq: 5, events: [ev(10, { type: "user", text: "작업", attachments: [] }), final, approval], agents: [], consults: [] };
  const merged = mergeSnapshot(snapshot, [
    msg(6, "chat:event", delta("작성 ")), msg(7, "chat:event", final), msg(8, "chat:event", approval),
    msg(9, "chat:event", ev(13, { type: "approval_resolved", id: "a1", decision: "once" })),
  ], 1);
  assert.deepEqual(merged.events.map(e => [e.id, e.event.type]), [[10, "user"], [11, "text"], [12, "approval_request"], [13, "approval_resolved"]]);
});

test("a reply still being written keeps its beginning even if it started before the snapshot", () => {
  // Previews are never stored, so the snapshot cannot hold them; buffered ones are replayed whatever their seq.
  const snapshot = { seq: 5, events: [ev(10, { type: "user", text: "작업", attachments: [] })], agents: [], consults: [] };
  const merged = mergeSnapshot(snapshot, [msg(4, "chat:event", delta("앞부분 ")), msg(6, "chat:event", delta("뒷부분"))], 1);
  assert.deepEqual(merged.events.at(-1)?.event, { type: "text_delta", text: "앞부분 뒷부분" });
});

test("an older snapshot arriving late does not turn an approval-waiting chat back to idle; the approval stays answerable", () => {
  const chat = (status: Chat["status"]) => ({ id: 1, title: "작업", status } as Chat);
  const versions = new Map<number, number>();
  // chat:updated (seq 7) arrives first, then the snapshot read at seq 5 with the old status.
  let chats = applyChatUpdate([chat("working")], versions, chat("approval"), 7);
  chats = mergeChats(chats, versions, [chat("idle")], 5, true);
  assert.equal(chats[0].status, "approval");
  chats = mergeChats(chats, versions, [chat("idle")], 5);
  assert.equal(chats[0].status, "approval");
  // A stale message cannot undo a newer one either, and a later snapshot does apply.
  assert.equal(applyChatUpdate(chats, versions, chat("working"), 6)[0].status, "approval");
  assert.equal(mergeChats(chats, versions, [chat("idle")], 9)[0].status, "idle");
  // The page shows approve/deny buttons for an undecided approval while the chat is live (working/approval).
  const detail = mergeSnapshot({ seq: 5, events: [], agents: [], consults: [] }, [msg(7, "chat:event", approval)], 1);
  const item = buildItems(detail.events, undefined, chats[0].status === "approval" || chats[0].status === "working").find(i => i.kind === "approval");
  assert.ok(item && item.kind === "approval" && !item.decision);
});

test("a chat created after the list snapshot started is kept", () => {
  const versions = new Map<number, number>();
  const created = { id: 2, title: "새 채팅", status: "idle" } as Chat;
  const chats = mergeChats(applyChatUpdate([], versions, created, 8), versions, [{ id: 1, title: "기존", status: "idle" } as Chat], 5);
  assert.deepEqual(chats.map(c => c.id).sort(), [1, 2]);
});

test("worker and consult updates newer than the snapshot are replayed in order; other chats are ignored", () => {
  const consult = (status: Consult["status"]) => ({ id: 3, chatId: 1, status } as Consult);
  const snapshot = { seq: 2, events: [], agents: [], consults: [consult("running")] };
  const merged = mergeSnapshot(snapshot, [
    msg(3, "consult:updated", consult("done")),
    msg(4, "agents:updated", 1, [{ id: 1, nickname: "클로드 1호" }]),
    msg(5, "agents:updated", 2, [{ id: 9, nickname: "다른 채팅" }]),
    msg(6, "chat:event", ev(20, { type: "text", text: "다른 채팅" }, 2)),
  ], 1);
  assert.equal(merged.consults[0].status, "done");
  assert.deepEqual(merged.agents.map(a => a.nickname), ["클로드 1호"]);
  assert.equal(merged.events.length, 0);
});

test("live messages after the snapshot keep streaming previews", () => {
  let detail = { events: [] as TimelineEvent[], agents: [], consults: [] };
  for (const text of ["작", "성"]) detail = applyMessage(detail, 1, msg(1, "chat:event", { id: 0, chatId: 1, node: "orch", role: "orch", at: 1, event: { type: "text_delta", text } }));
  assert.deepEqual(detail.events.map(e => e.event), [{ type: "text_delta", text: "작성" }]);
});

test("a chat list snapshot read before chat:deleted does not bring the chat back", () => {
  const versions = new Map<number, number>();
  const chat = (id: number) => ({ id, projectId: 1, title: `c${id}`, status: "idle" } as Chat);
  const deleted = new Set<number>();
  let chats = mergeChats([], versions, [chat(1), chat(2)], 3);
  // chat:deleted [2] arrives (seq 5), then a /api/chats snapshot read at seq 4 still lists it.
  deleted.add(2);
  chats = withoutDeleted(chats, deleted);
  chats = withoutDeleted(mergeChats(chats, versions, [chat(1), chat(2)], 4), deleted);
  assert.deepEqual(chats.map(c => c.id), [1]);
  // A late single-chat snapshot (partial merge) is filtered the same way.
  chats = withoutDeleted(mergeChats(chats, versions, [chat(2)], 4, true), deleted);
  assert.deepEqual(chats.map(c => c.id), [1]);
});

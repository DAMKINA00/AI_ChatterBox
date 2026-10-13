import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatNotifications, APPROVAL_REMINDER_MS, type ChatNotice } from "./chat-notifications";
import type { Chat } from "../shared/types";

const chat = (id: number, status: Chat["status"], goal: Chat["goal"] = null) => ({ id, title: `chat ${id}`, status, goal }) as Chat;

test("approval waits notify immediately, once again after a minute, and never repeatedly", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: ChatNotice[] = [];
  const notifications = new ChatNotifications((_chat, notice) => notices.push(notice));
  notifications.chatChanged(chat(1, "approval"));
  notifications.chatChanged(chat(1, "approval"));
  assert.deepEqual(notices, ["approval"]);
  t.mock.timers.tick(APPROVAL_REMINDER_MS - 1);
  assert.equal(notices.length, 1);
  t.mock.timers.tick(1);
  notifications.chatChanged(chat(1, "approval"));
  t.mock.timers.tick(APPROVAL_REMINDER_MS * 10);
  assert.deepEqual(notices, ["approval", "reminder"]);
  notifications.destroy();
});

test("answer, stop, failure and shutdown cancel reminders; chats and new waits remain independent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: string[] = [];
  const notifications = new ChatNotifications((c, notice) => notices.push(`${c.id}:${notice}`));
  for (const id of [1, 2, 3, 4]) notifications.chatChanged(chat(id, "approval"));
  notifications.chatChanged(chat(1, "working"));
  notifications.chatChanged(chat(2, "idle"));
  notifications.chatChanged(chat(3, "error"));
  t.mock.timers.tick(APPROVAL_REMINDER_MS);
  assert.deepEqual(notices.filter((n) => n.endsWith(":reminder")), ["4:reminder"]);
  notifications.chatChanged(chat(1, "approval"));
  t.mock.timers.tick(APPROVAL_REMINDER_MS);
  assert.deepEqual(notices.filter((n) => n.endsWith(":reminder")), ["4:reminder", "1:reminder"]);
  notifications.chatChanged(chat(5, "approval"));
  notifications.destroy();
  t.mock.timers.tick(APPROVAL_REMINDER_MS);
  assert.ok(!notices.includes("5:reminder"));
});

test("whole-chat completion notifies once, suppressing historical and intermediate goal/queued turns", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: string[] = [];
  const notifications = new ChatNotifications((c, notice) => notices.push(`${c.id}:${notice}`), [chat(9, "done")]);
  notifications.chatChanged(chat(9, "done"));
  notifications.chatChanged(chat(1, "working"));
  notifications.chatChanged(chat(1, "done"));
  notifications.chatChanged(chat(1, "done"));
  t.mock.timers.tick(500);
  notifications.chatChanged(chat(1, "done"));
  const active = { status: "active" } as Chat["goal"];
  notifications.chatChanged(chat(2, "working", active));
  notifications.chatChanged(chat(2, "done", active));
  notifications.chatChanged(chat(3, "working"));
  notifications.chatChanged(chat(3, "done"));
  t.mock.timers.tick(1);
  notifications.chatChanged(chat(3, "working"));
  t.mock.timers.tick(500);
  assert.deepEqual(notices, ["1:done"]);
  notifications.chatChanged(chat(2, "working", active));
  notifications.chatChanged(chat(2, "done", { status: "complete" } as Chat["goal"]));
  notifications.chatChanged(chat(3, "done"));
  t.mock.timers.tick(500);
  assert.deepEqual(notices, ["1:done", "2:done", "3:done"]);
  notifications.destroy();
});

// Remote sign-out: back to the login page only when the session ended (review 1167, item 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { logout } from "./api";

function answer(status: number | Error) {
  (globalThis as { fetch?: unknown }).fetch = async () => {
    if (status instanceof Error) throw status;
    return { status, ok: status >= 200 && status < 300, json: async () => (status >= 400 ? { error: `상태 ${status}` } : { ok: true }) };
  };
}

test("logout resolves when the server ended the session or it had already ended (401)", async () => {
  answer(200);
  await logout();
  answer(401);
  await logout();
});

test("logout rejects on any other answer, so the page keeps the session and offers another try", async () => {
  answer(503);
  await assert.rejects(logout(), /상태 503/);
  answer(403);
  await assert.rejects(logout(), /상태 403/);
  answer(new TypeError("network down"));
  await assert.rejects(logout(), /network down/);
});

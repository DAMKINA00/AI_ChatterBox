import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { DeepSeekService } from "./deepseek";

test("balance refresh coalesces per key and rejects late results from replaced or removed keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deepseek-balance-"));
  const store = new Store(join(root, "app.db"));
  store.setSetting("usage", JSON.stringify({ deepseek: { state: "ready", balances: [{ currency: "USD", total: "99" }] } }));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, event() {}, usage() {} }, root, "unused");
  const replies: ((response: Response) => void)[] = [];
  const service = new DeepSeekService(store, { encrypt: value => value, decrypt: value => value }, () => new Promise(resolve => replies.push(resolve)));
  chats.deepSeek = () => service;
  const response = (amount: string) => Response.json({ is_available: true, balance_infos: [{ currency: "USD", total_balance: amount, granted_balance: "0", topped_up_balance: amount }] });
  try {
    assert.equal(chats.usage().deepseek, undefined);
    await chats.refreshDeepSeekBalance();
    assert.deepEqual(chats.usage().deepseek, { state: "unconfigured", balances: [] });
    assert.equal(replies.length, 0);
    service.save({ apiKey: "sk-test-first-key" }); chats.resetDeepSeekBalance();
    const first = chats.refreshDeepSeekBalance();
    assert.equal(chats.refreshDeepSeekBalance(), first);
    service.save({ apiKey: "sk-test-second-key" }); chats.resetDeepSeekBalance();
    const second = chats.refreshDeepSeekBalance();
    assert.equal(chats.usage().deepseek?.state, "loading");
    assert.equal(replies.length, 2);
    replies[1](response("1.46")); await second;
    replies[0](response("99.00")); await first;
    assert.equal(chats.usage().deepseek?.balances[0].total, "1.46");
    const removed = chats.refreshDeepSeekBalance();
    service.remove(); chats.resetDeepSeekBalance();
    replies[2](response("88.00")); await removed;
    assert.deepEqual(chats.usage().deepseek, { state: "unconfigured", balances: [] });
    assert.doesNotMatch(store.getSetting("usage")!, /sk-test|88.00|99.00/);
    service.save({ apiKey: "sk-test-third-key" });
    const ready = chats.refreshDeepSeekBalance(); replies[3](response("0.12")); await ready;
    const failed = chats.refreshDeepSeekBalance(); replies[4](new Response("private", { status: 503 })); await failed;
    assert.equal(chats.usage().deepseek?.state, "error");
    assert.deepEqual(chats.usage().deepseek?.balances, []);
  } finally {
    await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

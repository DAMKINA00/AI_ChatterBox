// Remote adapter: the live stream follows the selected chat, and history answers that arrive for a chat
// left behind (or across a stream gap) never fill its cache (review 1167, item 1).
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteApi, OPEN_WAIT_MS, StaleHistoryError, type RemoteApiHooks } from "./desktop-api";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, cb: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  close() { this.closed = true; }
  fire(type: string, data?: unknown) { for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data ?? []), lastEventId: "1" }); }
}

type Deferred = { resolve: (body: unknown) => void };
function setup() {
  FakeEventSource.all = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const requests: string[] = [];
  const held = new Map<string, Deferred[]>();
  /** Paths whose next answer waits until the test releases it. */
  const hold = new Set<string>();
  (globalThis as { fetch?: unknown }).fetch = async (path: string) => {
    requests.push(path);
    const body = await new Promise<unknown>(resolve => {
      if (hold.has(path)) { hold.delete(path); held.set(path, [...(held.get(path) ?? []), { resolve }]); }
      else resolve(page(path, requests.filter(r => r === path).length));
    });
    return { status: 200, ok: true, json: async () => body };
  };
  const resyncs: (number | null)[] = [];
  const hooks: RemoteApiHooks = { onAuthLost: () => undefined, confirm: async () => true, notify: () => undefined, findEvent: () => undefined, onResync: id => { resyncs.push(id); } };
  const api = createRemoteApi(hooks);
  const stream = () => FakeEventSource.all.at(-1)!;
  const release = (path: string, n: number) => held.get(path)!.shift()!.resolve(page(path, n));
  return { api, requests, hold, release, stream, resyncs };
}

/** Detail answer whose single event tells which request (n-th for that path) it came from. */
function page(path: string, n: number) {
  const chatId = Number(/\/api\/chats\/(\d+)/.exec(path)?.[1] ?? 0);
  return { seq: 0, chat: { id: chatId, title: `채팅 ${chatId}` }, events: [{ id: n, chatId, node: "orch", role: "orch", at: 0, event: { type: "text", text: `${path}#${n}` } }], start: n, hasMore: false, agents: [], consults: [] };
}
const tick = () => new Promise(ok => setImmediate(ok));

test("a late history answer for chat 1 after 1 → 4 → 1 is read again on chat 1's stream", async () => {
  const s = setup();
  s.api.follow(1);
  s.stream().fire("open");
  s.hold.add("/api/chats/1");
  const first = s.api.loadEventsPage(1);
  await tick();
  // Move to chat 4 while chat 1's history is still on its way.
  s.api.follow(4);
  s.stream().fire("open");
  const four = await s.api.loadEventsPage(4);
  assert.equal(four.events[0].chatId, 4);
  // Back to chat 1: the stream must be chat 1's again, whatever is cached.
  s.api.follow(1);
  assert.match(s.stream().url, /\?chat=1$/);
  s.stream().fire("open");
  s.release("/api/chats/1", 1);
  const page1 = await first;
  // The first answer was read across a different stream, so it was read again on the current one.
  assert.equal((page1.events[0].event as { text: string }).text, "/api/chats/1#2");
  assert.deepEqual(s.requests.filter(r => r.startsWith("/api/chats/")), ["/api/chats/1", "/api/chats/4", "/api/chats/1"]);
  assert.equal(FakeEventSource.all.filter(e => !e.closed).length, 1);
  assert.match(FakeEventSource.all.find(e => !e.closed)!.url, /\?chat=1$/);
});

test("a history answer for a chat the user left is dropped (never fills that chat's cache)", async () => {
  const s = setup();
  s.api.follow(1);
  s.stream().fire("open");
  s.hold.add("/api/chats/1");
  const first = s.api.loadEventsPage(1);
  await tick();
  s.api.follow(4);
  s.stream().fire("open");
  s.release("/api/chats/1", 1);
  await assert.rejects(first, StaleHistoryError);
  assert.match(s.stream().url, /\?chat=4$/);
});

test("a stream reconnect while the page loads makes it read again; a reconnect afterwards asks for a resync", async () => {
  const s = setup();
  s.api.follow(1);
  s.stream().fire("open");
  s.hold.add("/api/chats/1");
  const first = s.api.loadEventsPage(1);
  await tick();
  s.stream().fire("open"); // EventSource reconnected by itself: events may have been missed
  assert.deepEqual(s.resyncs, [1]);
  s.release("/api/chats/1", 1);
  assert.equal(((await first).events[0].event as { text: string }).text, "/api/chats/1#2");
});

test("a first connection slower than the wait: the page loads, and the late open asks to read the chat again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const s = setup();
    s.api.follow(1);
    const load = s.api.loadEventsPage(1);
    mock.timers.tick(OPEN_WAIT_MS);
    const loaded = await load;
    assert.equal(loaded.events[0].chatId, 1);
    assert.deepEqual(s.resyncs, []);
    s.stream().fire("open");
    assert.deepEqual(s.resyncs, [1]);
  } finally {
    mock.timers.reset();
  }
});

test("follow(null) keeps one stream for list updates; following the same chat again does not reconnect", () => {
  const s = setup();
  s.api.start();
  s.api.follow(null);
  assert.equal(FakeEventSource.all.length, 1);
  s.api.follow(2);
  s.api.follow(2);
  assert.equal(FakeEventSource.all.length, 2);
  assert.ok(FakeEventSource.all[0].closed);
});

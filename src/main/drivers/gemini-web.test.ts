import assert from "node:assert/strict";
import { test } from "node:test";
import { GEMINI_ORIGIN, webConversationId, type WebSnapshot } from "./gemini-web-protocol";
import { GeminiWebDriver } from "./gemini-web";
import type { GeminiWebUsage } from "../../shared/types";
import type { AgentEvent } from "../../shared/types";
import type { AgentInput, DriverHost } from "./types";
import type { GeminiWebBrowser } from "./gemini-web-browser";

const input: AgentInput = { text: "이 안내 문장을 자연스럽게 다듬어 주세요.", attachments: [], noWrites: true };
const available: GeminiWebUsage = { status: "available", detail: "사용량 확인됨", checkedAt: 0 };

function snapshot(overrides: Partial<WebSnapshot> = {}): WebSnapshot {
  return {
    url: `${GEMINI_ORIGIN}/app/chat-a1`,
    login: false,
    composer: true,
    draft: "",
    model: "Argon",
    chatMode: true,
    generating: false,
    users: [],
    responses: [],
    notices: [],
    ...overrides,
  };
}

type PollFactory = (poll: number, submittedPrompt: string | undefined) => WebSnapshot | null;

interface FakeBrowserState {
  owner?: string;
  claims: string[];
  releases: string[];
  interrupts: string[];
  submittedPrompts: string[];
  observed: WebSnapshot[];
  polls: number;
}

function fakeBrowser(factory: PollFactory, usage: GeminiWebUsage | ((s: WebSnapshot) => GeminiWebUsage) = available, before = snapshot({ url: `${GEMINI_ORIGIN}/app/before` })) {
  const state: FakeBrowserState = { claims: [], releases: [], interrupts: [], submittedPrompts: [], observed: [], polls: 0 };
  const browser = {
    claim: async (owner: string) => {
      if (state.owner) throw new Error("Gemini 웹 계정 1이 다른 작업을 처리 중입니다. 완료 후 다시 배정하세요.");
      state.owner = owner;
      state.claims.push(owner);
    },
    release: (owner: string) => {
      state.releases.push(owner);
      if (state.owner === owner) state.owner = undefined;
    },
    prepare: async (_owner: string, _nativeId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      assert.equal(before.chatMode, true);
      return before;
    },
    submit: async (_owner: string, prompt: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      state.submittedPrompts.push(prompt);
    },
    snapshot: async () => {
      state.polls += 1;
      const result = factory(state.polls, state.submittedPrompts.at(-1));
      if (result) state.observed.push(result);
      return result;
    },
    observe: (s: WebSnapshot) => {
      state.observed.push(s);
      return typeof usage === "function" ? usage(s) : usage;
    },
    refresh: async () => ({ usage: typeof usage === "function" ? usage(snapshot()) : usage }),
    nativeId: (s: WebSnapshot) => webConversationId(s.url),
    interrupt: async (owner: string) => {
      if (state.owner === owner) state.interrupts.push(owner);
    },
  } as unknown as GeminiWebBrowser;
  return { browser, state };
}

function runWith(browser: GeminiWebBrowser, nativeId: string | null = null) {
  const events: AgentEvent[] = [];
  const nativeIds: string[] = [];
  const host: DriverHost = {
    emit: (event) => events.push(event),
    nativeId: (id) => nativeIds.push(id),
    approve: async () => ({ verdict: "allow" }),
  };
  const driver = new GeminiWebDriver({ cwd: process.cwd(), nativeId, exePath: "unused" }, browser, host);
  return { driver, events, nativeIds, host };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function waitForTask(driver: GeminiWebDriver) {
  const task = (driver as any).task as Promise<void> | undefined;
  if (task) await task;
}

async function pulse(t: { mock: { timers: { tick(ms: number): void } } }) {
  await flush();
  t.mock.timers.tick(750);
  await flush();
}

test("Gemini web driver rejects writes before claiming the shared browser", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser(() => snapshot());
  const run = runWith(fake.browser);

  await assert.rejects(run.driver.send({ ...input, noWrites: false }), /분석|리뷰|파일 수정/);

  assert.equal(fake.state.claims.length, 0);
  assert.equal(fake.state.submittedPrompts.length, 0);
  assert.equal(run.events.length, 0);
});

test("Gemini web driver waits for its request marker and associates a native id only after acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldResponse = { text: "이전 턴의 오래된 응답", complete: true };
  const freshResponse = { text: "새 요청의 최신 응답", complete: true };
  const fake = fakeBrowser((poll, prompt) => {
    const marker = /\[ChatterBox ([^\]]+)\]/.exec(prompt ?? "")?.[1] ?? "missing-marker";
    if (poll === 1) return snapshot({ url: `${GEMINI_ORIGIN}/app/stale`, users: ["이전 요청"], responses: [oldResponse] });
    if (poll === 2) return snapshot({ url: `${GEMINI_ORIGIN}/app/accepted`, users: [`현재 요청 ${marker}`], generating: true, responses: [oldResponse, freshResponse] });
    return snapshot({ url: `${GEMINI_ORIGIN}/app/accepted`, users: [`현재 요청 ${marker}`], responses: [oldResponse, freshResponse] });
  }, available, snapshot({ url: `${GEMINI_ORIGIN}/app/before`, responses: [oldResponse] }));
  const run = runWith(fake.browser);

  await run.driver.send(input);
  await pulse(t);
  assert.deepEqual(run.nativeIds, []);
  await pulse(t);
  assert.match(fake.state.submittedPrompts[0] ?? "", /^\[ChatterBox [^\]]+\]/);
  await pulse(t);
  await pulse(t);
  await waitForTask(run.driver);

  assert.deepEqual(run.nativeIds, ["web:gemini-1:/app/accepted"]);
  assert.equal(run.events.filter((event) => event.type === "text" && event.text === oldResponse.text).length, 0);
  assert.equal(run.events.filter((event) => event.type === "text" && event.text === freshResponse.text).length, 1);
  assert.equal(run.events.filter((event) => event.type === "text_delta" && event.text.includes("이전 턴")).length, 0);
  assert.equal(run.events.findLast((event) => event.type === "turn_end")?.ok, true);
});

test("Gemini web driver reports an Argon model change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser((_poll, prompt) => {
    const marker = /\[ChatterBox ([^\]]+)\]/.exec(prompt ?? "")?.[1] ?? "missing-marker";
    return snapshot({ model: "Other model", users: [`현재 요청 ${marker}`] });
  });
  const run = runWith(fake.browser);

  await run.driver.send(input);
  await pulse(t);
  await waitForTask(run.driver);

  assert.match(run.events.find((event) => event.type === "error")?.message ?? "", /Argon|모델/);
  assert.equal(run.events.findLast((event) => event.type === "turn_end")?.ok, false);
  assert.equal(run.events.some((event) => event.type === "text"), false);
});

test("Gemini web driver reports a visible web usage limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const limited: GeminiWebUsage = { status: "limited", detail: "주간 한도에 도달했습니다.", checkedAt: 1 };
  const fake = fakeBrowser(() => snapshot(), limited);
  const run = runWith(fake.browser);

  await run.driver.send(input);
  await pulse(t);
  await waitForTask(run.driver);

  assert.match(run.events.find((event) => event.type === "error")?.message ?? "", /한도|limit|사용량/);
  assert.equal(run.events.findLast((event) => event.type === "turn_end")?.ok, false);
});

test("Gemini web driver refuses to complete a turn after login is lost", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser(() => snapshot({ login: true, users: ["로그인 필요"] }));
  const run = runWith(fake.browser);

  await run.driver.send(input);
  await pulse(t);
  await waitForTask(run.driver);

  assert.match(run.events.find((event) => event.type === "error")?.message ?? "", /로그인|연결/);
  assert.equal(run.events.findLast((event) => event.type === "turn_end")?.ok, false);
  assert.equal(run.events.some((event) => event.type === "text"), false);
});

test("stopping while waiting releases only the active turn and a busy account rejection preserves it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeBrowser((_poll, prompt) => {
    const marker = /\[ChatterBox ([^\]]+)\]/.exec(prompt ?? "")?.[1] ?? "missing-marker";
    return snapshot({ generating: true, users: [`현재 요청 ${marker}`] });
  });
  const first = runWith(fake.browser);
  const second = runWith(fake.browser);

  await first.driver.send(input);
  await pulse(t);
  assert.equal(first.driver.running, true);
  const firstOwner = fake.state.owner;
  assert.ok(firstOwner);

  await second.driver.send(input);
  await waitForTask(second.driver);
  assert.match(second.events.find((event) => event.type === "error")?.message ?? "", /다른 작업|처리 중/);
  assert.equal(fake.state.owner, firstOwner);
  assert.deepEqual(fake.state.interrupts, []);

  const stopping = first.driver.stop();
  await flush();
  t.mock.timers.tick(750);
  await stopping;
  await waitForTask(first.driver);
  assert.equal(first.driver.running, false);
  assert.deepEqual(fake.state.interrupts, [firstOwner]);
  assert.equal(fake.state.owner, undefined);
  assert.equal(first.events.findLast((event) => event.type === "turn_end")?.interrupted, true);
});

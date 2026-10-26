import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIStudioService, studioOrigin } from "./aistudio";

const FAKE_STUDIO_SETTINGS = JSON.stringify({
  baseUrl: "http://127.0.0.1:2048",
  model: "gemini-4-argon",
  executable: "C:\\synthetic\\aistudio2api.exe",
  videoEnabled: false,
  secret: "encrypted:synthetic-api-key",
});

function store() {
  const values = new Map<string, string>([["aiStudio", FAKE_STUDIO_SETTINGS]]);
  return {
    getSetting: (key: string) => values.get(key),
    setSetting: (key: string, value: string) => values.set(key, value),
    values,
  };
}

const secrets = {
  encrypt: (value: string) => `encrypted:${value}`,
  decrypt: (value: string) => value.replace(/^encrypted:/, ""),
};

function lifecycleFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "chatterbox-studio-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exe = join(root, "aistudio2api.exe");
  writeFileSync(exe, "synthetic");
  writeFileSync(join(root, ".env"), "PROXY_API_KEY=local-test-key\n");
  const saved = store();
  saved.setSetting("aiStudio", JSON.stringify({ executable: "" }));
  const state = { installed: false, online: false, state: "STOPPED", enabled: true, installs: 0, launches: 0, starts: 0, auth: "" };
  const runtime = {
    find: () => state.installed ? exe : "",
    install: async () => { state.installs++; state.installed = true; },
    launch: async () => { state.launches++; state.online = true; },
  };
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    if (!state.online) throw new Error("offline");
    state.auth = new Headers(init?.headers).get("Authorization") ?? "";
    const path = new URL(String(input)).pathname;
    if (path === "/api/status") return jsonResponse({ state: state.state });
    if (path === "/api/accounts") return jsonResponse({ accounts: state.enabled ? [{ id: "test@example.test", enabled: true }] : [] });
    if (path === "/api/control/start") { state.starts++; state.state = "RUNNING"; }
    return jsonResponse({});
  }, runtime);
  return { service, saved, state, runtime, exe };
}

test("first Gemini calls share one verified install, launch and service start", async t => {
  const { service, saved, state, exe } = lifecycleFixture(t);
  const notices: string[] = [];
  await Promise.all(Array.from({ length: 3 }, () => service.ensureReady(new AbortController().signal, text => notices.push(text))));
  assert.equal(state.installs, 1);
  assert.equal(state.launches, 1);
  assert.equal(state.starts, 1);
  assert.equal(state.auth, "Bearer local-test-key");
  assert.equal(JSON.parse(saved.getSetting("aiStudio")!).executable, exe);
  assert.ok(notices.some(text => text.includes("SHA-256")));
  await service.ensureReady(new AbortController().signal, () => undefined);
  assert.equal(state.installs, 1);
  assert.equal(state.starts, 1);
});

test("an existing managed runtime is rediscovered despite an empty saved executable", async t => {
  const { service, state, exe } = lifecycleFixture(t);
  state.installed = true;
  await service.ensureReady(new AbortController().signal, () => undefined);
  assert.equal(state.installs, 0);
  assert.equal(state.launches, 1);
  assert.equal(service.settings().executable, exe);
  assert.equal(service.settings().hasApiKey, true);
});

test("a healthy configured server is reused without installing or launching", async t => {
  const { service, state } = lifecycleFixture(t);
  service.save({ baseUrl: "http://127.0.0.1:9048" });
  state.online = true; state.state = "RUNNING";
  await service.ensureReady(new AbortController().signal, () => undefined);
  assert.equal(state.installs + state.launches + state.starts, 0);
});

test("an unavailable custom address is not replaced by a default installation", async t => {
  const { service, state } = lifecycleFixture(t);
  service.save({ baseUrl: "http://127.0.0.1:9048" });
  await assert.rejects(service.ensureReady(new AbortController().signal, () => undefined), /주소와 실행 파일/);
  assert.equal(state.installs + state.launches + state.starts, 0);
});

test("installation failure can be retried without starting an unverified runtime", async t => {
  const { service, state, runtime } = lifecycleFixture(t);
  const install = runtime.install;
  runtime.install = async () => { throw new Error("SHA-256 mismatch"); };
  await assert.rejects(service.ensureReady(new AbortController().signal, () => undefined), /SHA-256 mismatch/);
  assert.equal(state.launches + state.starts, 0);
  runtime.install = install;
  await service.ensureReady(new AbortController().signal, () => undefined);
  assert.equal(state.installs, 1);
});

test("missing Google account reports the next step after installing the manager", async t => {
  const { service, state } = lifecycleFixture(t);
  state.enabled = false;
  await assert.rejects(service.ensureReady(new AbortController().signal, () => undefined), /계정.*연결/);
  assert.equal(state.installs, 1);
  assert.equal(state.launches, 1);
  assert.equal(state.starts, 0);
});

test("canceling one caller stops its wait without canceling another caller's install", async t => {
  const { service, state, runtime } = lifecycleFixture(t);
  let finish!: () => void;
  let began!: () => void;
  const begun = new Promise<void>(resolve => { began = resolve; });
  runtime.install = async () => {
    state.installs++; began();
    await new Promise<void>(resolve => { finish = resolve; });
    state.installed = true;
  };
  const controller = new AbortController();
  const canceled = service.ensureReady(controller.signal, () => undefined);
  const survivor = service.ensureReady(new AbortController().signal, () => undefined);
  await begun;
  controller.abort();
  await assert.rejects(canceled, { name: "AbortError" });
  finish();
  await survivor;
  assert.equal(state.installs, 1);
  assert.equal(state.starts, 1);
});

function jsonResponse(value: unknown, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

test("AI Studio accepts only loopback HTTP origins and strips supported API paths", () => {
  assert.equal(studioOrigin("http://127.0.0.1:2048"), "http://127.0.0.1:2048");
  assert.equal(studioOrigin("http://localhost:2048/v1/"), "http://localhost:2048");
  assert.equal(studioOrigin("http://[::1]:2048/v1"), "http://[::1]:2048");

  for (const value of [
    "https://127.0.0.1:2048",
    "http://0.0.0.0:2048",
    "http://example.test:2048",
    "http://127.0.0.1:2048/other",
    "http://127.0.0.1:2048/api",
    "http://user:pass@127.0.0.1:2048",
    "http://127.0.0.1:2048/?key=secret",
    "http://127.0.0.1:2048/#secret",
  ]) {
    assert.throws(() => studioOrigin(value), /AIStudio2API 주소는 로컬 HTTP 주소여야 합니다/);
  }
});

test("settings and exported custom model config never contain the API key", () => {
  const saved = store();
  const service = new AIStudioService(saved, secrets, async () => jsonResponse({}));
  service.save({ apiKey: "super-secret-api-key" });

  const settings = service.settings();
  assert.equal(settings.hasApiKey, true);
  assert.equal("secret" in settings, false);
  assert.doesNotMatch(JSON.stringify(settings), /super-secret-api-key|encrypted:/);

  assert.match(saved.values.get("aiStudio") ?? "", /encrypted:/);
});

function statusPayload(path: string, accounts: unknown[]) {
  if (path === "/api/status") return jsonResponse({ state: "RUNNING", version: "synthetic" });
  if (path === "/api/accounts") return jsonResponse({ accounts });
  if (path === "/api/cooldowns") return jsonResponse({ cooldowns: [] });
  if (path === "/api/models") return jsonResponse({ models: [{ id: "gemini-4-argon", name: "Argon" }] });
  return undefined;
}

function usagePayload() {
  const stats = { requests: 8, succeeded: 5, failed: 2, canceled: 1, rate_limited: 1,
    input_tokens: 1000, cached_tokens: 400, reasoning_tokens: 50, reply_tokens: 150, total_tokens: 1200 };
  return { from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z", generated_at: "2026-10-20T00:00:01Z",
    totals: stats, groups: { account: [{ key: "studio@example.test", ...stats }], model: [{ key: "gemini-4-argon", ...stats }], channel: [{ key: "playground", ...stats }] },
    api_key: "never-return-this", messages: ["private prompt"], remainingPercent: 80 };
}

test("AI Studio usage queries bounded rolling periods and exposes only independent aggregate counters", async () => {
  const urls: URL[] = [];
  const service = new AIStudioService(store(), secrets, async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(url.pathname, "/api/usage");
    assert.equal(init?.method, "GET");
    return jsonResponse(usagePayload());
  });
  for (const [range, days] of [[undefined, 1], ["7d", 7], ["30d", 30]] as const) {
    const report = await service.usage(range);
    const query = urls.at(-1)!.searchParams;
    assert.equal(Date.parse(query.get("to")!) - Date.parse(query.get("from")!), days * 86400000);
    assert.ok(Math.abs(Date.parse(query.get("to")!) - Date.now()) < 1000);
    assert.equal(report.totals.requests, 8);
    assert.equal(report.totals.failed, 2);
    assert.equal(report.totals.rateLimited, 1);
    assert.equal(report.totals.cachedTokens, 400);
    assert.equal(report.totals.totalTokens, 1200, "cached tokens are already included in input, not added again");
    assert.equal(report.groups.account[0].key, "studio@example.test");
    assert.equal(report.groups.model[0].replyTokens, 150);
    assert.equal(report.groups.channel[0].reasoningTokens, 50);
    assert.equal(report.generatedAt, "2026-10-20T00:00:01.000Z");
    assert.doesNotMatch(JSON.stringify(report), /never-return-this|private prompt|remainingPercent/);
  }
  await assert.rejects(service.usage("7d&account=other" as any), /조회 기간/);
  assert.equal(urls.length, 3);
});

test("AI Studio usage distinguishes empty records from malformed or unavailable statistics", async () => {
  const empty = usagePayload();
  for (const field of Object.keys(empty.totals)) empty.totals[field as keyof typeof empty.totals] = 0;
  empty.groups = { account: [], model: [], channel: [] };
  const service = new AIStudioService(store(), secrets, async () => jsonResponse(empty));
  assert.equal((await service.usage()).totals.requests, 0);
  for (const corrupt of [
    (report: any) => { delete report.totals.input_tokens; },
    (report: any) => { report.totals.requests = -1; },
    (report: any) => { report.totals.total_tokens = "1200"; },
    (report: any) => { report.generated_at = "invalid"; },
    (report: any) => { report.groups.account = null; },
    (report: any) => { report.groups.model[0].key = {}; },
  ]) {
    const payload = usagePayload(); corrupt(payload);
    const broken = new AIStudioService(store(), secrets, async () => jsonResponse(payload));
    await assert.rejects(broken.usage(), /응답 형식/);
  }
  const unavailable = new AIStudioService(store(), secrets, async () => jsonResponse({ error: { message: "usage unavailable" } }, 503, "Unavailable"));
  await assert.rejects(unavailable.usage(), /503.*usage unavailable/);
});

test("syncWeb sends one synthetic account's cookie state to loopback and records the web link", async () => {
  const saved = store();
  const email = "shared@example.test";
  const cookieState = [{ name: "SID", value: "synthetic-cookie" }];
  const calls: { url: string; init?: RequestInit }[] = [];
  const accounts: any[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({ url, init });
    const status = statusPayload(path, accounts);
    if (status) return status;
    if (path === "/api/pairing") return jsonResponse({ token: "synthetic-pairing-token" });
    if (path === "/api/pairing/accounts") {
      const payload = JSON.parse(String(init?.body));
      accounts.push({ id: payload.label, enabled: true, models: ["gemini-4-argon"] });
      return jsonResponse({ account: accounts.at(-1) });
    }
    return jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
  });

  await service.syncWeb("gemini-1", true, async () => ({ email, cookies: cookieState, origins: [] }));

  const pairing = calls.find(call => new URL(call.url).pathname === "/api/pairing/accounts");
  assert.ok(pairing);
  assert.equal(new URL(pairing.url).hostname, "127.0.0.1");
  const payload = JSON.parse(String(pairing.init?.body));
  assert.deepEqual(payload.storage_state, { cookies: cookieState, origins: [] });
  assert.equal(payload.label, email);
  assert.equal(pairing.init?.headers && new Headers(pairing.init.headers).get("Authorization"), "Bearer synthetic-pairing-token");
  assert.equal(service.linkedAccount("gemini-1"), email);
  assert.equal(JSON.parse(saved.values.get("aiStudioWebLinks") ?? "{}")["gemini-1"].accountId, email);

  const status = await service.status();
  assert.equal(status.webLinks?.["gemini-1"]?.accountId, email);
  assert.equal(status.webLinks?.["gemini-1"]?.state, "connected");
  assert.doesNotMatch(JSON.stringify(status), /synthetic-cookie|synthetic-pairing-token/);
  assert.doesNotMatch(JSON.stringify(service.settings()), /synthetic-cookie|synthetic-pairing-token/);
});

test("concurrent syncWeb imports are serialized and the eleventh account is rejected", async () => {
  const service = new AIStudioService(store(), secrets, async (input, init) => {
    const path = new URL(String(input)).pathname;
    activeFetch++;
    maximumFetch = Math.max(maximumFetch, activeFetch);
    await new Promise(resolve => setTimeout(resolve, 1));
    try {
      if (path === "/api/accounts" && (init?.method ?? "GET") === "GET") return jsonResponse({ accounts });
      if (path === "/api/pairing") return jsonResponse({ token: `token-${pairingCalls + 1}` });
      if (path === "/api/pairing/accounts") {
        pairingCalls++;
        const payload = JSON.parse(String(init?.body));
        accounts.push({ id: payload.label, enabled: true, models: [] });
        return jsonResponse({ account: accounts.at(-1) });
      }
      return jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
    } finally {
      activeFetch--;
    }
  });
  let activeFetch = 0;
  let maximumFetch = 0;
  let activeState = 0;
  let maximumState = 0;
  let pairingCalls = 0;
  const accounts: any[] = [];

  const operations = Array.from({ length: 11 }, (_, index) => service.syncWeb(
    `gemini-${Math.min(index + 1, 10)}`,
    true,
    async () => {
      activeState++;
      maximumState = Math.max(maximumState, activeState);
      await new Promise(resolve => setTimeout(resolve, 1));
      activeState--;
      return { email: `user-${index}@example.test`, cookies: [{ name: "SID", value: `cookie-${index}` }], origins: [] };
    },
  ));
  const results = await Promise.allSettled(operations);

  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason), /이미 10개 계정/);
  assert.equal(accounts.length, 10);
  assert.equal(pairingCalls, 10);
  assert.equal(maximumFetch, 1);
  assert.equal(maximumState, 1);
});

test("failed syncWeb state lookup preserves the existing link and makes no pairing call", async () => {
  const saved = store();
  saved.setSetting("aiStudioWebLinks", JSON.stringify({ "gemini-1": { accountId: "existing@example.test", state: "connected", message: "old", checkedAt: 1 } }));
  let pairingCalls = 0;
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/pairing") pairingCalls++;
    return statusPayload(path, [])
      ?? jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
  });

  await assert.rejects(service.syncWeb("gemini-1", true, async () => { throw new Error("synthetic getState failed"); }), /synthetic getState failed/);
  assert.equal(service.linkedAccount("gemini-1"), "existing@example.test");
  assert.equal(pairingCalls, 0);
  const status = await service.status();
  assert.equal(status.webLinks?.["gemini-1"]?.accountId, "existing@example.test");
  assert.equal(status.webLinks?.["gemini-1"]?.state, "error");
  assert.match(status.webLinks?.["gemini-1"]?.message ?? "", /synthetic getState failed/);
});

test("an existing account is not newly paired when the local account list is already at ten", async () => {
  const saved = store();
  const duplicate = "existing@example.test";
  const accounts = [{ id: duplicate }, ...Array.from({ length: 9 }, (_, i) => ({ id: `other-${i}@example.test` }))];
  let pairingCalls = 0;
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/accounts" && (init?.method ?? "GET") === "GET") return jsonResponse({ accounts });
    if (path === "/api/pairing") pairingCalls++;
    return jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
  });
  service.save({ executable: "C:\\synthetic\\aistudio2api.exe" });

  await assert.rejects(service.syncWeb("gemini-1", true, async () => ({ email: duplicate, cookies: [], origins: [] })), /재동기화는 ChatterBox가 설치한 로컬/);
  assert.equal(pairingCalls, 0);
});

test("changing the AI Studio base URL clears persisted Web associations", () => {
  const saved = store();
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId: "linked@example.test", state: "connected", checkedAt: 1 },
  }));
  const service = new AIStudioService(saved, secrets, async () => jsonResponse({}));

  service.save({ baseUrl: "http://localhost:2049" });

  assert.equal(service.linkedAccount("gemini-1"), undefined);
  assert.equal(saved.values.get("aiStudioWebLinks"), "{}");
});

test("syncWeb rejects a Web email already linked to another slot without importing it", async () => {
  const saved = store();
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId: "shared@example.test", state: "connected", checkedAt: 1 },
  }));
  const calls: string[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/accounts") return jsonResponse({ accounts: [] });
    return jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
  });

  await assert.rejects(
    service.syncWeb("gemini-2", true, async () => ({ email: "shared@example.test", cookies: [], origins: [] })),
    /이미 다른 Web 계정 카드에 연결된 Google 계정/,
  );

  assert.equal(service.linkedAccount("gemini-1"), "shared@example.test");
  assert.equal(service.linkedAccount("gemini-2"), undefined);
  assert.equal(calls.includes("POST /api/pairing"), false);
  assert.equal(calls.includes("POST /api/pairing/accounts"), false);
});

test("syncWeb checks the ten-account cap before disabling a replaced identity", async () => {
  const saved = store();
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId: "old@example.test", state: "connected", checkedAt: 1 },
  }));
  const accounts = [
    { id: "old@example.test", label: "old", enabled: true },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `other-${index}@example.test`, enabled: true })),
  ];
  const calls: string[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/accounts") return jsonResponse({ accounts });
    return jsonResponse({ error: { message: `unexpected ${init?.method ?? "GET"} ${path}` } }, 404, "Not Found");
  });

  await assert.rejects(
    service.syncWeb("gemini-1", true, async () => ({ email: "new@example.test", cookies: [], origins: [] })),
    /이미 10개 계정/,
  );

  assert.equal(calls.includes("PUT /api/accounts/old%40example.test"), false);
  assert.equal(calls.some(call => call === "POST /api/pairing" || call === "POST /api/pairing/accounts"), false);
  assert.equal(service.linkedAccount("gemini-1"), "old@example.test");
});

test("syncWeb disables a replaced upstream identity before pairing the new one", async () => {
  const saved = store();
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId: "old@example.test", state: "connected", checkedAt: 1 },
  }));
  const calls: string[] = [];
  const oldAccount = { id: "old@example.test", label: "old", enabled: true };
  const accounts = [oldAccount];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/accounts" && method === "GET") return jsonResponse({ accounts });
    if (path === "/api/accounts/old%40example.test" && method === "PUT") {
      calls.push("disable-old");
      return jsonResponse({ account: { ...oldAccount, enabled: false } });
    }
    if (path === "/api/pairing" && method === "POST") {
      calls.push("pairing");
      return jsonResponse({ token: "synthetic-pairing-token" });
    }
    if (path === "/api/pairing/accounts" && method === "POST") {
      calls.push("import");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.label, "new@example.test");
      return jsonResponse({ account: { id: "new@example.test", enabled: true } });
    }
    return jsonResponse({ error: { message: `unexpected ${method} ${path}` } }, 404, "Not Found");
  });

  await service.syncWeb("gemini-1", true, async () => ({ email: "new@example.test", cookies: [], origins: [] }));

  assert.deepEqual(calls, ["disable-old", "pairing", "import"]);
  assert.equal(service.linkedAccount("gemini-1"), "new@example.test");
});

test("disconnectWeb with no link performs no HTTP request", async () => {
  const saved = store();
  let requests = 0;
  const service = new AIStudioService(saved, secrets, async () => {
    requests++;
    return jsonResponse({});
  });

  await service.disconnectWeb("gemini-1");

  assert.equal(requests, 0);
  assert.equal(saved.values.get("aiStudioWebLinks"), "{}");
});

test("disconnectWeb deletes a ready linked runtime account and clears the Web link", async () => {
  const saved = store();
  const accountId = "linked@example.test";
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId, state: "connected", message: "linked", checkedAt: 1 },
  }));
  const accountPath = `/api/accounts/${encodeURIComponent(accountId)}`;
  const calls: string[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/accounts" && method === "GET") return jsonResponse({ accounts: [{ id: accountId, state: "ready" }] });
    if (url.pathname === accountPath && method === "DELETE") return jsonResponse({});
    return jsonResponse({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404, "Not Found");
  });

  await service.disconnectWeb("gemini-1");

  assert.deepEqual(calls, [`GET /api/accounts`, `DELETE ${accountPath}`]);
  assert.equal(service.linkedAccount("gemini-1"), undefined);
  assert.deepEqual(JSON.parse(saved.values.get("aiStudioWebLinks") ?? "null"), {});
});

test("disconnectWeb refuses a busy linked runtime account and keeps the link", async () => {
  const saved = store();
  const accountId = "busy@example.test";
  const links = { "gemini-1": { accountId, state: "connected", message: "linked", checkedAt: 1 } };
  saved.setSetting("aiStudioWebLinks", JSON.stringify(links));
  const accountPath = `/api/accounts/${encodeURIComponent(accountId)}`;
  const calls: string[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/accounts" && method === "GET") return jsonResponse({ accounts: [{ id: accountId, state: "busy" }] });
    return jsonResponse({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404, "Not Found");
  });

  await assert.rejects(service.disconnectWeb("gemini-1"), /AI Studio에서 사용 중인 계정/);

  assert.deepEqual(calls, ["GET /api/accounts"]);
  assert.equal(service.linkedAccount("gemini-1"), accountId);
  assert.deepEqual(JSON.parse(saved.values.get("aiStudioWebLinks") ?? "null"), links);
  assert.equal(calls.includes(`DELETE ${accountPath}`), false);
});

test("disconnectWeb keeps the link when runtime DELETE fails", async () => {
  const saved = store();
  const accountId = "delete-failure@example.test";
  const links = { "gemini-1": { accountId, state: "connected", message: "linked", checkedAt: 1 } };
  saved.setSetting("aiStudioWebLinks", JSON.stringify(links));
  const accountPath = `/api/accounts/${encodeURIComponent(accountId)}`;
  const calls: string[] = [];
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/accounts" && method === "GET") return jsonResponse({ accounts: [{ id: accountId, state: "ready" }] });
    if (url.pathname === accountPath && method === "DELETE") return jsonResponse({ error: { message: "runtime refused delete" } }, 503, "Unavailable");
    return jsonResponse({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404, "Not Found");
  });

  await assert.rejects(service.disconnectWeb("gemini-1"), /503.*runtime refused delete/);

  assert.deepEqual(calls, ["GET /api/accounts", `DELETE ${accountPath}`]);
  assert.equal(service.linkedAccount("gemini-1"), accountId);
  assert.deepEqual(JSON.parse(saved.values.get("aiStudioWebLinks") ?? "null"), links);
});

test("disconnectWeb protects a runtime account shared by another Web slot", async () => {
  const saved = store();
  const accountId = "shared@example.test";
  const links = {
    "gemini-1": { accountId, state: "connected", message: "linked", checkedAt: 1 },
    "gemini-2": { accountId, state: "connected", message: "linked", checkedAt: 1 },
  };
  saved.setSetting("aiStudioWebLinks", JSON.stringify(links));
  let requests = 0;
  const service = new AIStudioService(saved, secrets, async () => {
    requests++;
    return jsonResponse({ accounts: [] });
  });

  await assert.rejects(service.disconnectWeb("gemini-1"), /다른 웹 슬롯/);

  assert.equal(requests, 0);
  assert.equal(service.linkedAccount("gemini-1"), accountId);
  assert.equal(service.linkedAccount("gemini-2"), accountId);
  assert.deepEqual(JSON.parse(saved.values.get("aiStudioWebLinks") ?? "null"), links);
});

test("disconnectWeb serializes with another account change", async () => {
  const saved = store();
  const accountId = "serialized@example.test";
  saved.setSetting("aiStudioWebLinks", JSON.stringify({
    "gemini-1": { accountId, state: "connected", message: "linked", checkedAt: 1 },
  }));
  const accountPath = `/api/accounts/${encodeURIComponent(accountId)}`;
  const calls: string[] = [];
  let active = 0;
  let maximum = 0;
  const service = new AIStudioService(saved, secrets, async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    try {
      if (url.pathname === "/api/accounts" && method === "GET") return jsonResponse({ accounts: [{ id: accountId, state: "ready" }] });
      if (url.pathname === `${accountPath}/refresh` && method === "POST") return jsonResponse({});
      if (url.pathname === accountPath && method === "DELETE") return jsonResponse({});
      return jsonResponse({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404, "Not Found");
    } finally {
      active--;
    }
  });

  await Promise.all([
    service.account("refresh", { accountId }),
    service.disconnectWeb("gemini-1"),
  ]);

  assert.equal(maximum, 1);
  assert.deepEqual(calls, ["GET /api/accounts", `POST ${accountPath}/refresh`, "GET /api/accounts", `DELETE ${accountPath}`]);
  assert.equal(service.linkedAccount("gemini-1"), undefined);
});

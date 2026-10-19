import assert from "node:assert/strict";
import { test } from "node:test";
import { AIStudioService, studioOrigin } from "./aistudio";

function store() {
  const values = new Map<string, string>();
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

  const exported = service.antigravityConfig();
  assert.equal(exported.models[0].apiKey, "");
  assert.doesNotMatch(JSON.stringify(exported), /super-secret-api-key|encrypted:/);
  assert.match(saved.values.get("aiStudio") ?? "", /encrypted:/);
});

function statusPayload(path: string, accounts: unknown[]) {
  if (path === "/api/status") return jsonResponse({ state: "RUNNING", version: "synthetic" });
  if (path === "/api/accounts") return jsonResponse({ accounts });
  if (path === "/api/cooldowns") return jsonResponse({ cooldowns: [] });
  if (path === "/api/models") return jsonResponse({ models: [{ id: "gemini-4-argon", name: "Argon" }] });
  return undefined;
}

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

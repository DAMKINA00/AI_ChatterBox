import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekService } from "./deepseek";

function fixture(request: typeof fetch = async () => Response.json({ data: [{ id: "deepseek-flash" }] })) {
  const values = new Map<string, string>();
  const secrets = { encrypt: (text: string) => Buffer.from(text).toString("base64"), decrypt: (text: string) => Buffer.from(text, "base64").toString() };
  const store = { getSetting: (key: string) => values.get(key), setSetting: (key: string, value: string) => { values.set(key, value); } };
  return { values, service: new DeepSeekService(store, secrets, request) };
}

test("DeepSeek keeps encrypted credentials out of status and checks only the official models endpoint", async () => {
  const requests: any[] = [];
  const f = fixture(async (url, options) => { requests.push({ url, options }); return Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }); });
  assert.equal(f.service.status().state, "unconfigured");
  f.service.save({ apiKey: "sk-test-secret-value" });
  assert.equal(f.service.status().state, "configured");
  assert.ok(![...f.values.values()].some(v => v.includes("sk-test-secret-value")));
  f.service.save({ apiKey: "" });
  const status = await f.service.check();
  assert.equal(status.state, "ready");
  assert.doesNotMatch(JSON.stringify(status), /secret-value|Authorization/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/models");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.Authorization, "Bearer sk-test-secret-value");
  f.service.remove();
  assert.equal(f.service.status().apiKeySet, false);
  await assert.rejects(f.service.response("/v1/models"), /API 키를 저장/);
});

test("DeepSeek rejects invalid credentials and destinations before any HTTP request", async () => {
  let requests = 0;
  const { service } = fixture(async () => { requests++; return Response.json({}); });
  for (const value of ["bad\r\nAuthorization: stolen", "short", "a".repeat(5000), 123, null]) assert.throws(() => service.save({ apiKey: value as any }), /API 키/);
  service.save({ apiKey: "sk-test-secret-value" });
  for (const path of ["https://example.com", "/v1/../models", "/v1/videos", "/models?key=x"]) await assert.rejects(service.response(path), /지원하지 않는/);
  await assert.rejects(service.response("/v1/models", {}), /지원하지 않는/);
  assert.equal(requests, 0);
});

test("DeepSeek error/status never exposes upstream bodies or transport credentials", async () => {
  for (const status of [400, 401, 402, 429, 500]) {
    const { service } = fixture(async () => Response.json({ error: { message: "sk-test-secret-value prompt private" } }, { status }));
    service.save({ apiKey: "sk-test-secret-value" });
    const checked = await service.check();
    assert.equal(checked.state, "error");
    assert.match(checked.error!, new RegExp(String(status)));
    assert.doesNotMatch(JSON.stringify(checked), /sk-test|prompt private/);
  }
  const { service } = fixture(async () => { throw new Error("sk-test-secret-value"); });
  service.save({ apiKey: "sk-test-secret-value" });
  assert.doesNotMatch(JSON.stringify(await service.check()), /sk-test-secret-value/);
  const malformed = fixture(async () => new Response("sk-test-secret-value"));
  malformed.service.save({ apiKey: "sk-test-secret-value" });
  assert.doesNotMatch(JSON.stringify(await malformed.service.check()), /sk-test-secret-value/);
});

test("an old credential check cannot restore removed credentials or readiness", async () => {
  let respond!: (response: Response) => void;
  const { service } = fixture(() => new Promise(resolve => { respond = resolve; }));
  service.save({ apiKey: "sk-test-secret-value" });
  const pending = service.check();
  service.remove();
  respond(Response.json({ data: [{ id: "deepseek-flash" }] }));
  assert.deepEqual(await pending, { apiKeySet: false, state: "unconfigured", models: [] });
  assert.equal(service.status().state, "unconfigured");
});

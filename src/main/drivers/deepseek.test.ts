import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekService } from "../deepseek";
import { ChatCompletionDriver, type StudioMessage } from "./aistudio";

function completion(reasoning: string, content: string, call?: { name: string; args: unknown }) {
  const frames = [
    { choices: [{ delta: { reasoning_content: reasoning.slice(0, 3) } }] },
    { choices: [{ delta: { reasoning_content: reasoning.slice(3), content, ...(call ? { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) } }] },
    { choices: [{ delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_cache_hit_tokens: 3 } },
  ];
  return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

test("DeepSeek coding loop preserves reasoning and tool output through resume, records tokens, and offers no video", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cbx-deepseek-tools-"));
  writeFileSync(join(cwd, "sum.cjs"), "module.exports = (a,b) => a-b;\n");
  const events: any[] = [], requests: any[] = [], approvals: any[] = [];
  let history: StudioMessage[] = [];
  const responses = [
    completion("Check and repair the fixture.", "", { name: "edit_file", args: { path: "sum.cjs", old_string: "a-b", new_string: "a+b" } }),
    completion("Run the assertion.", "", { name: "run_command", args: { command: "node -e \"require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)\"" } }),
    completion("The assertion passed.", "수정과 테스트 완료"),
    completion("Keep the earlier result.", "이전 수정 내용을 기억합니다"),
  ];
  const values = new Map<string, string>([["deepseekApiKey", "encrypted"]]);
  const service = new DeepSeekService({ getSetting: k => values.get(k), setSetting: (k, v) => { values.set(k, v); } }, { encrypt: () => "encrypted", decrypt: () => "sk-test-key" }, async (url, options) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "deepseek-flash" }] });
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    requests.push(JSON.parse(String(options?.body)));
    const next = responses.shift(); assert.ok(next); return next;
  });
  const host: any = { emit: (e: any) => events.push(e), nativeId() {}, approve: async (input: any) => { approvals.push(input); return { verdict: "allow" }; } };
  const env = { service, provider: "deepseek" as const, context: { load: () => history, save: (value: StudioMessage[]) => { history = structuredClone(value); } } };
  const opts = { cwd, model: "deepseek-flash", nativeId: null, exePath: "", effort: "max" };
  let driver = new ChatCompletionDriver(opts, env, host);
  try {
    await driver.send({ text: "Fix sum and test it", attachments: [] }); await (driver as any).task;
    assert.equal(driver.agent, "deepseek");
    assert.match(readFileSync(join(cwd, "sum.cjs"), "utf8"), /a\+b/);
    assert.match(events.find(e => e.type === "tool_result" && e.output.includes("exit_code"))?.output, /exit_code: 0/);
    assert.equal(approvals.length, 2);
    assert.equal(events.at(-1).ok, true);
    assert.deepEqual(requests[0].thinking, { type: "enabled" });
    assert.equal(requests[0].reasoning_effort, "max");
    assert.ok(requests[0].tools.every((t: any) => !/video|image/.test(t.function.name)));
    assert.equal(requests[1].messages.find((m: any) => m.role === "assistant").reasoning_content, "Check and repair the fixture.");
    assert.equal(events.findLast(e => e.type === "agent_usage").metrics.cachedInputTokens, 9);
    assert.ok(events.filter(e => e.type === "text_delta" || e.type === "text").every(e => !e.text.includes("Check and repair")));
    await driver.dispose();
    driver = new ChatCompletionDriver(opts, env, host);
    await driver.send({ text: "Remember that change", attachments: [] }); await (driver as any).task;
    const previous = requests[3].messages.filter((m: any) => m.role === "assistant");
    assert.equal(previous.length, 3);
    assert.ok(previous.every((m: any) => typeof m.reasoning_content === "string" && m.reasoning_content.length > 0));
    assert.ok(requests[3].messages.some((m: any) => m.role === "tool" && /exit_code: 0/.test(m.content)));
    assert.equal(events.at(-1).ok, true);
  } finally { await driver.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("explicit read-only DeepSeek driver is tool-less and thinking can be disabled", async () => {
  let sent: any;
  const service: any = { settings: () => ({ model: "deepseek-flash", videoEnabled: false }), json: async () => ({ data: [{ id: "deepseek-flash" }] }), response: async (_: string, body: any) => { sent = body; return completion("", '{"decision":"deny"}'); } };
  const events: any[] = [];
  const driver = new ChatCompletionDriver({ cwd: process.cwd(), nativeId: null, exePath: "", readOnly: true, effort: "none" }, { service, provider: "deepseek" }, { emit: e => events.push(e), nativeId() {}, approve: async () => { throw new Error("no tools allowed"); } });
  try {
    await driver.send({ text: "Judge an action", attachments: [] }); await (driver as any).task;
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.thinking, { type: "disabled" });
    assert.equal(sent.reasoning_effort, undefined);
    assert.equal(events.at(-1).ok, true);
  } finally { await driver.dispose(); }
});

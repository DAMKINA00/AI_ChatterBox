import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { GrokDriver, grokModels, listGrokModels } from "./grok";

function fixture(options = {}) {
  const events: any[] = [], approvals: any[] = [];
  const host = { emit: (e: any) => events.push(e), nativeId() {}, approve: async (a: any) => { approvals.push(a); return { verdict: "allow" as const }; } };
  const driver = new GrokDriver({ cwd: process.cwd(), nativeId: "s1", exePath: "grok.exe", ...options }, () => ({}), host);
  (driver as any)._running = true;
  const call = (toolName: string, toolInput = {}, extra = {}) => driver.hook({ sessionId: "s1", hookCallbackId: "chatterbox-approval", hookEventName: "pre_tool_use", toolUseId: "t1", toolName, toolInput, ...extra });
  return { driver, host, events, approvals, call };
}

test("Grok model catalog preserves actual model and reasoning choices", () => {
  assert.deepEqual(grokModels({ currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEfforts: [{ value: "high" }, { value: "xhigh" }], reasoningEffort: "high" } }] }), [
    { id: "grok-4.6", label: "Grok 4.6", isDefault: true, reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" },
  ]);
  assert.deepEqual(grokModels(null), []);
});

test("Grok all tools use session-bound approval, including images and edits", async () => {
  const f = fixture();
  assert.equal((await f.call("search_replace", { file_path: "src/a.ts", old_string: "a", new_string: "b" })).decision, "continue");
  assert.equal(f.approvals[0].writes, true);
  for (const name of ["image_gen", "image_edit"]) {
    assert.equal((await f.call(name, { prompt: "flower" })).decision, "continue");
    assert.equal(f.approvals.at(-1).writes, false);
  }
  assert.equal((await f.call("bash", { command: "npm test" }, { sessionId: "another" })).decision, "deny");
  await f.call("image_gen", { output_path: "images/flower.png" });
  assert.equal(f.approvals.at(-1).writes, true);
  assert.equal((await f.call("bash", { command: "npm test" }, { toolInputTruncated: true })).decision, "deny");
  assert.equal((await f.call("task")).decision, "deny");
  (f.driver as any).noWrites = true;
  assert.equal((await f.call("image_gen")).decision, "deny");
  assert.equal((await f.call("search_replace", { file_path: "a" })).decision, "deny");
  assert.equal((await f.call("bash", { command: "git status; del a" })).decision, "deny");
  assert.equal((await f.call("list_dir", { path: "." })).decision, "continue");
  assert.equal((await f.call("mcp__chatterbox_bridge__send_message", { to: "w2", message: "contract" })).decision, "continue");
  const judge = fixture({ readOnly: true });
  assert.equal((await judge.call("mcp__chatterbox_bridge__ask")).decision, "deny");
  const master = fixture({ allowImages: false });
  assert.equal((await master.call("image_edit")).decision, "deny");
});

test("Grok permission cannot execute without its approved tool and session", async () => {
  const f = fixture();
  const request = (sessionId = "s1", toolCallId = "t1") => (f.driver as any).incoming({ method: "session/request_permission", params: {
    sessionId, toolCall: { toolCallId }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }],
  } });
  assert.equal((await request()).outcome.optionId, "no");
  await f.call("bash", { command: "git status" });
  assert.equal((await request()).outcome.optionId, "yes");
  assert.equal((await request("other")).outcome.optionId, "no");
  assert.equal((await request("s1", "unknown")).outcome.optionId, "no");
  f.driver.onUpdate({ sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
  assert.equal((await request()).outcome.optionId, "no");
});

test("Grok rejects failed, malformed and stale approval callbacks", async () => {
  const f = fixture();
  f.host.approve = async () => { throw new Error("approval unavailable"); };
  assert.equal((await f.call("bash", { command: "git status" })).decision, "deny");
  assert.equal((await (f.driver as any).incoming({ method: "x.ai/hooks/run", params: null })).decision, "deny");
  let resolve!: (v: any) => void;
  f.host.approve = () => new Promise(r => { resolve = r; });
  const waiting = f.call("bash", { command: "git status" });
  await f.driver.stop();
  (f.driver as any)._running = true; // a later turn must not revive the old callback
  resolve({ verdict: "allow" });
  assert.equal((await waiting).decision, "deny");
  assert.deepEqual(f.events.filter(e => e.type === "turn_end"), [{ type: "turn_end", ok: false, error: undefined, interrupted: true }]);
});

/** In-memory ACP peer exercises actual serialized transport without login or inference. */
function fakeAcp(auth = true) {
  const requests: any[] = [], children: any[] = [];
  const patched = mock.method(childProcess, "spawn", (_exe: any, args: any) => {
    assert.ok(args.includes("--no-subagents"));
    const child: any = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    children.push(child);
    child.stdin.on("finish", () => { child.exitCode = 0; child.stdout.end(); child.emit("exit", 0); });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const req = JSON.parse(line); requests.push(req);
        if (!req.id) continue;
        const modelState = { currentModelId: "grok-test", availableModels: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ value: "high" }] } }] };
        let result: any = {};
        if (req.method === "initialize") result = { agentCapabilities: { _meta: { "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny"] } } }, _meta: { defaultAuthMethodId: auth ? "cached_token" : null, modelState } };
        if (req.method === "x.ai/models/list") result = { result: modelState };
        if (["session/new", "session/load"].includes(req.method)) result = { sessionId: "native-grok", models: modelState };
        queueMicrotask(() => {
          if (req.method === "session/prompt") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-grok", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Grok result" } } } }) + "\n");
            result = { stopReason: "end_turn" };
          }
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
        });
      }
    });
    return child;
  });
  return { requests, children, close: () => patched.mock.restore() };
}

test("Grok ACP opens/resumes sessions, configures hooks/MCP/model and delivers one completion", async () => {
  const rpc = fakeAcp();
  const events: any[] = [], ids: string[] = [];
  const driver = new GrokDriver({ exePath: "fake", cwd: process.cwd(), nativeId: null, effort: "high", instructions: "team rules" },
    () => ({ chatterbox_bridge: { command: "bridge.exe", args: ["role-bound"], env: { ROLE: "w1" } } }),
    { emit: e => events.push(e), nativeId: id => ids.push(id), approve: async () => ({ verdict: "deny" }) });
  try {
    assert.equal((await listGrokModels("fake", process.cwd()))[0].id, "grok-test");
    await driver.send({ text: "part one", attachments: [] });
    await new Promise(r => setImmediate(r));
    assert.equal(events.filter(e => e.type === "turn_end").length, 1);
    assert.equal(events.at(-1).ok, true);
    const session = rpc.requests.find(r => r.method === "session/new").params;
    assert.deepEqual(session._meta["x.ai/hooks"].PreToolUse[0].hookCallbackIds, ["chatterbox-approval"]);
    assert.equal(session.mcpServers[0].name, "chatterbox_bridge");
    assert.equal(rpc.requests.find(r => r.method === "session/set_model").params._meta.reasoningEffort, "high");
    await driver.stop();
    await driver.send({ text: "part two", attachments: [] });
    await new Promise(r => setImmediate(r));
    assert.equal(rpc.requests.find(r => r.method === "session/load").params.sessionId, "native-grok");
    assert.deepEqual(ids, ["native-grok", "native-grok"]);
    assert.equal(events.filter(e => e.type === "turn_end").length, 2);
  } finally { await driver.dispose(); rpc.close(); }
  assert.ok(rpc.children.every(c => c.exitCode === 0));
});

test("Grok without cached login exits before creating a session or prompt", async () => {
  const rpc = fakeAcp(false);
  const driver = new GrokDriver({ exePath: "fake", cwd: process.cwd(), nativeId: null }, () => ({}), { emit() {}, nativeId() {}, approve: async () => ({ verdict: "deny" }) });
  try {
    await assert.rejects(driver.send({ text: "never sent", attachments: [] }), /grok login/);
    assert.equal(driver.running, false);
    assert.equal(rpc.requests.some(r => r.method === "session/prompt" || r.method === "session/new"), false);
    assert.ok(rpc.children.every(c => c.exitCode === 0));
  } finally { await driver.dispose(); rpc.close(); }
});

test("stale Grok startup failure cannot close a replacement turn", async () => {
  const f = fixture();
  (f.driver as any)._running = false;
  let release!: () => void, starts = 0, closed = 0;
  const delayed = new Promise<void>(r => { release = r; });
  (f.driver as any).start = async () => {
    if (++starts === 1) { await delayed; throw new Error("old startup failed"); }
    (f.driver as any).connection = { request: () => new Promise(() => {}), notify() {}, close: async () => { closed++; } };
  };
  const old = f.driver.send({ text: "old", attachments: [] });
  await f.driver.stop();
  await f.driver.send({ text: "new", attachments: [] });
  release(); await old;
  assert.equal(f.driver.running, true);
  assert.equal(closed, 0);
  await f.driver.stop();
  assert.equal(closed, 1);
});

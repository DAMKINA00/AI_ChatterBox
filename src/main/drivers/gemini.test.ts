import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { GeminiDriver } from "./gemini";
import { geminiTokens, tokenDelta, parseGeminiModels, geminiBridgeTool, normalizeGeminiTool } from "./gemini-protocol";

function fixture() {
  const events: any[] = [], approvals: any[] = [];
  let verdict = "allow";
  const driver = new GeminiDriver({ cwd: process.cwd(), nativeId: null, exePath: "unused" }, { bridge: {} as any, hookScript: "unused", tmpDir: process.cwd() }, {
    nativeId() {}, emit: (event) => events.push(event), approve: async (input) => { approvals.push(input); return { verdict: verdict as any }; },
  });
  (driver as any)._running = true;
  (driver as any).hooksReady = true;
  return { driver, events, approvals, verdict: (v: string) => { verdict = v; },
    call: (name: string, args: any = {}) => driver.hook("pre", { toolCall: { name, args }, conversationId: "test", stepIdx: events.length }),
  };
}

test("Gemini account models exclude Ultra-only, locked and non-Gemini choices", () => {
  const list = parseGeminiModels(`Fetching available models...
gemini-3.1-pro-high    Gemini 3.1 Pro (High)
gemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)
gemini-3.8-flash-medium    Gemini 3.8 Flash (Medium)
gemini-4-argon-high    Gemini 4 Argon (High)
gemini-3.8-flash-high    Gemini 3.8 Flash (High) [Upgrade required]
claude-opus-5.5    Claude Opus 5.5`);
  assert.equal(list.length, 3);
  assert.equal(list.find((m) => m.isDefault)?.id, "gemini-3.8-flash-medium");
  assert.deepEqual(parseGeminiModels("Please sign in"), []);
});

test("Gemini usage subtracts cumulative session counters including thinking and cache", () => {
  const first = geminiTokens({ input_tokens: 100, output_tokens: 20, thinking_tokens: 4, cache_read_tokens: 50 });
  const second = geminiTokens({ input_tokens: 160, output_tokens: 28, thinking_tokens: 7, cache_read_tokens: 90 });
  assert.deepEqual(tokenDelta(second, first), { inputTokens: 60, outputTokens: 11, cachedInputTokens: 40, cacheWriteInputTokens: 0 });
  assert.deepEqual(geminiTokens({ output_tokens: -10, input_tokens: Infinity }), geminiTokens(null));
});

test("Gemini prose worker rejects file mutations before approval", async () => {
  const f = fixture();
  const args = { TargetFile: "gemini-test-only.txt", CodeContent: "example" };
  assert.equal((await f.call("write_to_file", args)).decision, "deny");
  assert.equal(f.approvals.length, 0);
});

test("Gemini writing rejects writes and compound shell but permits reading reference material through app", async () => {
  const f = fixture(); (f.driver as any).noWrites = true;
  assert.equal((await f.call("write_to_file", { TargetFile: "a", CodeContent: "b" })).decision, "deny");
  assert.equal((await f.call("run_command", { CommandLine: "Get-Content a; Set-Content a changed" })).decision, "deny");
  assert.equal((await f.call("run_command", { CommandLine: "git status" })).decision, "auto_approve");
  assert.equal(f.approvals.length, 1);
});

test("Gemini normalizes read, write and command aliases before approval", async () => {
  const f = fixture();
  const cwd = process.cwd();

  assert.equal((await f.call("read_file", { path: "docs/reference.md" })).decision, "auto_approve");
  const read = f.approvals[0];
  assert.equal(read.key, "view_file");
  assert.deepEqual(read.paths, [resolve(cwd, "docs/reference.md")]);
  assert.equal(read.readOnly, true);
  assert.equal(read.writes, false);
  assert.equal(JSON.parse(read.detail).AbsolutePath, "docs/reference.md");

  (f.driver as any).noWrites = false;
  assert.equal((await f.call("write_file", { path: "empty.txt", content: "" })).decision, "auto_approve");
  const write = f.approvals[1];
  assert.equal(write.key, "write_to_file");
  assert.deepEqual(write.paths, [resolve(cwd, "empty.txt")]);
  assert.equal(write.writes, true);
  assert.equal(write.readOnly, false);
  assert.deepEqual(JSON.parse(write.detail), { path: "empty.txt", content: "", TargetFile: "empty.txt", CodeContent: "" });

  assert.equal((await f.call("run_command", { command: "git status", cwd: "src" })).decision, "auto_approve");
  const command = f.approvals[2];
  assert.equal(command.key, "run_command");
  assert.equal(command.command, "git status");
  assert.deepEqual(command.paths, [resolve(cwd, "src")]);
  assert.equal(command.detail, "git status");
  assert.deepEqual(normalizeGeminiTool("run_command", { command: "git status", cwd: "src" }), {
    name: "run_command",
    args: { command: "git status", cwd: "src", CommandLine: "git status", Cwd: "src" },
  });
});

test("Gemini denies normalized write aliases in no-writes mode before approval", async () => {
  const f = fixture();
  assert.equal((await f.call("write_file", { path: "a.txt", content: "" })).decision, "deny");
  assert.equal(f.approvals.length, 0);
});

test("Gemini rejects conflicting aliases and invalid alias types before approval", async () => {
  const f = fixture();
  const invalid = [
    ["read_file", { path: "a.txt", file_path: "b.txt" }],
    ["write_file", { path: "a.txt", absolute_path: "b.txt", content: "x" }],
    ["run_command", { command: "git status", cwd: "src", working_directory: "other" }],
    ["read_file", { path: 42 }],
    ["write_file", { path: "a.txt", content: 42 }],
    ["run_command", { command: 42 }],
  ] as const;
  for (const [name, args] of invalid) assert.equal((await f.call(name, args)).decision, "deny", `${name} should be denied`);
  assert.equal(f.approvals.length, 0);
});

test("Gemini remains denied while stopping, including normalized aliases", async () => {
  const f = fixture();
  (f.driver as any).stopping = true;
  assert.equal((await f.call("read_file", { path: "a.txt" })).decision, "deny");
  assert.equal((await f.call("run_command", { command: "git status" })).decision, "deny");
  assert.equal(f.approvals.length, 0);
});

test("project_graph is accepted only through the ChatterBox bridge", async () => {
  const f = fixture();
  assert.equal((await f.call("project_graph", {})).decision, "deny");
  assert.equal(f.approvals.length, 0);
  assert.equal((await f.call("mcp__chatterbox_bridge__project_graph", {})).decision, "auto_approve");
  assert.equal((await f.call("call_mcp_tool", { ServerName: "chatterbox_bridge", ToolName: "project_graph", Arguments: {} })).decision, "auto_approve");
  assert.equal(f.approvals.length, 0);
});

test("Antigravity allows explicitly assigned writes only after app approval", async () => {
  const f = fixture();
  (f.driver as any).noWrites = false;
  assert.equal((await f.call("write_to_file", { TargetFile: "a.txt", CodeContent: "hello" })).decision, "auto_approve");
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].writes, true);
  f.verdict("deny");
  assert.equal((await f.call("generate_image", { Prompt: "a flower" })).decision, "deny");
  const instructions = await f.driver.hook("instructions", {});
  assert.match(JSON.stringify(instructions), /협업은 앱 chatterbox_bridge/);
  assert.doesNotMatch(JSON.stringify(instructions), /글쓰기 전용/);
});

test("Gemini blocks native subagents, arbitrary MCP and tools after stop", async () => {
  const f = fixture();
  for (const name of ["invoke_subagent", "define_subagent", "send_message", "schedule", "ask_permission", "generate_image", "mcp__other__write", "unknown"])
    assert.equal((await f.call(name)).decision, "deny");
  assert.equal(geminiBridgeTool("mcp__chatterbox_bridge__set_expression"), true);
  assert.equal(geminiBridgeTool("mcp__chatterbox_bridge__spawn"), true);
  assert.equal(geminiBridgeTool("call_mcp_tool", { ServerName: "chatterbox_bridge", ToolName: "set_expression" }), true);
  assert.equal(geminiBridgeTool("call_mcp_tool", { ServerName: "other", ToolName: "set_expression" }), false);
  assert.equal(geminiBridgeTool("call_mcp_tool", { ServerName: "chatterbox_bridge", ToolName: "spawn" }), true);
  assert.equal((await f.call("mcp__chatterbox_bridge__set_expression", { expression: "neutral" })).decision, "auto_approve");
  (f.driver as any).stopping = true;
  assert.equal((await f.call("run_command", { CommandLine: "git status" })).decision, "deny");
  assert.equal(f.approvals.length, 0);
});

test("Gemini approval outstanding at stop cannot later execute", async () => {
  const f = fixture();
  let finish!: (v: any) => void;
  (f.driver as any).host.approve = () => new Promise((r) => { finish = r; });
  const pending = f.call("run_command", { CommandLine: "git status" });
  (f.driver as any).stopping = true;
  finish({ verdict: "allow" });
  assert.equal((await pending).decision, "deny");
});

test("Gemini can monitor asynchronous commands but cannot inject terminal input", async () => {
  const f = fixture();
  (f.driver as any).noWrites = true;
  assert.equal((await f.call("manage_task", { Action: "status", TaskId: "task" })).decision, "auto_approve");
  assert.equal(f.approvals[0].readOnly, true);
  assert.equal((await f.call("manage_task", { Action: "send_input", TaskId: "task", Input: "write" })).decision, "deny");
});

test("Gemini stream displays messages once and unsuccessful results never mark done", () => {
  const f = fixture();
  f.driver.onEvent({ event: "step_update", step_update: { step_type: "agent_response", step_index: 2, state: "ACTIVE", text_delta: "hello" } });
  f.driver.onEvent({ event: "step_update", step_update: { step_type: "agent_response", step_index: 2, state: "DONE", text_delta: "!" } });
  f.driver.onEvent({ event: "result", result: { status: "SUCCESS", response: "hello!", usage: { output_tokens: 3 } } });
  f.driver.onEvent({ event: "result", result: { status: "SUCCESS", response: "hello!" } });
  assert.equal(f.events.filter((e) => e.type === "text").length, 1);
  assert.equal(f.events.filter((e) => e.type === "turn_end").length, 1);
  assert.equal(f.events.at(-1).ok, true);
  const failed = fixture();
  failed.driver.onEvent({ event: "result", result: { status: "ERROR", error: "quota exhausted" } });
  assert.equal(failed.events.at(-1).ok, false);
});

test("Gemini refuses action when hook startup handshake is absent", async () => {
  const f = fixture(); (f.driver as any).hooksReady = false;
  assert.equal((await f.call("run_command", { CommandLine: "git status" })).decision, "deny");
  assert.equal(f.approvals.length, 0);
  f.driver.onEvent({ event: "result", result: { status: "SUCCESS", response: "done" } });
  assert.equal(f.events.at(-1).ok, false);
});

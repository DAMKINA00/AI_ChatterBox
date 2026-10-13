import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexDriver } from "./codex";
import { ClaudeDriver } from "./claude";

const opts = { cwd: process.cwd(), nativeId: null, exePath: "unused" };
function codex(readOnly = false) {
  const calls: { method: string; params: any }[] = [], replies: any[] = [], events: any[] = [], inputs: any[] = [];
  let approvals = 0;
  const server: any = { loaded: new Set(), ensure: async () => {}, attach() {}, detach() {},
    request: async (method: string, params: any) => { calls.push({ method, params }); return { thread: { id: "thread" }, turn: { id: "turn" } }; },
    respond: (id: unknown, value: unknown) => replies.push({ id, value }),
  };
  const driver = new CodexDriver({ ...opts, readOnly }, server, { nativeId() {}, emit: (e) => events.push(e), approve: async (input) => { inputs.push(input); approvals++; return { verdict: "allow_chat" }; } });
  return { driver, calls, replies, events, inputs, get approvals() { return approvals; } };
}

test("Codex every execution role can request approval; plan restriction resets on next ordinary turn", async () => {
  const f = codex();
  await f.driver.send({ text: "plan", attachments: [], noWrites: true });
  assert.equal(f.calls[0].params.approvalPolicy, "on-request");
  assert.equal(f.calls[0].params.approvalsReviewer, "user");
  assert.equal(f.calls.at(-1)!.params.approvalPolicy, "never");
  f.driver.onNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } } as any);
  await f.driver.send({ text: "implement", attachments: [] });
  assert.equal(f.calls.at(-1)!.params.approvalPolicy, "on-request");
  assert.equal(f.calls.at(-1)!.params.approvalsReviewer, "user");
  assert.equal(f.calls.at(-1)!.params.sandboxPolicy.type, "readOnly");
});

test("Codex judge disables executable tools and cannot escalate", async () => {
  const f = codex(true);
  await f.driver.send({ text: "judge", attachments: [] });
  const start = f.calls.find((c) => c.method === "thread/start")!.params;
  assert.equal(start.approvalPolicy, "never");
  for (const name of ["shell_tool", "multi_agent", "apps", "plugins", "browser_use", "computer_use"])
    assert.equal(start.config[`features.${name}`], false);
  assert.equal(start.config.web_search, "disabled");
});

test("Codex never grants session-wide native approval that bypasses changed app settings", async () => {
  const f = codex();
  f.driver.onServerRequest({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "npm test", threadId: "thread" } } as any);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.approvals, 1);
  assert.deepEqual(f.replies[0].value, { decision: "accept" });
  f.driver.onServerRequest({ id: 2, method: "item/permissions/requestApproval", params: {} } as any);
  assert.deepEqual(f.replies[1].value, { permissions: {}, scope: "turn" });
});

test("Claude readonly turns deny edits and shell mutations even when host would approve", async () => {
  let approvals = 0;
  const driver: any = new ClaudeDriver({ ...opts, readOnly: true }, {} as any, { emit() {}, nativeId() {}, approve: async () => { approvals++; return { verdict: "allow" }; } });
  for (const req of [{ tool_name: "Write", input: { file_path: "a", content: "x" } }, { tool_name: "Bash", input: { command: "touch a" } }])
    assert.equal((await driver.onPermission(req)).behavior, "deny");
  assert.equal(approvals, 0);
});

test("Codex patch approval checks actual changed files rather than the grant root", async () => {
  const f = codex();
  f.driver.onNotification({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { type: "fileChange", id: "patch", status: "inProgress", changes: [{ path: "src/a.ts", kind: { type: "add" }, diff: "+a" }] } } } as any);
  f.driver.onServerRequest({ method: "item/fileChange/requestApproval", id: 3, params: { threadId: "thread", itemId: "patch", grantRoot: opts.cwd } } as any);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.inputs[0].paths, ["src/a.ts"]);
  assert.equal(f.inputs[0].writes, true);
  assert.equal(f.events[0].type, "tool_call");
});

test("Codex rename approval includes the destination path", async () => {
  const f = codex();
  const item = { type: "fileChange", id: "rename", status: "inProgress", changes: [{ path: "src/a.ts", kind: { type: "update", move_path: "../outside.ts" }, diff: "+a" }] };
  f.driver.onNotification({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } } as any);
  f.driver.onServerRequest({ method: "item/fileChange/requestApproval", id: 4, params: { threadId: "thread", itemId: "rename", grantRoot: opts.cwd } } as any);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.inputs[0].paths, ["src/a.ts", "../outside.ts"]);
  assert.equal(f.inputs[0].diffs[0].movePath, "../outside.ts");
});

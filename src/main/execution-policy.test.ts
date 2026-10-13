import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadCommand, isMutatingTool } from "./execution-policy";
import { Orchestrator } from "./orchestrator";
import { ChatManager } from "./chats";

test("planning command gate rejects composition and executable read options", () => {
  for (const command of ["git status --short", "rg name src", "Get-Content README.md", "pwd"])
    assert.equal(isReadCommand(command), true, command);
  for (const command of ["git push", "git diff --output=out.txt", "rg --pre=node x", "Get-Content (Set-Content x y)", "pwd; del a", "cat x > y", "npm test"])
    assert.equal(isReadCommand(command), false, command);
  assert.equal(isMutatingTool("Bash", "npm test"), true);
  assert.equal(isMutatingTool("Read", "a.txt"), false);
});

function engine() {
  const chats: any = { store: { chat: () => ({ id: 1 }), listAgents: () => [] }, emit() {}, route: (_id: number, role: string) => role };
  const orchestrator: any = new Orchestrator(chats);
  return { chats, orchestrator };
}
const write: any = { role: "orch", node: "orch", title: "Write", detail: "a", key: "Write", writes: true, paths: ["a"] };

test("master and worker implementation cannot overlap while native change is in flight", async () => {
  const { chats, orchestrator: o } = engine();
  chats.onDriverEvent(1, "orch", { type: "tool_call", id: "patch", name: "파일 변경", input: "a" });
  let acquired = false;
  const waiting = o.acquireScope(1, 10, ["src/**"]).then(() => { acquired = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(acquired, false);
  chats.onDriverEvent(1, "orch", { type: "tool_result", id: "patch", ok: true, output: "done" });
  await waiting;
  assert.ok(chats.approvalGuard(1, write));
  o.releaseScope(1, 10);
  assert.equal(chats.approvalGuard(1, write), null);
});

test("plan, master review, worker review and idle workers cannot mutate", () => {
  const { chats, orchestrator: o } = engine();
  o.planning.add(1);
  assert.ok(chats.approvalGuard(1, write));
  o.planning.clear(); o.reviewing.add(1);
  assert.ok(chats.approvalGuard(1, { ...write, writes: false, command: "npm run build" }));
  o.reviewing.clear();
  assert.ok(chats.approvalGuard(1, { ...write, role: "w1" }));
  o.running.set(1, new Map([["w1", { kind: "review" }]]));
  assert.ok(chats.approvalGuard(1, { ...write, role: "w1" }));
  o.running.set(1, new Map([["w1", { kind: "implement", scope: ["src/**"] }]]));
  assert.equal(chats.approvalGuard(1, { ...write, role: "w1" }), null);
});

test("expression tool is bound to its calling role and rejects unknown expressions", async () => {
  const { chats, orchestrator: o } = engine();
  const events: any[] = [];
  chats.emit = (...args: unknown[]) => events.push(args);
  await o.call(1, "w2", "set_expression", { expression: "happy", role: "orch" });
  assert.equal(events[0][2], "w2");
  assert.equal(events[0][3].expression, "happy");
  const bad = await o.call(1, "orch", "set_expression", { expression: "success" });
  assert.equal(bad.isError, true);
  assert.equal(events.length, 1);
});

test("failed master startup ends the review restriction and permits a later ordinary turn", async () => {
  const { chats, orchestrator: o } = engine();
  const events: any[] = [];
  chats.store.attachmentsFor = () => [];
  chats.store.hasUserEvent = () => true;
  chats.store.addEvent = () => ({});
  chats.store.linkAttachments = () => undefined;
  chats.sink = { event() {} };
  chats.updateChat = () => undefined;
  chats.orchTurnEnded = () => undefined;
  let disposed = false;
  chats.disposeRole = async () => { disposed = true; };
  chats.emit = (...args: any[]) => events.push(args[3]);
  o.reviewing.add(1);
  await ChatManager.prototype.startTurn.call(chats, 1, "/review", [], async () => { throw new Error("CLI missing"); });
  assert.equal(disposed, true);
  assert.ok(events.some((event) => event.type === "turn_end" && event.ok === false));
  assert.equal(chats.approvalGuard(1, write), null);
});

test("resuming an interrupted plan or review after restart preserves the no-write restriction", async () => {
  for (const command of ["/plan change a file", "/review"]) {
    const { chats, orchestrator: o } = engine();
    chats.store.chat = () => ({ id: 1, status: "interrupted" });
    chats.store.events = () => [{ event: { type: "user", text: command } }];
    chats.updateChat = () => undefined;
    o.handover = () => "";
    let input: any;
    chats.driver = async () => ({ send: async (value: any) => { input = value; } });
    await o.resume(1);
    assert.equal(input.noWrites, true, command);
    assert.ok(chats.approvalGuard(1, write), command);
  }
});

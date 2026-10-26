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
  assert.equal(isMutatingTool("run_command", JSON.stringify({ command: "Get-Content a.txt" })), false);
  assert.equal(isMutatingTool("run_command", JSON.stringify({ command: "Set-Content a.txt x" })), true);
  assert.equal(isMutatingTool("run_command", "broken JSON"), true);
  for (const tool of ["write_file", "edit_file", "save_video"]) assert.equal(isMutatingTool(tool, "{}"), true);
});

function engine() {
  const chats: any = { store: { chat: () => ({ id: 1 }), listAgents: () => [], events: () => [], listConsults: () => [], getSetting: () => undefined, setSetting() {} }, emit() {}, route: (_id: number, role: string) => role };
  chats.store.project = () => ({ settings: {} });
  chats.roleAccount = () => null;
  chats.runningAccount = () => undefined;
  chats.listCliAccounts = () => [];
  chats.resolveAccountPolicy = (kind: string) => ({ kind, mode: "fixed", accountId: `${kind}-1`, source: "default" });
  chats.assignmentEffort = async () => ({ requestedEffort: "medium", effort: "medium" });
  const orchestrator: any = new Orchestrator(chats);
  return { chats, orchestrator };
}
const write: any = { role: "orch", node: "orch", title: "Write", detail: "a", key: "Write", writes: true, paths: ["a"] };

test("AI Studio model switches hand over context without mixing model histories", () => {
  const { chats, orchestrator: o } = engine();
  const settings = new Map<string, string>();
  chats.store.getSetting = (key: string) => settings.get(key);
  chats.store.setSetting = (key: string, value: string) => settings.set(key, value);
  chats.store.project = () => ({ settings: { orchestratorModel: "gemini:aistudio:previous-model" } });
  chats.store.events = () => [{ role: "orch", event: { type: "text", text: "previous verified result" } }];
  const chat = { id: 1, projectId: 1, orchestratorModelOverride: null };
  assert.equal(o.handover(chat), "");
  const studio = { ...chat, orchestratorModelOverride: "gemini:aistudio:gemini-4-argon" };
  assert.match(o.handover(studio), /previous verified result/);
  assert.equal(o.handover(studio), "");
  assert.match(o.handover({ ...studio, orchestratorModelOverride: "gemini:aistudio:another-model" }), /previous verified result/);
  assert.match(o.handover(chat), /previous verified result/);
});

test("a successful CLI exit without a worker answer or artifact is not a completed consult", async () => {
  for (const [answer, files, expected] of [["  ", [], "error"], ["", ["diagram.png"], "done"], ["Analysis result", [], "done"]] as const) {
    const { chats, orchestrator: o } = engine();
    let finished: any;
    chats.store.project = () => ({ settings: {} });
    chats.store.createConsult = () => ({ id: 1 });
    chats.store.finishConsult = (_id: number, status: string, summary: string) => (finished = { status, summary });
    chats.sink = { consult() {} };
    chats.agentsChanged = () => undefined;
    chats.setRoute = () => undefined;
    let archived = false;
    chats.archiveWorker = async () => { archived = true; };
    o.attachmentsFor = () => [];
    chats.driver = async () => ({ send: async () => {
      chats.onDriverEvent(1, "w1", { type: "text", text: answer });
      for (const path of files) chats.onDriverEvent(1, "w1", { type: "image_generation", status: "done", attachment: { path } });
      chats.onDriverEvent(1, "w1", { type: "turn_end", ok: true });
    } });
    const result = await o.consult(1, "orch", { key: "w1", nickname: "worker" }, "opinion", "analyze", [], [], "source specialist");
    assert.equal(finished.status, expected);
    assert.equal(!!result.isError, expected === "error");
    assert.ok(finished.summary.trim());
    assert.equal(archived, true);
  }
});

test("master and worker implementation cannot overlap while native change is in flight", async () => {
  for (const name of ["파일 변경", "write_file", "edit_file", "run_command", "save_video"]) {
  const { chats, orchestrator: o } = engine();
  chats.onDriverEvent(1, "orch", { type: "tool_call", id: "patch", name, input: JSON.stringify({ command: "Set-Content a.txt x" }) });
  let acquired = false;
  const waiting = o.acquireScope(1, 10, ["src/**"]).then(() => { acquired = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(acquired, false);
  chats.onDriverEvent(1, "orch", { type: "tool_result", id: "patch", ok: true, output: "done" });
  await waiting;
  assert.ok(chats.approvalGuard(1, write));
  o.releaseScope(1, 10);
  assert.equal(chats.approvalGuard(1, write), null);
  }
});

test("worker remains reserved until native archive finishes before its next queued consultation", async () => {
  const { chats, orchestrator: o } = engine();
  let nextId = 0, sends = 0, archives = 0;
  let unblock!: () => void;
  const firstArchive = new Promise<void>((resolve) => { unblock = resolve; });
  chats.store.project = () => ({ settings: {} });
  chats.store.createConsult = () => ({ id: ++nextId });
  chats.store.finishConsult = (_id: number, status: string, summary: string) => ({ status, summary });
  chats.sink = { consult() {} };
  chats.agentsChanged = chats.setRoute = () => undefined;
  chats.archiveWorker = async () => { if (++archives === 1) await firstArchive; };
  o.attachmentsFor = () => [];
  chats.driver = async () => ({ send: async () => {
    sends++;
    chats.onDriverEvent(1, "w1", { type: "text", text: "report" });
    chats.onDriverEvent(1, "w1", { type: "turn_end", ok: true });
  } });
  const run = () => o.consult(1, "orch", { key: "w1", nickname: "worker" }, "opinion", "analyze", [], [], "source specialist");
  const first = run(), second = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(o.running.get(1).has("w1"), true);
  unblock();
  await Promise.all([first, second]);
  assert.equal(sends, 2);
  assert.equal(archives, 2);
  assert.equal(o.running.get(1).has("w1"), false);
});

test("planning and review can mutate; idle, stopped and overlapping work remains blocked", () => {
  const { chats, orchestrator: o } = engine();
  o.planning.add(1);
  assert.equal(chats.approvalGuard(1, write), null);
  o.planning.clear(); o.reviewing.add(1);
  assert.equal(chats.approvalGuard(1, { ...write, writes: false, command: "npm run build" }), null);
  o.reviewing.clear();
  assert.ok(chats.approvalGuard(1, { ...write, role: "w1" }));
  for (const kind of ["review", "opinion", "writing", "implement"]) {
    o.running.set(1, new Map([["w1", { consultId: 10, kind, scope: ["src/**"] }]]));
    assert.equal(chats.approvalGuard(1, { ...write, role: "w1" }), null);
    assert.deepEqual(chats.writeScope(1, "w1").globs, ["src/**"]);
    assert.ok(chats.approvalGuard(1, write));
    o.running.get(1).set("w2", { consultId: 11, kind: "review", scope: ["src/a.ts"] });
    assert.ok(chats.approvalGuard(1, { ...write, role: "w2" }));
    o.running.get(1).get("w2").scope = ["docs/**"];
    assert.equal(chats.approvalGuard(1, { ...write, role: "w2" }), null);
    o.releaseScope(1, 10); o.releaseScope(1, 11);
  }
  o.stopped.add(1);
  assert.ok(chats.approvalGuard(1, write));
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

test("critical routing persists on resume, cannot be downgraded, and gates writes and implementation", async () => {
  const { chats, orchestrator: o } = engine();
  const events: any[] = [{ id: 17, event: { type: "user", text: "critical fault" } }];
  chats.emit = (_id: number, _node: string, _role: string, event: any) => events.push({ id: events.length + 18, event });
  chats.store.events = () => events;
  chats.store.listAgents = () => [
    { key: "w1", kind: "claude", nickname: "클로드 1호", status: "active" },
    { key: "w2", kind: "gpt", nickname: "지피티 1호", status: "active" },
  ];
  chats.teamCapabilities = async () => ({});
  const reports: any[] = [];
  chats.store.listConsults = () => reports;
  o.instructions.set(1, { id: 17 });
  const route = (args: any) => o.call(1, "orch", "route_request", { mode: "delegated", reason: "safety fault", ...args });
  assert.equal((await route({ dualInvestigation: "true" })).isError, true);
  assert.equal((await route({ dualInvestigation: true, mode: "direct" })).isError, true);
  assert.ok(!(await route({ dualInvestigation: true })).isError);
  assert.ok(!(await route({ dualInvestigation: false })).isError);
  assert.equal(events.at(-1).event.dualInvestigation, true);
  assert.equal((await route({ mode: "direct" })).isError, true);
  const restored = o.newInstruction(1, "critical fault", true);
  assert.equal(restored.dualInvestigation, true);
  o.instructions.set(1, restored);
  assert.match(chats.approvalGuard(1, write), /양쪽 조사/);
  assert.equal(chats.approvalGuard(1, { ...write, writes: false, command: "git status" }), null);
  const ask = await o.call(1, "orch", "ask", { to: "클로드 1호", kind: "implement", message: "fix", reason: "implement the fix" });
  assert.equal(ask.isError, true);
  for (const toRole of ["w1", "w2"]) reports.push({ instructionId: 17, fromRole: "orch", toRole, kind: "opinion", status: "done", responseSummary: "evidence" });
  assert.equal(chats.approvalGuard(1, write), null);
  events.push({ id: 99, event: { type: "user", text: "ordinary request" } });
  assert.equal(o.newInstruction(1, "ordinary request", true).dualInvestigation, undefined);
});

test("missing completion is repaired only once on the same instruction and stopped work is not restarted", async () => {
  const { chats, orchestrator: o } = engine();
  chats.store.project = () => ({ settings: { reviewGate: false } });
  chats.store.listConsults = () => [];
  const sent: string[] = [];
  chats.driver = async () => ({ send: async (input: { text: string }) => sent.push(input.text) });
  const inst = { id: 17, mode: "delegated", text: "analyze", asks: 2, queued: [], pinned: [] };
  o.instructions.set(1, inst);
  assert.equal(chats.beforeMasterEnd(1, { type: "turn_end", ok: true }), null);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(o.instructions.get(1), inst);
  assert.equal(inst.asks, 2);
  assert.equal(chats.beforeMasterEnd(1, { type: "turn_end", ok: true }).ok, false);
  o.instructions.set(1, { ...inst, repaired: false });
  assert.equal(chats.beforeMasterEnd(1, { type: "turn_end", ok: true }), null);
  o.stopped.add(1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
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

test("resuming an interrupted plan or review after restart allows normal mutation approvals", async () => {
  for (const command of ["/plan change a file", "/review"]) {
    const { chats, orchestrator: o } = engine();
    chats.store.chat = () => ({ id: 1, status: "interrupted" });
    chats.store.events = () => [{ event: { type: "user", text: command } }];
    chats.updateChat = () => undefined;
    o.handover = () => "";
    let input: any;
    chats.driver = async () => ({ send: async (value: any) => { input = value; } });
    await o.resume(1);
    assert.equal(input.noWrites, false, command);
    assert.equal(chats.approvalGuard(1, write), null, command);
  }
});

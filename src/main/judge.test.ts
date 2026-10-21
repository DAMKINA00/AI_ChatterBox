import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalJudge } from "./judge";
import { ApprovalService, type ApprovalInput } from "./approvals";
import { DEFAULT_SETTINGS, type AgentEvent } from "../shared/types";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const action: ApprovalInput = { role: "w1", node: "consult:1", title: "Write", detail: "result.txt", key: "Write", writes: true, paths: ["result.txt"] };

async function fixture(provider = "codex") {
  const folder = mkdtempSync(join(tmpdir(), "chatterbox-judge-"));
  const events: AgentEvent[] = [], observed: AgentEvent[] = [];
  let calls = 0, scope = ["result.txt", "probe.txt"], blocked: string | null = null;
  const chats: any = {
    store: {
      chat: () => ({ projectId: 1 }),
      project: () => ({ folder, settings: { ...DEFAULT_SETTINGS, orchestratorModel: `${provider}:test`, approvalMode: "orchestrator-all" } }),
      listAgents: () => [],
    },
    assignmentEffort: async () => ({ effort: "medium" }),
    route: () => "consult:1", emit: (_c: number, _n: string, _r: string, e: AgentEvent) => events.push(e),
    onDriverEvent: (_c: number, _r: string, e: AgentEvent) => observed.push(e),
    codex: () => ({}), claudeExe: () => "unused", geminiExe: () => "unused", grokExe: () => "unused",
    bridgeScript: join(folder, "bridge.js"), tmpDir: folder,
  };
  const judge = new ApprovalJudge(chats, () => ({ instruction: "프로젝트 수정과 검증", consult: { who: "reviewer", kind: "review", message: "검토 후 수정", scope } }));
  chats.approvals = new ApprovalService({
    emit: chats.emit, log() {}, pendingChanged() {}, mode: () => ({ mode: "orchestrator-all", delegateHighRisk: true }),
    writeScope: () => ({ folder, globs: scope, why: "assigned scope" }), guard: () => blocked,
    judge: (...args) => { calls++; return judge.decide(...args); },
  });
  const session = await (judge as any).session(1);
  const driver = session.driver as any;
  let stops = 0;
  driver.stop = async () => { stops++; };
  driver.dispose = async () => {};
  return { folder, judge, chats, driver, events, observed, session,
    get calls() { return calls; }, get stops() { return stops; }, setScope(v: string[]) { scope = v; }, setGuard(v: string | null) { blocked = v; },
    close: async () => { await judge.dispose(); rmSync(folder, { recursive: true, force: true }); },
  };
}

test("every CLI judge permits tools instead of imposing a read-only session", async () => {
  for (const provider of ["claude", "codex", "gemini", "grok"]) {
    const f = await fixture(provider);
    try {
      assert.notEqual(f.driver.opts.readOnly, true, provider);
      assert.equal(f.driver.opts.ephemeral, true);
      assert.equal(f.driver.env?.tools, undefined);
      assert.doesNotMatch(f.driver.opts.instructions, /도구는 쓰지 않는다|리뷰·의견 요청인데 파일을 고치려는/);
    } finally { await f.close(); }
  }
});

test("judge reads and approved writes finish the original approval without recursive judging", async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.driver.send = async () => {
      const host = f.driver.host;
      assert.equal((await host.approve({ title: "Read", detail: "probe.txt", key: "Read", readOnly: true, paths: ["probe.txt"] })).verdict, "allow");
      host.emit({ type: "tool_call", id: "probe", name: "write_file", input: "probe.txt" });
      const answer = await host.approve({ ...action, detail: "probe.txt", paths: ["probe.txt"] });
      t.mock.timers.tick(240_000);
      assert.equal(f.stops, 0, "approved tool execution is not a model timeout");
      if (answer.verdict === "allow") writeFileSync(join(f.folder, "probe.txt"), "verified");
      host.emit({ type: "file_change", id: "probe", ok: answer.verdict === "allow", files: [{ path: "probe.txt", kind: "add", diff: "+verified" }] });
      host.emit({ type: "text", text: '{"decision":"allow","reason":"검증 완료"}' });
      host.emit({ type: "turn_end", ok: true });
    };
    const pending = f.chats.approvals.request(1, f.folder, action);
    await tick();
    const event = f.events.find(e => e.type === "approval_request");
    assert.ok(event?.type === "approval_request");
    assert.match(event.request.title, /승인 판정기/);
    assert.equal(event.request.role, "w1");
    assert.equal(f.calls, 1);
    assert.equal(existsSync(join(f.folder, "probe.txt")), false);
    t.mock.timers.tick(240_000);
    assert.equal(f.stops, 0, "human approval is not a model timeout");
    f.chats.approvals.answer(1, event.request.id, "once");
    assert.equal((await pending).verdict, "allow");
    assert.equal(readFileSync(join(f.folder, "probe.txt"), "utf8"), "verified");
    assert.equal(f.calls, 1);
    assert.ok(f.observed.some(e => e.type === "file_change" && e.id === "judge:probe"));
    assert.equal(f.observed.some(e => e.type === "turn_end"), false, "judge must not end its caller's turn");
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("judge mutations retain scope checks and interruption expires only the judge's pending action", async () => {
  const f = await fixture();
  try {
    let verdict: string | undefined;
    f.driver.send = async () => {
      assert.equal((await f.driver.host.approve({ ...action, paths: ["outside.txt"] })).verdict, "deny");
      verdict = (await f.driver.host.approve({ ...action, paths: ["probe.txt"] })).verdict;
      if (verdict === "allow") writeFileSync(join(f.folder, "probe.txt"), "unexpected");
    };
    const deciding = f.judge.decide(1, { ...action, id: "original", risk: "low" }, action);
    await tick();
    const event = f.events.find(e => e.type === "approval_request");
    assert.ok(event?.type === "approval_request");
    await f.judge.interrupt(1);
    assert.equal(await deciding, null);
    assert.equal(verdict, "deny");
    assert.equal(f.chats.approvals.answer(1, event.request.id, "once"), null);
    assert.equal(f.chats.approvals.pendingCount(1), 0);
    assert.equal(existsSync(join(f.folder, "probe.txt")), false);
  } finally { await f.close(); }
});

test("denied judge writes have no effect and model timeout resumes after the user's answer", async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.driver.send = async () => {
      const answer = await f.driver.host.approve({ ...action, paths: ["probe.txt"] });
      if (answer.verdict === "allow") writeFileSync(join(f.folder, "probe.txt"), "unexpected");
    };
    const deciding = f.judge.decide(1, { ...action, id: "original", risk: "low" }, action);
    await tick();
    const event = f.events.find(e => e.type === "approval_request");
    assert.ok(event?.type === "approval_request");
    f.chats.approvals.answer(1, event.request.id, "deny");
    await tick();
    t.mock.timers.tick(120_000);
    assert.equal(await deciding, null);
    assert.ok(f.stops > 0);
    assert.equal(existsSync(join(f.folder, "probe.txt")), false);
    assert.equal(f.chats.approvals.pendingCount(1), 0);
  } finally { t.mock.timers.reset(); await f.close(); }
});

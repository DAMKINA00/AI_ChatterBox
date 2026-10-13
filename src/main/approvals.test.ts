import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalService, type ApprovalInput, type JudgeAnswer } from "./approvals";
import type { AgentEvent, ApprovalMode } from "../shared/types";

const folder = process.cwd();
const write: ApprovalInput = { role: "orch", node: "orch", title: "Write", detail: "a.txt", key: "Write", writes: true, paths: ["a.txt"] };
function fixture() {
  const events: AgentEvent[] = [];
  let mode: ApprovalMode = "orchestrator", high = false, globs: string[] | null = null, guard: string | null = null, calls = 0;
  let judge: () => Promise<JudgeAnswer | null> = async () => ({ decision: "allow", reason: "authorized" });
  const service = new ApprovalService({ emit: (_c, _n, _r, e) => events.push(e), log() {}, pendingChanged() {},
    mode: () => ({ mode, delegateHighRisk: high }), guard: () => guard,
    writeScope: () => ({ folder, globs, why: "assigned scope" }),
    judge: () => { calls++; return judge(); },
  });
  return { service, events, get calls() { return calls; }, setMode(v: ApprovalMode) { mode = v; }, setHigh(v: boolean) { high = v; }, setScope(v: string[] | null) { globs = v; }, setGuard(v: string | null) { guard = v; }, setJudge(v: typeof judge) { judge = v; } };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

test("master and worker requests both use separate auto judge", async () => {
  const f = fixture();
  assert.equal((await f.service.request(1, folder, write)).verdict, "allow");
  assert.equal((await f.service.request(1, folder, { ...write, role: "w1", node: "w1" })).verdict, "allow");
  assert.equal(f.calls, 2);
});
test("scope is checked before cached allow, including unknown paths", async () => {
  const f = fixture();
  await f.service.request(1, folder, write);
  f.setScope(["other/**"]);
  assert.equal((await f.service.request(1, folder, write)).verdict, "deny");
  assert.equal((await f.service.request(1, folder, { ...write, paths: [] })).verdict, "deny");
  f.setScope(["a.txt"]);
  assert.equal((await f.service.request(1, folder, { ...write, diffs: [{ path: "a.txt", movePath: "../outside.txt", kind: "update", diff: "" }] })).verdict, "deny");
  f.setScope([]);
  assert.equal((await f.service.request(1, folder, write)).verdict, "deny");
  assert.equal(f.calls, 1);
});
test("high-risk delegation off asks user; on rejudges every time", async () => {
  const f = fixture();
  const input = { ...write, writes: false, paths: [], command: "git push", detail: "git push" };
  const request = f.service.request(1, folder, input);
  await tick();
  const ev = f.events.find((e) => e.type === "approval_request");
  assert.equal(ev?.type, "approval_request");
  if (ev?.type === "approval_request") f.service.answer(1, ev.request.id, "deny");
  assert.equal((await request).verdict, "deny");
  f.setHigh(true);
  assert.equal((await f.service.request(1, folder, input)).verdict, "allow");
  assert.equal((await f.service.request(1, folder, input)).verdict, "allow");
  assert.equal(f.calls, 3);
});
test("settings invalidation clears cached approvals and cancels in-flight judge", async () => {
  const f = fixture();
  await f.service.request(1, folder, write);
  f.service.invalidate(1);
  await f.service.request(1, folder, write);
  assert.equal(f.calls, 2);
  let done!: (v: JudgeAnswer) => void;
  f.setJudge(() => new Promise((r) => { done = r; }));
  const pending = f.service.request(1, folder, { ...write, detail: "b.txt" });
  f.service.invalidate(1);
  done({ decision: "allow", reason: "stale" });
  assert.equal((await pending).verdict, "deny");
});

test("shell mutations are judged again even if their command string is unchanged", async () => {
  const f = fixture();
  const command = { ...write, writes: false, paths: [], command: "npm test", detail: "npm test" };
  await f.service.request(1, folder, command);
  await f.service.request(1, folder, command);
  assert.equal(f.calls, 2);
});
test("direct approval and judge failure preserve user fallback", async () => {
  for (const kind of ["user", "broken"] as const) {
    const f = fixture();
    if (kind === "user") f.setMode("user"); else f.setJudge(async () => { throw new Error("offline"); });
    const p = f.service.request(1, folder, write);
    await tick();
    const e = f.events.find((e) => e.type === "approval_request");
    assert.ok(e?.type === "approval_request");
    f.service.answer(1, e.request.id, "once");
    assert.equal((await p).verdict, "allow");
  }
});
test("restriction is rechecked after async judgment and before human answer", async () => {
  const f = fixture();
  f.setJudge(async () => { f.setGuard("another implementation started"); return { decision: "allow", reason: "yes" }; });
  assert.equal((await f.service.request(1, folder, write)).verdict, "deny");
  f.setGuard(null); f.setMode("user");
  const p = f.service.request(1, folder, write);
  const e = f.events.findLast((x) => x.type === "approval_request");
  assert.ok(e?.type === "approval_request");
  f.setGuard("plan mode"); f.service.answer(1, e.request.id, "once");
  assert.equal((await p).verdict, "deny");
});

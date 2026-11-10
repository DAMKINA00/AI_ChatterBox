import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentEvent, type AgentKind, type Chat, type ChatGoal, type Consult, type PlanStep, type Role } from "../shared/types";
import type { AgentDriver, AgentInput } from "./drivers/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

class FakeDriver implements AgentDriver {
  running = false;
  readonly sendCalls: AgentInput[] = [];
  constructor(readonly agent: AgentKind, readonly emitEvent: (event: AgentEvent) => void) {}
  async send(input: AgentInput) { this.sendCalls.push(input); this.running = true; }
  async stop() { if (this.running) this.finish(false, true); }
  async dispose() { this.running = false; }
  finish(ok = true, interrupted = false, text = "결과") {
    if (ok) this.emitEvent({ type: "text", text });
    this.running = false;
    this.emitEvent({ type: "turn_end", ok, interrupted, ...(ok || interrupted ? {} : { error: "드라이버 오류" }) });
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) assert.fail("timed out");
    await delay(5);
  }
}

/** Like the real driver host: the master's turn_end passes the completion guard (beforeMasterEnd) first. */
function open(root: string, dbPath: string) {
  const store = new Store(dbPath);
  const sink = { chats: [] as Chat[], consults: [] as Consult[], agents() {}, chat(c: Chat) { sink.chats.push(c); }, consult(c: Consult) { sink.consults.push(c); }, usage() {}, event() {} };
  const chats = new ChatManager(store, sink as any, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const drivers = new Map<string, FakeDriver>();
  chats.models = async () => [{ id: "opus", label: "opus", isDefault: true, reasoningEfforts: ["medium", "high"] }];
  chats.cliInfo = () => [{ agent: "claude", path: "fake" }, { agent: "codex", path: "fake" }];
  chats.teamCapabilities = async () => ({ claude: { installed: true }, gpt: { installed: true }, grok: { installed: true }, gemini: {} }) as any;
  const driverFor = (chatId: number, role: Role) => {
    const key = `${chatId}:${role}`;
    if (drivers.has(key)) return drivers.get(key)!;
    const driver = new FakeDriver("claude", (event) => {
      if (role === "orch" && event.type === "turn_end" && chats.beforeMasterEnd) {
        const checked = chats.beforeMasterEnd(chatId, event);
        if (!checked) return;
        event = checked;
      }
      chats.emit(chatId, chats.route(chatId, role), role, event);
      chats.onDriverEvent?.(chatId, role, event);
      if (role === "orch" && event.type === "turn_end") chats.orchTurnEnded(chatId, event);
    });
    drivers.set(key, driver);
    const live = (chats as any).live as Map<number, Record<string, unknown>>;
    live.set(chatId, { ...(live.get(chatId) ?? {}), [role]: { driver, agent: "claude", model: "fake", effort: "high" } });
    return driver;
  };
  chats.driver = async (chatId, role) => driverFor(chatId, role);
  return { store, chats, engine, drivers, driverFor };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-plan-"));
  const dbPath = join(root, "test.db");
  const first = open(root, dbPath);
  const project = first.store.createProject("p", root, DEFAULT_SETTINGS);
  const chat = first.store.createChat(project.id, "계획 fixture");
  return {
    ...first, root, project, chat,
    master: () => first.driverFor(chat.id, "orch"),
    async reopen() {
      await first.engine.judge.dispose();
      first.store.close();
      return open(root, dbPath);
    },
    close() {
      try { first.store.close(); } catch { /* reopened */ }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
type F = ReturnType<typeof fixture>;

const step = (id: string, status: PlanStep["status"], extra: Partial<PlanStep> = {}) => ({ id, title: `단계 ${id}`, status, ...extra });
const checklist = (f: { engine: any; chat: Chat }, steps: unknown[]) => f.engine.call(f.chat.id, "orch", "checklist", { steps });
const route = (f: { engine: any; chat: Chat }) => f.engine.call(f.chat.id, "orch", "route_request", { mode: "direct", reason: "r" });
const states = (store: Store, chatId: number) => store.events(chatId).flatMap((e) => e.event.type === "plan_state" ? [e.event] : []);
const notices = (store: Store, chatId: number) => store.events(chatId).flatMap((e) => e.event.type === "notice" ? [e.event.text] : []);

/** /plan with a checklist, then the proposal turn ends: a plan waiting for approval. */
async function propose(f: F, steps: unknown[]) {
  await f.engine.command(f.chat.id, "plan", "계획 대상");
  await checklist(f, steps);
  f.master().finish();
  assert.equal(states(f.store, f.chat.id).at(-1)?.state, "proposed");
}

test("a run ending with open steps gets one repair, then ends incomplete and not done; no further turn", async () => {
  const f = fixture();
  try {
    await propose(f, [step("a", "completed"), step("b", "pending")]);
    const master = f.master();
    await f.engine.command(f.chat.id, "plan-run", "");
    const planId = states(f.store, f.chat.id).at(-1)!.planId;
    assert.ok(planId, "running carries the plan id");
    assert.match(master.sendCalls.at(-1)!.text, /승인된 계획 단계:[^]*단계 b \(pending\)/, "the run is tied to the approved steps");
    await route(f);
    const sends = master.sendCalls.length;
    master.finish();
    await waitFor(() => master.sendCalls.length === sends + 1);
    assert.match(master.sendCalls.at(-1)!.text, /보완 1회[^]*끝나지 않은 단계 1개: b 단계 b/);
    assert.notEqual(f.store.chat(f.chat.id)!.status, "done");

    master.finish(); // still open
    const last = states(f.store, f.chat.id).at(-1)!;
    assert.deepEqual([last.state, last.planId], ["incomplete", planId]);
    assert.match(last.reason!, /단계 b/);
    assert.equal(states(f.store, f.chat.id).filter((s) => s.state === "done").length, 0, "a successful turn alone is not a finished plan");
    assert.equal(f.store.chat(f.chat.id)!.status, "error");
    await delay(50);
    assert.equal(master.sendCalls.length, sends + 1, "no loop after the repair");
  } finally { f.close(); }
});

test("cancelling a step with a reason during the repair finishes the plan; cancelled is not counted as completed", async () => {
  const f = fixture();
  try {
    await propose(f, [step("a", "pending"), step("b", "pending", { dependsOn: ["a"] })]);
    const master = f.master();
    await f.engine.command(f.chat.id, "plan-run", "");
    await route(f);
    const result = await checklist(f, [step("a", "cancelled"), step("b", "pending", { dependsOn: ["a"] })]);
    assert.match(result.content[0].text, /0\/2 완료 · 취소 1/);
    assert.match(result.content[0].text, /선행 대기: b\(단계 b\) ← a/, "a cancelled prerequisite still blocks");
    const saved = f.store.events(f.chat.id).findLast((e) => e.event.type === "plan_update")!.event as Extract<AgentEvent, { type: "plan_update" }>;
    assert.equal(saved.steps[0].cancelReason, "사유가 기록되지 않았습니다.", "the engine records a default reason");
    await checklist(f, [step("a", "cancelled", { cancelReason: "요구 변경" }), step("b", "completed", { dependsOn: ["a"] })]);
    master.finish();
    assert.equal(states(f.store, f.chat.id).at(-1)!.state, "done");
    assert.equal(f.store.chat(f.chat.id)!.status, "done");
  } finally { f.close(); }
});

test("an ordinary instruction's checklist is guarded the same way", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "일반 지시", []);
    const master = f.master();
    await route(f);
    await checklist(f, [step("x", "inProgress")]);
    const inst = f.engine.instructions.get(f.chat.id);
    master.finish();
    await waitFor(() => master.sendCalls.length === 2);
    master.finish();
    const last = states(f.store, f.chat.id).at(-1)!;
    assert.deepEqual([last.state, last.planId], ["incomplete", inst.id]);
    assert.equal(f.store.chat(f.chat.id)!.status, "error");
    assert.ok(notices(f.store, f.chat.id).some((n) => /완료 확인: 체크리스트에 끝나지 않은 단계 1개: x 단계 x\(진행 중\)/.test(n)));

    // The next instruction is not held to the old checklist, and its own one is checked again.
    await f.chats.send(f.chat.id, "다음 지시", []);
    await route(f);
    const sends = master.sendCalls.length;
    master.finish();
    assert.equal(f.store.chat(f.chat.id)!.status, "done");
    assert.equal(master.sendCalls.length, sends, "no repair for a plan of an earlier instruction");
  } finally { f.close(); }
});

test("open steps cannot silently disappear from the same plan", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "일반 지시", []);
    await checklist(f, [step("a", "pending"), step("b", "inProgress"), step("c", "completed")]);
    const dropped = await checklist(f, [step("a", "pending")]);
    assert.equal(dropped.isError, true);
    assert.match(dropped.content[0].text, /뺄 수 없습니다: b/);
    assert.equal(f.store.events(f.chat.id).filter((e) => e.event.type === "plan_update").length, 1, "the rejected update is not stored");
    const ok = await checklist(f, [step("a", "pending"), step("b", "cancelled", { cancelReason: "중복" })]);
    assert.notEqual(ok.isError, true, "a completed step may be left out; an open one must be completed or cancelled");
  } finally { f.close(); }
});

test("/plan-cancel: refused while planning or running; an idle proposal is cancelled; it then cannot run; no automatic turn", async () => {
  const f = fixture();
  try {
    f.store.updateChat(f.chat.id, { goal: { objective: "목표", status: "active", progress: "", turns: 0, updatedAt: Date.now() } satisfies ChatGoal });
    await f.engine.command(f.chat.id, "plan", "계획 대상");
    await checklist(f, [step("a", "pending")]);
    await assert.rejects(f.engine.command(f.chat.id, "plan-cancel", ""), /취소할 수 없습니다[^]*\/stop/);
    assert.equal(f.engine.planning.has(f.chat.id), true, "the planning restriction stays while the proposal turn runs");
    assert.equal(states(f.store, f.chat.id).length, 0);

    const master = f.master();
    master.finish();
    await delay(400); // past the goal auto-continuation delay
    assert.equal(master.sendCalls.length, 1, "a proposal waiting for approval does not continue the goal");

    await f.engine.command(f.chat.id, "plan-cancel", "");
    const cancelled = states(f.store, f.chat.id).at(-1)!;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.planId, states(f.store, f.chat.id).find((s) => s.state === "proposed")!.planId);
    assert.ok(cancelled.reason);
    await assert.rejects(f.engine.command(f.chat.id, "plan-run", ""), /제안 계획이 없습니다/);
    await assert.rejects(f.engine.command(f.chat.id, "plan-cancel", ""), /취소할 제안 계획이 없습니다/);
    await delay(400);
    assert.equal(master.sendCalls.length, 1, "nothing runs after the cancel");

    // A new instruction starts its own work; the cancelled plan is not brought back.
    await f.chats.send(f.chat.id, "새 지시", []);
    assert.equal(f.engine.planRunning.has(f.chat.id), false);
    assert.doesNotMatch(master.sendCalls.at(-1)!.text, /승인된 계획 단계/);
  } finally { f.close(); }
});

test("/plan-cancel during a run is refused without touching the run or the queued message", async () => {
  const f = fixture();
  try {
    await propose(f, [step("a", "pending")]);
    await f.engine.command(f.chat.id, "plan-run", "");
    await f.chats.send(f.chat.id, "대기 지시", [], "next");
    const inst = f.engine.instructions.get(f.chat.id);
    assert.equal(inst.queued.length, 1);
    await assert.rejects(f.engine.command(f.chat.id, "plan-cancel", ""), /\/stop/);
    assert.equal(inst.queued.length, 1, "the queued instruction stays");
    assert.equal(f.engine.planRunning.has(f.chat.id), true);
    assert.equal(states(f.store, f.chat.id).at(-1)!.state, "running");
  } finally { f.close(); }
});

test("a stopped run is 'stopped' and a failed run 'failed', never 'cancelled'", async () => {
  for (const [how, expected] of [["stop", "stopped"], ["error", "failed"]] as const) {
    const f = fixture();
    try {
      await propose(f, [step("a", "pending")]);
      await f.engine.command(f.chat.id, "plan-run", "");
      if (how === "stop") await f.engine.stop(f.chat.id);
      else f.master().finish(false);
      const last = states(f.store, f.chat.id).at(-1)!;
      assert.equal(last.state, expected, how);
      assert.ok(last.planId);
    } finally { f.close(); }
  }
});

test("a crash during a run keeps the plan: the restored run is still guarded and closes with its plan id", async () => {
  const f = fixture();
  try {
    await propose(f, [step("a", "pending")]);
    await f.engine.command(f.chat.id, "plan-run", "");
    await route(f);
    const planId = states(f.store, f.chat.id).at(-1)!.planId;
    const next = await f.reopen();
    try {
      await next.engine.resume(f.chat.id);
      assert.equal(next.engine.planRunning.get(f.chat.id), planId);
      await next.engine.call(f.chat.id, "orch", "route_request", { mode: "direct", reason: "복구" });
      await next.engine.call(f.chat.id, "orch", "checklist", { steps: [step("a", "completed")] });
      next.driverFor(f.chat.id, "orch").finish();
      const last = states(next.store, f.chat.id).at(-1)!;
      assert.deepEqual([last.state, last.planId], ["done", planId]);
    } finally { next.store.close(); }
  } finally { f.close(); }
});

test("pausing a run does not end its plan; resuming carries it on", async () => {
  const f = fixture();
  try {
    await propose(f, [step("a", "pending")]);
    await f.engine.command(f.chat.id, "plan-run", "");
    const planId = f.engine.planRunning.get(f.chat.id);
    await f.engine.pause(f.chat.id);
    assert.equal(f.store.chat(f.chat.id)!.status, "paused");
    assert.equal(states(f.store, f.chat.id).at(-1)!.state, "running", "the pause is not a stop of the plan");
    f.engine.planRunning.delete(f.chat.id); // as after a restart: only the saved pause state remains
    await f.engine.resume(f.chat.id);
    assert.equal(f.engine.planRunning.get(f.chat.id), planId);
  } finally { f.close(); }
});

// ---------- review 719
test("native plan updates follow the same rules: attributed, guarded, and steps that must stay are kept", async () => {
  const f = fixture();
  try {
    // An older unattributed record from before this instruction is never attached to it.
    f.store.addEvent(f.chat.id, "orch", "orch", { type: "plan_update", steps: [step("old", "pending")] });
    await f.chats.send(f.chat.id, "일반 지시", []);
    await route(f);
    const inst = f.engine.instructions.get(f.chat.id);
    const master = f.master();
    master.emitEvent({ type: "plan_update", steps: [step("n1", "pending"), step("n2", "cancelled", { cancelReason: "불필요" })] });
    const stored = () => f.store.events(f.chat.id).findLast((e) => e.event.type === "plan_update")!.event as Extract<AgentEvent, { type: "plan_update" }>;
    assert.deepEqual([stored().planId, stored().instructionId], [inst.id, inst.id], "stamped with the current plan as it arrives");
    // A native list that drops the open and the cancelled step keeps them (it cannot be refused).
    master.emitEvent({ type: "plan_update", steps: [step("n3", "completed")] });
    assert.deepEqual(stored().steps.map((s) => [s.id, s.status, s.cancelReason]), [["n1", "pending", undefined], ["n2", "cancelled", "불필요"], ["n3", "completed", undefined]]);
    master.finish();
    await waitFor(() => master.sendCalls.length === 2);
    assert.match(master.sendCalls.at(-1)!.text, /끝나지 않은 단계 1개: n1 단계 n1/);
    master.finish();
    assert.equal(f.store.chat(f.chat.id)!.status, "error", "a native pending step cannot end the instruction as done");
    assert.equal(states(f.store, f.chat.id).at(-1)!.state, "incomplete");
    const old = f.store.events(f.chat.id).find((e) => e.event.type === "plan_update")!.event as Extract<AgentEvent, { type: "plan_update" }>;
    assert.equal(old.planId, undefined, "the older record stays unattributed");
  } finally { f.close(); }
});

test("a proposal followed by another instruction can no longer be run or cancelled", async () => {
  const f = fixture();
  try {
    await propose(f, [step("old", "pending")]);
    await f.chats.send(f.chat.id, "새 독립 지시", []);
    await route(f);
    f.master().finish();
    const sends = f.master().sendCalls.length;
    await assert.rejects(f.engine.command(f.chat.id, "plan-run", ""), /다른 지시가 있었던 계획/);
    await assert.rejects(f.engine.command(f.chat.id, "plan-cancel", ""), /취소할 제안 계획이 없습니다/);
    assert.equal(f.master().sendCalls.length, sends);
    assert.equal(f.engine.planRunning.has(f.chat.id), false);
  } finally { f.close(); }
});

test("a cancelled step cannot be dropped or renamed away by a later update of the same plan", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "일반 지시", []);
    await checklist(f, [step("a", "cancelled", { cancelReason: "사용자 취소" }), step("b", "pending")]);
    const dropped = await checklist(f, [step("b", "completed")]);
    assert.equal(dropped.isError, true);
    assert.match(dropped.content[0].text, /취소된 단계를 목록에서 뺄 수 없습니다: a/);
    const renamed = await checklist(f, [step("a2", "cancelled", { cancelReason: "다른 이름" }), step("b", "completed")]);
    assert.equal(renamed.isError, true);
    const kept = await checklist(f, [step("a", "cancelled", { cancelReason: "사용자 취소" }), step("b", "completed")]);
    assert.notEqual(kept.isError, true);
    const saved = f.store.events(f.chat.id).findLast((e) => e.event.type === "plan_update")!.event as Extract<AgentEvent, { type: "plan_update" }>;
    assert.equal(saved.steps[0].cancelReason, "사용자 취소");
  } finally { f.close(); }
});

test("an earlier goal continuation does not start after a new /plan or its cancellation; queued input is untouched", async () => {
  const f = fixture();
  try {
    f.store.updateChat(f.chat.id, { goal: { objective: "목표", status: "active", progress: "", turns: 0, updatedAt: Date.now() } satisfies ChatGoal });
    await f.chats.send(f.chat.id, "첫 지시", []);
    await route(f);
    f.master().finish(); // schedules the goal continuation (300 ms)
    await propose(f, [step("a", "pending")]);
    await f.engine.command(f.chat.id, "plan-cancel", "");
    const sends = f.master().sendCalls.length;
    await delay(400);
    assert.equal(f.master().sendCalls.length, sends, "the stale continuation does not run");
    assert.equal(f.store.chat(f.chat.id)!.goal!.turns, 0);

    // Without anything in between, the goal still continues as before.
    await f.chats.send(f.chat.id, "둘째 지시", []);
    await route(f);
    const before = f.master().sendCalls.length;
    f.master().finish();
    await waitFor(() => f.master().sendCalls.length === before + 1);
    assert.match(f.master().sendCalls.at(-1)!.text, /\[목표 계속\]/);
  } finally { f.close(); }
});

// ---------- review 727
const lastPlan = (store: Store, chatId: number) => store.events(chatId).findLast((e) => e.event.type === "plan_update")!.event as Extract<AgentEvent, { type: "plan_update" }>;

test("a recorded cancellation reason survives later updates that give none, and a cancelled step is not reopened", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "지시", []);
    await checklist(f, [step("a", "cancelled", { cancelReason: "사용자가 범위에서 제외" }), step("b", "pending")]);
    await checklist(f, [step("a", "cancelled"), step("b", "completed")]);
    assert.equal(lastPlan(f.store, f.chat.id).steps[0].cancelReason, "사용자가 범위에서 제외");
    const reopened = await checklist(f, [step("a", "pending"), step("b", "completed")]);
    assert.equal(lastPlan(f.store, f.chat.id).steps[0].status, "cancelled");
    assert.equal(lastPlan(f.store, f.chat.id).steps[0].cancelReason, "사용자가 범위에서 제외");
    assert.match(reopened.content[0].text, /a: 취소된 단계는 다시 열지 않습니다/, "the model is told why");
    await checklist(f, [step("a", "cancelled", { cancelReason: "새 사유" }), step("b", "completed")]);
    assert.equal(lastPlan(f.store, f.chat.id).steps[0].cancelReason, "새 사유", "an explicit new reason replaces it");
    // A native list keeps it too, without a reason and with the step reported as done.
    f.master().emitEvent({ type: "plan_update", steps: [{ title: "단계 a", status: "completed" }, { title: "단계 b", status: "completed" }] });
    assert.deepEqual(lastPlan(f.store, f.chat.id).steps.map((s) => [s.id, s.status, s.cancelReason]), [["a", "cancelled", "새 사유"], ["b", "completed", undefined]]);
  } finally { f.close(); }
});

test("a title-only native update completes the same checklist step; ambiguous titles are not guessed", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "지시", []);
    await route(f);
    await checklist(f, [step("a", "pending", { owner: "클로드 1호" }), step("b", "pending", { dependsOn: ["a"] })]);
    f.master().emitEvent({ type: "plan_update", steps: [{ title: "단계 a", status: "completed" }, { title: "단계 b", status: "completed" }] });
    assert.deepEqual(lastPlan(f.store, f.chat.id).steps.map((s) => [s.id, s.status, s.owner, s.dependsOn]), [["a", "completed", "클로드 1호", undefined], ["b", "completed", undefined, ["a"]]], "matched to the recorded ids and links, no duplicate");
    const sends = f.master().sendCalls.length;
    f.master().finish();
    assert.equal(f.store.chat(f.chat.id)!.status, "done");
    assert.equal(f.master().sendCalls.length, sends, "no repair turn");
  } finally { f.close(); }

  const g = fixture();
  try {
    await g.chats.send(g.chat.id, "지시", []);
    await route(g);
    await checklist(g, [{ id: "x1", title: "테스트", status: "pending" }, { id: "x2", title: "테스트", status: "pending" }]);
    g.master().emitEvent({ type: "plan_update", steps: [{ title: "테스트", status: "completed" }] });
    const steps = lastPlan(g.store, g.chat.id).steps;
    assert.deepEqual(steps.map((s) => [s.id, s.status]), [["x1", "pending"], ["x2", "pending"], [undefined, "completed"]], "two recorded steps share the title: both stay open");
    g.master().finish();
    await waitFor(() => g.master().sendCalls.length === 2);
    assert.match(g.master().sendCalls.at(-1)!.text, /끝나지 않은 단계 2개: x1 테스트, x2 테스트/, "the model sees which steps are still open, by id");
  } finally { g.close(); }
});

// ---------- review 731
test("a native update cannot reopen a cancelled step through a prerequisite it dropped; an unusable list keeps the recorded one", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "지시", []);
    await checklist(f, [step("p", "completed"), step("a", "cancelled", { cancelReason: "사용자 제외", dependsOn: ["p"] })]);
    // The native list names only the cancelled step (by title) and leaves out its completed prerequisite.
    f.master().emitEvent({ type: "plan_update", steps: [{ title: "단계 a", status: "completed" }] });
    assert.deepEqual(lastPlan(f.store, f.chat.id).steps.map((s) => [s.id, s.status, s.cancelReason, s.dependsOn]), [["p", "completed", undefined, undefined], ["a", "cancelled", "사용자 제외", ["p"]]]);
    assert.equal(notices(f.store, f.chat.id).filter((n) => /이전 체크리스트를 유지합니다/.test(n)).length, 0, "accepted by carrying the prerequisite back, not by the fallback");

    // A list that still breaks the rules (a duplicate id) is not stored over the recorded one.
    f.master().emitEvent({ type: "plan_update", steps: [{ id: "x", title: "X", status: "completed" }, { id: "x", title: "Y", status: "completed" }] });
    assert.deepEqual(lastPlan(f.store, f.chat.id).steps.map((s) => [s.id, s.status, s.cancelReason]), [["p", "completed", undefined], ["a", "cancelled", "사용자 제외"]]);
    assert.ok(notices(f.store, f.chat.id).some((n) => /이전 체크리스트를 유지합니다: 단계 id가 중복됩니다: x/.test(n)));
  } finally { f.close(); }
});

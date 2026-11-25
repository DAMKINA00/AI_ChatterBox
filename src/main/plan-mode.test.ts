import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentEvent, type AgentKind, type Chat, type Consult, type Role } from "../shared/types";
import type { AgentDriver, AgentInput } from "./drivers/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { globWithin, Orchestrator, scopeIssue } from "./orchestrator";
import { currentPlanView, isPlanExecutionRequest, pendingProposal, planStepsFor } from "../shared/plan-lifecycle";
import { readyGroupSteps, validatePlanSteps, validateProposedTasks } from "../shared/plan-steps";
import { isReadCommand } from "./execution-policy";
import { bridgeConnected, bridgeDenyNotice, findBridgeDenyRules, missingBridgeTools } from "./claude-settings";
import { GEMINI_BRIDGE_TOOLS } from "./drivers/gemini-protocol";

class FakeDriver implements AgentDriver {
  running = false;
  steer?: (input: AgentInput) => Promise<boolean>;
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-planmode-"));
  // The project folder holds a sub-repository, as when the folder is a parent of the repo.
  mkdirSync(join(root, "repo", "src", "main"), { recursive: true });
  mkdirSync(join(root, "repo", "src", "ui"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  const store = new Store(join(root, "test.db"));
  const sink = { chats: [] as Chat[], consults: [] as Consult[], agents() {}, chat(c: Chat) { sink.chats.push(c); }, consult(c: Consult) { sink.consults.push(c); }, usage() {}, event() {} };
  const chats = new ChatManager(store, sink as any, root, "unused");
  const engine = new Orchestrator(chats) as any;
  engine.waitPollMs = 5;
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
  const project = store.createProject("p", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "계획 모드 fixture");
  return {
    root, store, chats, engine, chat,
    master: () => driverFor(chat.id, "orch"),
    worker: (nickname: string) => driverFor(chat.id, store.listAgents(chat.id).find((a) => a.nickname === nickname)!.key),
    call: (name: string, args: unknown, caller: Role = "orch") => engine.call(chat.id, caller, name, args),
    states: () => store.events(chat.id).flatMap((e) => e.event.type === "plan_state" ? [e.event] : []),
    notices: () => store.events(chat.id).flatMap((e) => e.event.type === "notice" ? [e.event.text] : []),
    close() { try { store.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}
type F = ReturnType<typeof fixture>;

const task = (id: string, group: number, extra: Record<string, unknown> = {}) => ({
  id, title: `작업 ${id}`, kind: "implement", agentKind: "claude", scope: [`repo/src/${id}/**`], group, done: `${id} 완료`, ...extra,
});
const goodTasks = [
  task("main", 1, { scope: ["repo/src/main/**"] }),
  task("ui", 1, { scope: ["repo/src/ui/**"], agentKind: "gpt" }),
  task("rev", 2, { kind: "review", scope: [], dependsOn: ["main", "ui"], reviewOf: "main" }),
];

async function planTurn(f: F, text: string) {
  f.engine.setPlanMode(f.chat.id, true);
  await f.chats.send(f.chat.id, text, []);
}

test("chat execution directives exclude questions, negation, conditions and quoted examples", () => {
  for (const text of ["진행", "진행해", "진행해줘", "계획대로 진행해 줘.", "작업을 시작해주세요", "계획에 담지 말고 그대로 작업을 진행해. 계획 모드는 종료야.", "진행하세요. 그리고 중복 카드도 정리해."])
    assert.equal(isPlanExecutionRequest(text), true, text);
  for (const text of ["진행 왜 못해?", "진행하지 마", "진행해 주지 마", "진행해 주면 안 돼", "진행해 달라는 문구를 표시해", "진행해. 아니 진행하지 말고 설명만 해", "확인이 끝나면 진행해", "승인 후 진행해", "나중에 진행해", '"진행해"라는 문구를 표시해', "> 진행해", "`진행해`", "```text\n진행해\n```", "진행해도 될까?", "리뷰도 넣어 줘"])
    assert.equal(isPlanExecutionRequest(text), false, text);
});

test("plan approval accepts additions delivered before submission (reported failure)", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    f.master().steer = async () => true;
    await f.chats.send(f.chat.id, "리뷰도 포함해", []);
    await f.call("propose_plan", { summary: "리뷰 포함", tasks: goodTasks });
    const ask = f.store.events(f.chat.id).findLast(e => e.event.type === "ask_user" && e.event.planConfirm)!.event as any;
    f.master().finish();
    assert.ok(pendingProposal(f.store.events(f.chat.id)));
    f.engine.answerAsk(f.chat.id, ask.id, "진행");
    await waitFor(() => f.states().at(-1)?.state === "running");
    assert.ok(!f.notices().some(n => /처리 실패/.test(n)));
  } finally { f.close(); }
});

test("chat approval runs the submitted plan and keeps the original message and its conditions", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    f.master().finish();
    const planId = pendingProposal(f.store.events(f.chat.id));
    await f.chats.send(f.chat.id, "진행하세요. 그리고 중복 카드도 정리해.", []);
    assert.equal(f.engine.planning.has(f.chat.id), false);
    assert.equal(f.master().sendCalls.at(-1)!.noWrites, false);
    assert.deepEqual([f.states().at(-1)!.state, f.states().at(-1)!.planId], ["running", planId]);
    assert.match(f.master().sendCalls.at(-1)!.text, /승인했다[^]*중복 카드도 정리해/);
    const user = f.store.events(f.chat.id).findLast(e => e.event.type === "user")!.event as any;
    assert.equal(user.text, "진행하세요. 그리고 중복 카드도 정리해.");
    assert.equal(user.plan, undefined);
  } finally { f.close(); }
});

test("an execution request interrupts an unfinished read-only planning turn and retains additions", async () => {
  const f = fixture();
  try {
    await planTurn(f, "로그인 오류를 고쳐");
    await f.chats.send(f.chat.id, "별도의 리뷰도 추가", [], "next");
    await f.chats.send(f.chat.id, "계획에 담지 말고 그대로 작업을 진행해. 계획 모드는 종료야.", []);
    assert.ok(!f.store.chat(f.chat.id)!.planMode);
    assert.equal(f.engine.planning.has(f.chat.id), false);
    assert.equal(f.master().sendCalls.length, 2);
    assert.equal(f.master().sendCalls.at(-1)!.noWrites, false);
    assert.match(f.master().sendCalls.at(-1)!.text, /로그인 오류를 고쳐[^]*별도의 리뷰도 추가/);
    const spawned = await f.call("spawn", { kind: "claude", job: "로그인 수정" });
    assert.ok(!spawned.isError, JSON.stringify(spawned));
    await delay(30);
    assert.equal(f.master().sendCalls.length, 2, "no stale queued planning turn restarts");
  } finally { f.close(); }
});

test("chat approval during submission runs once after the read-only turn is interrupted", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    await f.chats.send(f.chat.id, "진행해", []);
    assert.equal(f.states().at(-1)!.state, "running");
    assert.equal(f.master().sendCalls.at(-1)!.noWrites, false);
    await delay(30);
    assert.equal(f.master().sendCalls.length, 2);
  } finally { f.close(); }
});

test("next-stage chat execution waits for the plan turn and then starts writable work", async () => {
  for (const submitted of [false, true]) {
    const f = fixture();
    try {
      await planTurn(f, "계획");
      if (submitted) await f.call("propose_plan", { summary: "s", tasks: goodTasks });
      await f.chats.send(f.chat.id, "진행해", [], "next");
      assert.equal(f.master().sendCalls.length, 1, "next means wait for this turn");
      assert.equal(f.master().running, true);
      f.master().finish();
      await waitFor(() => f.master().sendCalls.length === 2);
      assert.equal(f.master().sendCalls.at(-1)!.noWrites, false);
      assert.equal(f.engine.planning.has(f.chat.id), false);
      await delay(30);
      assert.equal(f.master().sendCalls.length, 2);
    } finally { f.close(); }
  }
});

test("paused planning can be explicitly continued as execution", async () => {
  const f = fixture();
  try {
    await planTurn(f, "로그인 수정");
    await f.engine.pause(f.chat.id);
    assert.equal(f.store.chat(f.chat.id)!.status, "paused");
    await f.chats.send(f.chat.id, "진행해", []);
    assert.equal(f.master().sendCalls.at(-1)!.noWrites, false);
    assert.equal(f.store.chat(f.chat.id)!.status, "working");
    assert.equal(f.store.getSetting(`pause:${f.chat.id}`), "");
  } finally { f.close(); }
});

test("question and negation keep a pending plan in revision mode, not execution", async () => {
  for (const text of ["진행 왜 못해?", "진행하지 말고 리뷰 추가해"]) {
    const f = fixture();
    try {
      await planTurn(f, "계획");
      await f.call("propose_plan", { summary: "s", tasks: goodTasks });
      f.master().finish();
      await f.chats.send(f.chat.id, text, []);
      assert.equal(f.master().sendCalls.at(-1)!.noWrites, true);
      assert.equal(f.states().some(s => s.state === "running"), false);
    } finally { f.close(); }
  }
});

test("an explicit stop during a planning-to-execution transition prevents restarting", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.master().stop = async () => { await barrier; f.master().finish(false, true); };
    const proceeding = f.chats.send(f.chat.id, "진행해", []);
    await delay(5);
    const stopping = f.engine.stop(f.chat.id);
    release();
    await assert.rejects(proceeding, /중지한 계획/);
    await stopping;
    assert.equal(f.master().sendCalls.length, 1);
    assert.equal(f.states().some(s => s.state === "running"), false);
  } finally { f.close(); }
});

test("a next-input plan toggle does not interrupt work that is already running", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "로그인 수정", []);
    f.engine.setPlanMode(f.chat.id, true);
    f.master().steer = async () => true;
    await f.chats.send(f.chat.id, "진행해", []);
    assert.equal(f.master().sendCalls.length, 1);
    assert.equal(f.master().running, true);
    assert.equal(f.engine.planning.has(f.chat.id), false);
  } finally { f.close(); }
});

test("a held revision is delivered when the user explicitly runs the submitted plan", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    await f.chats.send(f.chat.id, "중복 카드도 정리", []);
    await f.chats.send(f.chat.id, "진행해", []);
    assert.equal(f.states().at(-1)!.state, "running");
    assert.match(f.master().sendCalls.at(-1)!.text, /중복 카드도 정리/);
    await delay(30);
    assert.equal(f.master().sendCalls.length, 2);
  } finally { f.close(); }
});

test("execution retains planning attachments without attaching them twice in the chat history", async () => {
  const f = fixture();
  try {
    const a = f.store.addAttachment(f.chat.id, "reference.png", join(f.root, "reference.png"), "image/png", 1);
    f.engine.setPlanMode(f.chat.id, true);
    await f.chats.send(f.chat.id, "첨부를 참고해 계획", [a.id]);
    const b = f.store.addAttachment(f.chat.id, "change.png", join(f.root, "change.png"), "image/png", 1);
    await f.chats.send(f.chat.id, "이 조건으로 진행해", [b.id]);
    assert.deepEqual(f.master().sendCalls.at(-1)!.attachments.map(x => x.id), [a.id, b.id]);
    const user = f.store.events(f.chat.id).findLast(e => e.event.type === "user")!.event as any;
    assert.deepEqual(user.attachments.map((x: any) => x.id), [b.id]);
  } finally { f.close(); }
});

test("plan mode: a send starts a read-only planning turn and workers are refused", async () => {
  const f = fixture();
  try {
    await planTurn(f, "로그인 고치기");
    assert.equal(f.store.chat(f.chat.id)!.planMode, true);
    const user = f.store.events(f.chat.id).findLast((e) => e.event.type === "user")!.event;
    assert.equal(user.type === "user" && user.plan, true, "the user event is marked as a plan request");
    const sent = f.master().sendCalls.at(-1)!;
    assert.equal(sent.noWrites, true, "the planning turn is read-only");
    assert.match(sent.text, /^\[계획 모드\] 읽기 전용[^]*propose_plan[^]*요청:\n로그인 고치기/);
    for (const name of ["spawn", "ask", "ask_parallel", "release", "update_goal", "council_consult", "wait_results"]) {
      const r = await f.call(name, { kind: "claude", job: "x", to: "클로드 1호", message: "m", tasks: [{ to: "x", message: "m", kind: "opinion" }] });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /계획 모드/, name);
    }
    assert.match(f.engine.guardApproval(f.chat.id, { role: "orch", command: "npm install" }) ?? "", /계획 모드/);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "orch", command: "git status" }), null, "reads stay allowed");
  } finally { f.close(); }
});

test("propose_plan validates tasks and a submitted plan waits for approval with its version", async () => {
  const f = fixture();
  try {
    const before = await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    assert.equal(before.isError, true, "only in plan mode");
    await planTurn(f, "기능 추가");
    const bad = async (tasks: unknown[], pattern: RegExp) => {
      const r = await f.call("propose_plan", { summary: "요약", tasks });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, pattern);
    };
    await bad([task("a", 1, { scope: ["repo/src/**"] }), task("b", 1, { scope: ["repo/src/main/**"] })], /같은 group 1인데 scope가 겹칩니다/);
    await bad([task("a", 1, { scope: ["repo/src/main/**"] }), task("b", 1, { scope: ["repo/src/ui/**"], dependsOn: ["a"] })], /더 앞선 group/);
    await bad([task("a", 1, { kind: "implement", scope: [] })], /scope/);
    await bad([{ id: "a", title: "제목만", status: "pending" }], /kind, agentKind, group, done/);
    await bad([task("a", 1, { scope: ["repo/src/main/**"] }), task("r", 1, { kind: "review", scope: [], reviewOf: "a" })], /뒤 group/);
    // A scope that matches nothing is accepted with a warning that suggests the sub-repository prefix.
    const warned = await f.call("propose_plan", { summary: "경고", tasks: [task("a", 1, { scope: ["src/main/**"] })] });
    assert.ok(!warned.isError);
    assert.match(warned.content[0].text, /범위 경고[^]*일치하는 기존 경로 없음[^]*"repo\/src\/main\/\*\*" 형태인지/);
    const ok = await f.call("propose_plan", { summary: "두 구현을 병렬로, 리뷰는 뒤에", tasks: goodTasks });
    assert.ok(!ok.isError, ok.content[0].text);
    assert.doesNotMatch(ok.content[0].text, /범위 경고/);
    const steps = currentPlanView(f.store.events(f.chat.id))!.steps;
    assert.deepEqual(steps.map((s) => [s.id, s.group, s.kind, s.agentKind]), [["main", 1, "implement", "claude"], ["ui", 1, "implement", "gpt"], ["rev", 2, "review", "claude"]]);
    assert.equal(steps[2].reviewOf, "main");
    assert.equal((await f.call("checklist", { steps: [{ title: "x", status: "pending" }] })).isError, true, "checklist cannot replace a submitted plan");
    f.master().finish();
    const proposed = f.states().at(-1)!;
    assert.equal(proposed.state, "proposed");
    assert.equal(proposed.version, 1);
    assert.equal(pendingProposal(f.store.events(f.chat.id)), proposed.planId);
  } finally { f.close(); }
});

test("plan mode: a turn without a submitted plan does not wait for approval; a later send revises a proposal", async () => {
  const f = fixture();
  try {
    await planTurn(f, "질문부터");
    f.master().finish();
    assert.equal(f.states().some((s) => s.state === "proposed"), false);
    assert.ok(f.notices().some((n) => /아직 제출된 계획이 없습니다/.test(n)));
    await f.chats.send(f.chat.id, "범위는 서버만", []);
    await f.call("propose_plan", { summary: "v1", tasks: goodTasks.slice(0, 1) });
    f.master().finish();
    const v1 = f.states().at(-1)!;
    assert.equal(v1.version, 1);
    await f.chats.send(f.chat.id, "UI도 포함해 줘", []);
    const cancelled = f.states().at(-1)!;
    assert.deepEqual([cancelled.state, cancelled.planId, cancelled.version], ["cancelled", v1.planId, 1]);
    assert.match(f.master().sendCalls.at(-1)!.text, /계획 v1 수정[^]*\[이전 제안 v1\][^]*main[^]*수정 요청:\nUI도 포함해 줘/);
    await f.call("propose_plan", { summary: "v2", tasks: goodTasks });
    f.master().finish();
    const v2 = f.states().at(-1)!;
    assert.deepEqual([v2.state, v2.version], ["proposed", 2]);
    assert.notEqual(v2.planId, v1.planId);
  } finally { f.close(); }
});

test("approval turns plan mode off, runs by group and links plan tasks to their assignments", async () => {
  const f = fixture();
  try {
    await planTurn(f, "병렬 작업");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    f.master().finish();
    await f.engine.command(f.chat.id, "plan-run", "");
    assert.ok(!f.store.chat(f.chat.id)!.planMode, "approval ends plan mode");
    const run = f.master().sendCalls.at(-1)!;
    assert.equal(run.noWrites, false);
    assert.match(run.text, /계획 v1을 승인했다[^]*ask_parallel 한 번으로[^]*group 1:\n- main[^]*\n- ui[^]*group 2:\n- rev/);
    await f.call("route_request", { mode: "delegated", reason: "계획 실행", split: "sequential" });
    await f.call("spawn", { kind: "claude", job: "main" });
    // Two tasks of group 1 can start: a single ask for one of them points to ask_parallel.
    const single = await f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", scope: ["repo/src/main/**"], reason: "r", planTaskId: "main" });
    assert.equal(single.isError, true);
    assert.match(single.content[0].text, /group 1에서 지금 시작할 수 있는 작업이 2개[^]*ask_parallel/);
    const blocked = await f.call("ask_parallel", { tasks: [{ to: "클로드 1호", kind: "review", message: "m", reason: "r", planTaskId: "rev" }] });
    assert.match(blocked.content[0].text, /배정을 시작하지 않았습니다[^]*선행 main, ui/);
    // The ui task is set aside; then main runs alone and the app links and completes it.
    const planId = f.states().at(-1)!.planId!;
    const steps = planStepsFor(f.store.events(f.chat.id), planId)!;
    await f.call("checklist", { steps: steps.map((s) => s.id === "ui" ? { ...s, status: "cancelled", cancelReason: "보류" } : s) });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", scope: ["repo/src/main/**"], reason: "r", planTaskId: "main" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    assert.equal(planStepsFor(f.store.events(f.chat.id), planId)!.find((s) => s.id === "main")!.status, "inProgress");
    f.worker("클로드 1호").finish(true, false, "구현 끝");
    await asked;
    const main = planStepsFor(f.store.events(f.chat.id), planId)!.find((s) => s.id === "main")!;
    assert.equal(main.status, "completed");
    assert.equal(main.consultIds?.length, 1);
    assert.equal(main.kind, "implement", "app updates keep the task fields");
  } finally { f.close(); }
});

/** A submitted, approved plan with an idle master, ready for assignments. */
async function approved(f: F, tasks = goodTasks) {
  await planTurn(f, "계획");
  await f.call("propose_plan", { summary: "s", tasks });
  f.master().finish();
  await f.engine.command(f.chat.id, "plan-run", `${f.states().at(-1)!.planId}:1`);
  await f.call("route_request", { mode: "delegated", reason: "계획 실행", split: "sequential" });
  return f.states().at(-1)!.planId!;
}

test("one group's tasks start together through one ask_parallel", async () => {
  const f = fixture();
  try {
    const planId = await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] }), task("ui", 1, { scope: ["repo/src/ui/**"] }), task("rev", 2, { kind: "review", scope: [], dependsOn: ["main", "ui"], reviewOf: "main" })]);
    await f.call("spawn", { kind: "claude", job: "a" });
    await f.call("spawn", { kind: "claude", job: "b" });
    const batch = f.call("ask_parallel", { tasks: [
      { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "main" },
      { to: "클로드 2호", kind: "implement", message: "m", reason: "r", planTaskId: "ui" },
    ] });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1 && f.worker("클로드 2호").sendCalls.length === 1);
    const live = planStepsFor(f.store.events(f.chat.id), planId)!;
    assert.deepEqual(live.filter((s) => s.status === "inProgress").map((s) => s.id), ["main", "ui"], "both run at once");
    assert.deepEqual(f.store.listConsults(f.chat.id).map((c) => c.scope), [["repo/src/main/**"], ["repo/src/ui/**"]], "the approved scopes fill omitted ones");
    f.worker("클로드 1호").finish();
    f.worker("클로드 2호").finish();
    await batch;
    const done = planStepsFor(f.store.events(f.chat.id), planId)!;
    assert.deepEqual(done.map((s) => s.status), ["completed", "completed", "pending"]);
    assert.ok(done.every((s, i) => i === 2 || s.consultIds?.length === 1));
  } finally { f.close(); }
});

test("an approved task's definition is fixed: kind, family, owner, scope and group order are checked", async () => {
  const f = fixture();
  try {
    await f.call("spawn", { kind: "claude", job: "고정 담당" });
    const planId = await approved(f, [
      task("main", 1, { scope: ["repo/src/main/**"], owner: "클로드 1호" }),
      task("ui", 2, { scope: ["repo/src/ui/**"], agentKind: "gpt" }),
    ]);
    await f.call("spawn", { kind: "claude", job: "b" });
    const refuse = async (args: Record<string, unknown>, pattern: RegExp) => {
      const r = await f.call("ask", { message: "m", reason: "r", ...args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.content[0].text, pattern);
    };
    await refuse({ to: "클로드 1호", kind: "opinion", planTaskId: "main" }, /승인된 종류는 implement/);
    await refuse({ to: "클로드 1호", kind: "implement", scope: ["repo/src/**"], planTaskId: "main" }, /승인된 범위\(repo\/src\/main\/\*\*\) 밖입니다: repo\/src\/\*\*/);
    await refuse({ to: "클로드 2호", kind: "implement", planTaskId: "main" }, /승인된 담당은 클로드 1호/);
    await refuse({ to: "클로드 2호", kind: "implement", planTaskId: "ui" }, /group 2입니다[^]*앞 group 1/);
    await refuse({ to: "클로드 2호", kind: "implement", planTaskId: "ui" }, /승인된 담당 계열은/);
    // A checklist may change status, never the approved structure.
    const steps = planStepsFor(f.store.events(f.chat.id), planId)!;
    await f.call("checklist", { steps: steps.map((s) => ({ ...s, scope: ["anything/**"], group: 9, kind: "opinion" })) });
    const kept = planStepsFor(f.store.events(f.chat.id), planId)!;
    assert.deepEqual(kept.map((s) => [s.scope, s.group, s.kind]), [[["repo/src/main/**"], 1, "implement"], [["repo/src/ui/**"], 2, "implement"]]);
    // Work outside the plan is a supplement: allowed, with a reminder while plan tasks can start.
    const extra = f.call("ask", { to: "클로드 2호", kind: "opinion", message: "추가 확인", reason: "r" });
    await waitFor(() => f.worker("클로드 2호").sendCalls.length === 1);
    f.worker("클로드 2호").finish();
    assert.match((await extra).content[0].text, /계획 보완 작업으로 맡겼습니다[^]*main/);
  } finally { f.close(); }
});

test("too few workers: sequentialReason runs one task of a group at a time", async () => {
  const f = fixture();
  try {
    await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] }), task("ui", 1, { scope: ["repo/src/ui/**"] })]);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "sequential" });
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "main", sequentialReason: "가용 작업자가 1명" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    assert.ok(f.notices().some((n) => /순차로 맡깁니다: 가용 작업자가 1명/.test(n)));
    f.worker("클로드 1호").finish();
    await asked;
  } finally { f.close(); }
});

test("plan-run checks the plan and version the approver saw; the bare command runs the latest and says which", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "v1", tasks: goodTasks.slice(0, 1) });
    f.master().finish();
    const v1 = f.states().at(-1)!.planId!;
    await f.chats.send(f.chat.id, "수정", []);
    await f.call("propose_plan", { summary: "v2", tasks: goodTasks });
    f.master().finish();
    const v2 = f.states().at(-1)!.planId!;
    assert.notEqual(v2, v1, "every proposal has its own plan id");
    assert.equal(currentPlanView(f.store.events(f.chat.id))?.version, 2);
    await assert.rejects(f.engine.command(f.chat.id, "plan-run", `${v2}:1`), /계획이 바뀌었습니다[^]*v1[^]*v2/);
    await assert.rejects(f.engine.command(f.chat.id, "plan-run", `${v1}:2`), /계획이 바뀌었습니다/);
    await assert.rejects(f.engine.command(f.chat.id, "plan-run", "2"), /계획ID:버전/, "a button must send both");
    assert.equal(f.states().at(-1)!.state, "proposed", "a refused approval changes nothing");
    await f.engine.command(f.chat.id, "plan-run", `${v2}:2`);
    assert.deepEqual([f.states().at(-1)!.state, f.states().at(-1)!.version], ["running", 2]);
  } finally { f.close(); }
  // Another proposal with the same version number: cancelled A v1, then B v1. A's screen cannot run B.
  const g = fixture();
  try {
    await g.engine.command(g.chat.id, "plan", "A");
    await g.call("propose_plan", { summary: "A", tasks: goodTasks.slice(0, 1) });
    g.master().finish();
    const a = g.states().at(-1)!.planId!;
    await g.engine.command(g.chat.id, "plan-cancel", "");
    await g.engine.command(g.chat.id, "plan", "B");
    await g.call("propose_plan", { summary: "B", tasks: goodTasks.slice(0, 1) });
    g.master().finish();
    const b = g.states().at(-1)!;
    assert.deepEqual([b.state, b.version], ["proposed", 1]);
    assert.notEqual(b.planId, a);
    await assert.rejects(g.engine.command(g.chat.id, "plan-run", `${a}:1`), /계획이 바뀌었습니다/);
    await g.engine.command(g.chat.id, "plan-run", "");
    assert.equal(g.states().at(-1)!.state, "running");
    assert.ok(g.notices().some((n) => n.includes(`최신 제안(계획 ${b.planId} v1)을 실행합니다`)), "the bare command says what it ran");
  } finally { g.close(); }
});

test("approved ranges are enforced: an empty task scope writes nothing, supplements and corrections stay inside", async () => {
  const f = fixture();
  try {
    await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] }), task("check", 1, { kind: "opinion", scope: [] })]);
    await f.call("spawn", { kind: "claude", job: "a" });
    await f.call("spawn", { kind: "claude", job: "b" });
    const key = (n: string) => f.store.listAgents(f.chat.id).find((a) => a.nickname === n)!.key;
    const batch = f.call("ask_parallel", { tasks: [
      { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "main" },
      { to: "클로드 2호", kind: "opinion", message: "m", reason: "r", planTaskId: "check" },
    ] });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1 && f.worker("클로드 2호").sendCalls.length === 1);
    assert.deepEqual(f.engine.writeScope(f.chat.id, key("클로드 2호")).globs, [], "an approved empty scope forbids file changes");
    // amend_scope stays inside the task's approved range.
    assert.match((await f.call("amend_scope", { to: "클로드 1호", scope: ["repo/src/**"], reason: "넓힘" })).content[0].text, /범위 밖이라 바꾸지 않았습니다/);
    assert.ok(!(await f.call("amend_scope", { to: "클로드 1호", scope: ["repo/src/main/a/**"], reason: "좁힘" })).isError);
    f.worker("클로드 1호").finish(false);
    f.worker("클로드 2호").finish();
    await batch;
    // The retry inherits the narrowed range.
    const retry = f.call("ask", { to: "클로드 1호", kind: "implement", message: "다시", reason: "r", planTaskId: "main", supersedes: f.store.listConsults(f.chat.id)[0].id });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 2);
    assert.deepEqual(f.store.listConsults(f.chat.id).at(-1)!.scope, ["repo/src/main/a/**"]);
    f.worker("클로드 1호").finish();
    await retry;
    // Supplement work outside the approved ranges needs the user's approval first.
    const outside = await f.call("ask", { to: "클로드 2호", kind: "implement", message: "m", scope: ["docs/**"], reason: "r" });
    assert.match(outside.content[0].text, /승인된 계획의 범위 밖입니다: docs\/\*\*[^]*extend_plan_scope/);
    const asking = f.call("extend_plan_scope", { scope: ["docs/**"], reason: "문서 갱신" });
    const extendAsks = () => f.store.events(f.chat.id).filter((e) => e.event.type === "ask_user" && /범위 확대/.test(e.event.question));
    await waitFor(() => extendAsks().length === 1);
    const ask = f.store.events(f.chat.id).findLast((e) => e.event.type === "ask_user")!.event as any;
    assert.match(ask.question, /계획 범위 확대 요청[^]*docs\/\*\*[^]*문서 갱신/);
    f.engine.answerAsk(f.chat.id, ask.id, "허용");
    assert.match((await asking).content[0].text, /허용했습니다/);
    const allowed = f.call("ask", { to: "클로드 2호", kind: "implement", message: "m", scope: ["docs/**"], reason: "r" });
    await waitFor(() => f.worker("클로드 2호").sendCalls.length === 2);
    f.worker("클로드 2호").finish();
    assert.ok(!(await allowed).isError);
    // A refusal records nothing.
    const refused = f.call("extend_plan_scope", { scope: ["other/**"], reason: "x" });
    await waitFor(() => extendAsks().length === 2);
    f.engine.answerAsk(f.chat.id, (f.store.events(f.chat.id).findLast((e) => e.event.type === "ask_user")!.event as any).id, "거부");
    assert.match((await refused).content[0].text, /허용하지 않았습니다/);
    assert.match((await f.call("ask", { to: "클로드 2호", kind: "implement", message: "m", scope: ["other/**"], reason: "r" })).content[0].text, /범위 밖입니다: other/);
    // Read-only supplements are never refused.
    const review = f.call("ask", { to: "클로드 2호", kind: "review", message: "리뷰", reason: "r" });
    await waitFor(() => f.worker("클로드 2호").sendCalls.length === 3);
    f.worker("클로드 2호").finish();
    assert.ok(!(await review).isError);
  } finally { f.close(); }
});

test("a submitted plan turns plan mode off and the app asks 진행/수정/취소; each answer takes the button paths", async () => {
  const planAsk = (f: F) => f.store.events(f.chat.id).findLast((e) => e.event.type === "ask_user" && e.event.options.join() === "진행,수정,취소")?.event as any;
  // 진행 after the turn ended: runs exactly like the approval button.
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    assert.ok(!f.store.chat(f.chat.id)!.planMode, "plan mode is off once the plan is complete");
    const ask = planAsk(f);
    assert.match(ask.question, /계획 v1[^]*진행할까요/);
    f.master().finish();
    assert.equal(f.states().at(-1)!.state, "proposed");
    f.engine.answerAsk(f.chat.id, ask.id, "진행");
    await waitFor(() => f.states().at(-1)!.state === "running");
    await waitFor(() => /계획 v1을 승인했다/.test(f.master().sendCalls.at(-1)!.text));
  } finally { f.close(); }
  // 진행 chosen while the turn still runs: applied as soon as the proposal is recorded.
  const g = fixture();
  try {
    await planTurn(g, "계획");
    await g.call("propose_plan", { summary: "s", tasks: goodTasks });
    g.engine.answerAsk(g.chat.id, planAsk(g).id, "진행");
    assert.equal(g.store.chat(g.chat.id)!.status, "working", "the answer does not change the chat status by itself");
    g.master().finish();
    await waitFor(() => g.states().at(-1)!.state === "running");
    await waitFor(() => /승인했다/.test(g.master().sendCalls.at(-1)!.text));
  } finally { g.close(); }
  // 취소 cancels; 수정 keeps the proposal and the next message (toggle off) revises it.
  const h = fixture();
  try {
    await planTurn(h, "계획");
    await h.call("propose_plan", { summary: "s", tasks: goodTasks });
    h.master().finish();
    h.engine.answerAsk(h.chat.id, planAsk(h).id, "수정");
    await waitFor(() => h.notices().some((n) => /고칠 내용을 보내 주세요/.test(n)));
    assert.equal(h.states().at(-1)!.state, "proposed");
    await h.chats.send(h.chat.id, "리뷰를 추가해", []);
    assert.equal(h.engine.planning.has(h.chat.id), true, "a revision turn although the toggle is off");
    assert.match(h.master().sendCalls.at(-1)!.text, /계획 v1 수정/);
    await h.call("propose_plan", { summary: "v2", tasks: goodTasks });
    h.master().finish();
    h.engine.answerAsk(h.chat.id, planAsk(h).id, "취소");
    await waitFor(() => h.states().at(-1)!.state === "cancelled");
  } finally { h.close(); }
  // The approval button withdraws the open question.
  const b = fixture();
  try {
    await planTurn(b, "계획");
    await b.call("propose_plan", { summary: "s", tasks: goodTasks });
    b.master().finish();
    const ask = planAsk(b);
    await b.engine.command(b.chat.id, "plan-run", `${b.states().at(-1)!.planId}:1`);
    assert.ok(b.store.events(b.chat.id).some((e) => e.event.type === "ask_user_answer" && e.event.id === ask.id), "the card is closed");
    assert.equal(b.engine.answerAsk(b.chat.id, ask.id, "진행"), false, "a late answer runs nothing");
  } finally { b.close(); }
});

test("a choice on an earlier card never applies to a re-submitted plan; a message after submission revises it", async () => {
  const planAsks = (f: F) => f.store.events(f.chat.id).filter((e) => e.event.type === "ask_user" && e.event.planConfirm).map((e) => e.event as any);
  // A chosen 진행 on card A, then the master re-submits B in the same turn: B waits for its own answer.
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "A", tasks: goodTasks.slice(0, 1) });
    const a = planAsks(f).at(-1);
    f.engine.answerAsk(f.chat.id, a.id, "진행");
    await f.call("propose_plan", { summary: "B", tasks: goodTasks });
    f.master().finish();
    await delay(30);
    assert.equal(f.states().at(-1)!.state, "proposed", "A's choice did not run B");
    assert.equal(planAsks(f).length, 2);
    assert.equal(f.engine.answerAsk(f.chat.id, a.id, "진행"), false, "A's card is closed");
  } finally { f.close(); }
  // A message while the submitting turn still runs: the card and the choice are void, and it revises the plan after the turn.
  const g = fixture();
  try {
    await planTurn(g, "계획");
    await g.call("propose_plan", { summary: "A", tasks: goodTasks.slice(0, 1) });
    const card = planAsks(g).at(-1);
    await g.chats.send(g.chat.id, "리뷰 단계를 넣어 줘", [], "now");
    assert.equal(g.engine.answerAsk(g.chat.id, card.id, "진행"), false, "a late answer is refused");
    g.master().finish();
    await waitFor(() => /계획 v1 수정[^]*리뷰 단계를 넣어 줘/.test(g.master().sendCalls.at(-1)!.text));
    assert.equal(g.engine.planning.has(g.chat.id), true, "a revision turn on that proposal");
    assert.equal(g.master().sendCalls.at(-1)!.noWrites, true);
  } finally { g.close(); }
});

test("a 진행 chosen during the turn does not run once /stop came before the deferred start", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks });
    const card = f.store.events(f.chat.id).findLast((e) => e.event.type === "ask_user" && e.event.planConfirm)!.event as any;
    f.engine.answerAsk(f.chat.id, card.id, "진행");
    f.master().finish();
    const stopping = f.engine.stop(f.chat.id); // before the deferred start fires
    await delay(30);
    await stopping;
    assert.ok(!f.states().some((s) => s.state === "running"), "the stopped chat's plan did not run");
  } finally { f.close(); }
});

test("a revision request held during the submitting turn is not consumed by its tool responses", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "A", tasks: goodTasks.slice(0, 1) });
    await f.chats.send(f.chat.id, "리뷰 단계 추가", [], "next");
    const toolReply = await f.call("agents", {});
    assert.ok(!toolReply.content.some((c: any) => /리뷰 단계 추가/.test(c.text)), "not handed to the running turn");
    // Re-submitting while the request waits opens no new approval card.
    const cards = () => f.store.events(f.chat.id).filter((e) => e.event.type === "ask_user" && e.event.planConfirm).length;
    const before = cards();
    await f.call("propose_plan", { summary: "A2", tasks: goodTasks.slice(0, 1) });
    assert.equal(cards(), before);
    f.master().finish();
    await waitFor(() => /계획 v1 수정[^]*리뷰 단계 추가/.test(f.master().sendCalls.at(-1)!.text));
    assert.equal(f.master().sendCalls.filter((s) => /리뷰 단계 추가/.test(s.text)).length, 1, "used once, in the revision turn");
  } finally { f.close(); }
});

test("held revision requests never start a writing turn after the submitting turn fails", async () => {
  const f = fixture();
  try {
    await planTurn(f, "계획");
    await f.call("propose_plan", { summary: "A", tasks: goodTasks.slice(0, 1) });
    await f.chats.send(f.chat.id, "리뷰 단계 추가", [], "now");
    const sends = f.master().sendCalls.length;
    f.master().finish(false); // ok=false, interrupted=false
    await delay(30);
    assert.equal(f.master().sendCalls.length, sends, "not delivered automatically");
    assert.ok(!f.master().sendCalls.some((s) => /리뷰 단계 추가/.test(s.text) && !s.noWrites), "never a writing turn");
    assert.ok(f.notices().some((n) => /자동으로 보내지 않았습니다/.test(n)));
    assert.equal(f.engine.reviseAfterTurn.has(f.chat.id), false);
  } finally { f.close(); }
});

test("globWithin: a path is inside only past the approved folder's separator", () => {
  for (const g of ["src/**", "src/a.ts", "src/x/*.ts", "src", "SRC/A.ts", "src\\a.ts"]) assert.equal(globWithin(g, ["src/**"]), true, g);
  for (const g of ["src*", "src-old/**", "srcx/a.ts", "src/../x", "src/../x/**", "src?/a", "s*", "**", "other/src/a.ts"]) assert.equal(globWithin(g, ["src/**"]), false, g);
  assert.equal(globWithin("anything/**", ["**"]), true);
});

test("an approved plan's range binds the master's own edits and worker-to-worker assignments; ordinary runs are free", async () => {
  const f = fixture();
  try {
    await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] })]);
    const write = (role: Role, path: string) => f.engine.guardApproval(f.chat.id, { role, writes: true, paths: [join(f.root, path)] });
    assert.match(write("orch", "docs/a.md") ?? "", /승인된 계획의 범위[^]*docs\/a\.md[^]*extend_plan_scope/);
    assert.equal(write("orch", "repo/src/main/a.ts"), null);
    // A worker asking another for a write outside the plan is refused the same way.
    await f.call("spawn", { kind: "claude", job: "a" });
    await f.call("spawn", { kind: "claude", job: "b" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "main" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    const key = f.store.listAgents(f.chat.id)[0].key;
    const peer = await f.engine.call(f.chat.id, key, "ask", { to: "클로드 2호", kind: "implement", message: "m", scope: ["docs/**"] });
    assert.match(peer.content[0].text, /승인된 계획의 범위 밖입니다: docs/);
    f.worker("클로드 1호").finish();
    await asked;
  } finally { f.close(); }
  const free = fixture();
  try {
    await free.chats.send(free.chat.id, "일반 지시", []);
    assert.equal(free.engine.guardApproval(free.chat.id, { role: "orch", writes: true, paths: [join(free.root, "docs/a.md")] }), null, "no plan, no plan range");
  } finally { free.close(); }
});

test("real edited paths are matched against the plan range: src/*.ts allows src/a.ts, not src/sub/a.ts", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "src"), { recursive: true });
    await approved(f, [task("ts", 1, { scope: ["src/*.ts"] }), task("main", 1, { scope: ["repo/src/main/**"] })]);
    const write = (role: Role, path: string) => f.engine.guardApproval(f.chat.id, { role, writes: true, paths: [join(f.root, path)] });
    const check = (role: Role) => {
      assert.equal(write(role, "src/a.ts"), null, `${role} src/a.ts`);
      assert.match(write(role, "src/sub/a.ts") ?? "", /범위/, `${role} src/sub/a.ts`);
      assert.match(write(role, "docs/a.ts") ?? "", /범위/, `${role} docs/a.ts`);
    };
    // The master's own edits (before any worker holds a write lock).
    check("orch");
    assert.equal(write("orch", "repo/src/main/deep/x.ts"), null, "folder/** allows paths below it");
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "ts", sequentialReason: "1명" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    check(f.store.listAgents(f.chat.id)[0].key);
    f.worker("클로드 1호").finish();
    await asked;
  } finally { f.close(); }
});

test("a refused or cancelled approval ends that call's command lock at once", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "조사", []);
    f.engine.running.set(f.chat.id, new Map<Role, any>([["claude-1", { kind: "opinion", scope: [], consultId: 7 }]]));
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "npm run x", toolId: "x" }), null);
    f.chats.approvalDenied!(f.chat.id, "claude-1" as Role, "other");
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 1, "another call's refusal leaves it");
    f.chats.approvalDenied!(f.chat.id, "claude-1" as Role, "x");
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 0);
  } finally { f.close(); }
});

test("a command lock belongs to its tool call: another tool's result does not end it", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "조사", []);
    const running = new Map<Role, any>([["claude-1", { kind: "opinion", scope: [], consultId: 7 }]]);
    f.engine.running.set(f.chat.id, running);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "npm run slow", toolId: "slow" }), null);
    f.engine.releaseCommandLock(f.chat.id, 7, "fast-read");
    assert.deepEqual(f.engine.scopeLocks.get(f.chat.id), [{ consultId: 7, scope: [], command: true, toolId: "slow" }], "a faster read's result leaves it");
    f.engine.releaseCommandLock(f.chat.id, 7, "slow");
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 0, "its own result ends it");
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "npm run a", toolId: "a" }), null);
    f.engine.releaseCommandLock(f.chat.id, 7);
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 0, "the end of the turn ends a lock whose result never came");
  } finally { f.close(); }
});

test("a pause after a task finished (log still archiving) records it instead of running it again", async () => {
  const f = fixture();
  try {
    const planId = await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] })]);
    await f.call("spawn", { kind: "claude", job: "a" });
    const worker = f.store.listAgents(f.chat.id)[0];
    const consult = f.store.createConsult(f.chat.id, "orch", worker.key, "implement", "m", ["repo/src/main/**"], f.engine.instructions.get(f.chat.id).id, "r", undefined, { requestedEffort: "", effort: "" } as any, { attach: [], planTask: { planId, taskId: "main" } });
    f.store.finishConsult(consult.id, "done", "끝", []);
    const inst = f.engine.instructions.get(f.chat.id);
    f.store.setSetting(`pause:${f.chat.id}`, JSON.stringify({ folder: f.root, instruction: { ...inst, requests: [] }, planning: false, reviewing: false, planRun: planId,
      assignments: [{ caller: "orch", target: worker, kind: "implement", message: "m", scope: ["repo/src/main/**"], attach: [], reason: "r", consultId: consult.id, planTask: { planId, taskId: "main" } }] }));
    f.store.updateChat(f.chat.id, { status: "paused" });
    await f.engine.resume(f.chat.id);
    await delay(30);
    assert.equal(f.worker("클로드 1호").sendCalls.length, 0, "not run again");
    assert.equal(planStepsFor(f.store.events(f.chat.id), planId)![0].status, "completed");
  } finally { f.close(); }
});

test("only propose_plan makes a proposal; any message to a waiting proposal revises it, toggle on or off", async () => {
  const f = fixture();
  try {
    await f.engine.command(f.chat.id, "plan", "계획");
    await f.call("checklist", { steps: [{ id: "a", title: "체크리스트만", status: "pending" }] });
    f.master().finish();
    assert.equal(f.states().some((s) => s.state === "proposed"), false, "a checklist is not a submitted plan");
    await f.engine.command(f.chat.id, "plan", "다시");
    await f.call("propose_plan", { summary: "s", tasks: goodTasks.slice(0, 1) });
    f.master().finish();
    const first = f.states().at(-1)!;
    assert.equal(first.state, "proposed");
    assert.ok(!f.store.chat(f.chat.id)!.planMode, "the toggle is off");
    await f.chats.send(f.chat.id, "리뷰도 넣어 줘", []);
    const user = f.store.events(f.chat.id).findLast((e) => e.event.type === "user")!.event;
    assert.equal(user.type === "user" && user.plan, true, "marked as a plan message");
    assert.equal(f.engine.planning.has(f.chat.id), true, "a revision turn, not ordinary work");
    assert.equal(f.master().sendCalls.at(-1)!.noWrites, true);
    assert.match(f.master().sendCalls.at(-1)!.text, /계획 v1 수정[^]*수정 요청:\n리뷰도 넣어 줘/);
    assert.deepEqual([f.states().at(-1)!.state, f.states().at(-1)!.planId], ["cancelled", first.planId]);
  } finally { f.close(); }
});

test("a crash or pause keeps plan steps tied to their assignments", async () => {
  const f = fixture();
  try {
    const planId = await approved(f, [task("main", 1, { scope: ["repo/src/main/**"] })]);
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", reason: "r", planTaskId: "main" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    const consult = f.store.listConsults(f.chat.id)[0];
    assert.deepEqual(f.store.consultAssignment(consult.id)?.planTask, { planId, taskId: "main" }, "stored with the assignment");
    assert.deepEqual(planStepsFor(f.store.events(f.chat.id), planId)![0].consultIds, [consult.id], "linked when it starts");
    f.worker("클로드 1호").finish();
    await asked;
    // A restart finds a step still marked in progress: the stored consult decides it.
    const steps = planStepsFor(f.store.events(f.chat.id), planId)!;
    f.chats.emit(f.chat.id, "orch", "orch", { type: "plan_update", steps: steps.map((s) => ({ ...s, status: "inProgress" })), planId });
    f.engine.reconcilePlanSteps(f.chat.id);
    assert.equal(planStepsFor(f.store.events(f.chat.id), planId)![0].status, "completed");
    // The snapshot keeps the split and a planning turn's version and submission.
    f.engine.saveInstruction(f.chat.id);
    const saved = JSON.parse(f.store.getSetting(`runInstruction:${f.chat.id}:current`)!);
    assert.equal(saved.split, "sequential");
  } finally { f.close(); }
});

test("amend_scope also corrects the stored assignment; wait_results stops at its limit or a pending user answer", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "구현", []);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "single" });
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "implement", message: "m", scope: ["repo/src/main/**"], reason: "r" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    await f.call("amend_scope", { to: "클로드 1호", scope: ["repo/src/ui/**"], reason: "정정" });
    assert.deepEqual(f.store.listConsults(f.chat.id)[0].scope, ["repo/src/ui/**"], "the stored assignment follows");
    f.engine.waitTimeScale = 0.01;
    const timed = await f.call("wait_results", { timeoutSec: 2 });
    assert.match(timed.content[0].text, /대기 제한 2초 경과[^]*아직 실행 중/);
    f.engine.asks.set("q1", { chatId: f.chat.id, resolve() {} });
    const waiting = await f.call("wait_results", {});
    assert.match(waiting.content[0].text, /사용자 응답 대기[^]*질문 1건/);
    f.engine.asks.delete("q1");
    assert.equal((await f.call("wait_results", { timeoutSec: 0 })).isError, true);
    f.worker("클로드 1호").finish();
    await asked;
  } finally { f.close(); }
});

test("propose_plan refuses missing, released or doubled owners", async () => {
  const f = fixture();
  try {
    await f.call("spawn", { kind: "claude", job: "a" });
    await planTurn(f, "계획");
    const r1 = await f.call("propose_plan", { summary: "s", tasks: [task("a", 1, { scope: ["repo/src/main/**"], owner: "클로드 9호" })] });
    assert.match(r1.content[0].text, /없는 작업자[^]*agentKind만/);
    const r2 = await f.call("propose_plan", { summary: "s", tasks: [task("a", 1, { scope: ["repo/src/main/**"], owner: "클로드 1호" }), task("b", 1, { scope: ["repo/src/ui/**"], owner: "클로드 1호" })] });
    assert.match(r2.content[0].text, /같은 group 1에 같은 owner 클로드 1호/);
  } finally { f.close(); }
});

test("every bridge tool of the master and workers is reachable through Antigravity", () => {
  const f = fixture();
  try {
    const key = (role: Role) => f.engine.bridgeToolNames(f.chat.id, role).map((n: string) => n.replace("mcp__chatterbox_bridge__", ""));
    const missing = [...key("orch"), ...key("claude-1" as Role)].filter((n) => !GEMINI_BRIDGE_TOOLS.has(n));
    assert.deepEqual([...new Set(missing)], []);
  } finally { f.close(); }
});

test("split=parallel refuses a single first ask; split=single and direct pass straight through", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "여러 일", []);
    assert.match(f.master().sendCalls.at(-1)!.text, /split=single\|parallel\|sequential[^]*ask_parallel 한 번/);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "parallel" });
    const refused = await f.call("ask", { to: "없는 작업자", kind: "opinion", message: "m", reason: "r" });
    assert.match(refused.content[0].text, /split=parallel[^]*ask_parallel\(tasks=/);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "single" });
    const passed = await f.call("ask", { to: "없는 작업자", kind: "opinion", message: "m", reason: "r" });
    assert.match(passed.content[0].text, /그런 작업자가 없습니다/, "the gate let it through");
    assert.equal((await f.call("route_request", { mode: "delegated", reason: "r", split: "many" })).isError, true);
  } finally { f.close(); }
});

test("assignments with scopes that match nothing run with a warning that suggests the prefix", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "구현", []);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "parallel" });
    await f.call("spawn", { kind: "claude", job: "a" });
    await f.call("spawn", { kind: "claude", job: "b" });
    const batch = f.call("ask_parallel", { tasks: [
      { to: "클로드 1호", kind: "implement", message: "m", scope: ["repo/src/ui/**"], reason: "r" },
      { to: "클로드 2호", kind: "implement", message: "m", scope: ["src/main/**"], reason: "r" },
    ] });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1 && f.worker("클로드 2호").sendCalls.length === 1);
    const notice = f.notices().find((n) => /범위 경고 · 클로드 2호/.test(n));
    assert.match(notice ?? "", /기준 폴더 = .*일치하는 기존 경로 없음[^]*"repo\/src\/main\/\*\*" 형태인지[^]*amend_scope/, "shown at once");
    assert.ok(!f.notices().some((n) => /범위 경고 · 클로드 1호/.test(n)), "a matching scope gives no warning");
    f.worker("클로드 1호").finish();
    f.worker("클로드 2호").finish();
    const r = await batch;
    assert.match(r.content[0].text, /클로드 2호[^]*범위 경고[^]*repo\/src\/main/, "and returned with the result");
  } finally { f.close(); }
});

test("scopeIssue is quiet for existing paths and new files in existing folders, and warns otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-scope-"));
  try {
    mkdirSync(join(root, "app", "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "x");
    assert.equal(scopeIssue(root, "app/src/**"), null);
    assert.equal(scopeIssue(root, "app/src/new-file.ts"), null, "a new file in an existing folder");
    assert.equal(scopeIssue(root, "README.md"), null);
    assert.equal(scopeIssue(root, "app/**/*.ts"), null);
    assert.match(scopeIssue(root, "newdir/**")!, /일치하는 기존 경로 없음/, "a new folder is only a warning");
    assert.match(scopeIssue(root, "src/**")!, /기준 폴더 = .*"app\/src\/\*\*" 형태인지/);
    assert.match(scopeIssue(root, "../x/**")!, /밖의 경로/);
    assert.match(scopeIssue(root, join(root, "app", "src", "**"))!, /상대경로\("app\/src\/\*\*"\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("amend_scope corrects a running assignment's scope and refuses overlaps", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "구현", []);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "parallel" });
    await f.call("spawn", { kind: "claude", job: "a" });
    await f.call("spawn", { kind: "claude", job: "b" });
    const batch = f.call("ask_parallel", { tasks: [
      { to: "클로드 1호", kind: "implement", message: "m", scope: ["repo/src/main/**"], reason: "r" },
      { to: "클로드 2호", kind: "implement", message: "m", scope: ["repo/src/ui/**"], reason: "r" },
    ] });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1 && f.worker("클로드 2호").sendCalls.length === 1);
    const overlap = await f.call("amend_scope", { to: "클로드 1호", scope: ["repo/src/**"], reason: "넓힘" });
    assert.match(overlap.content[0].text, /겹쳐 바꾸지 않았습니다/);
    const ok = await f.call("amend_scope", { to: "클로드 1호", scope: ["repo/src/main/**", "docs/**"], reason: "문서 추가" });
    assert.ok(!ok.isError, ok.content[0].text);
    assert.deepEqual(f.engine.writeScope(f.chat.id, f.store.listAgents(f.chat.id).find((a: any) => a.nickname === "클로드 1호")!.key).globs, ["repo/src/main/**", "docs/**"]);
    assert.ok(f.store.events(f.chat.id).some((e) => e.event.type === "peer_message" && /범위 정정/.test(e.event.text)));
    f.worker("클로드 1호").finish();
    f.worker("클로드 2호").finish();
    const result = await batch;
    assert.doesNotMatch(result.content[0].text, /작업자 통합 보고/, "the master's batch reports each result without a synthesis step");
  } finally { f.close(); }
});

test("wait_results waits for running assignments and returns their status", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "조사", []);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "single" });
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "opinion", message: "m", reason: "r" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    // A peer message releases the master's ask early; wait_results then waits for the same work.
    f.engine.wakeMasterConsults(f.chat.id, "동료 메시지");
    assert.match((await asked).content[0].text, /대기 해제/);
    let done = false;
    const waiting = f.call("wait_results", {}).then((r: any) => { done = true; return r; });
    await delay(30);
    assert.equal(done, false, "still waiting while the consult runs");
    f.worker("클로드 1호").finish(true, false, "조사 결과");
    const r = await waiting;
    assert.match(r.content[0].text, /done/);
    assert.equal((await f.call("wait_results", { consultIds: [99999] })).isError, true);
  } finally { f.close(); }
});

test("a scope-less review/opinion command takes a short command lock: it holds writers off, not other commands or the master", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "조사", []);
    const running = new Map<Role, any>([["claude-1", { kind: "opinion", scope: [], consultId: 7 }], ["claude-3", { kind: "review", scope: [], consultId: 9 }]]);
    f.engine.running.set(f.chat.id, running);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "npm run build" }), null);
    assert.deepEqual(f.engine.scopeLocks.get(f.chat.id), [{ consultId: 7, scope: [], command: true }], "a command lock, not a whole-folder lock");
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-3", command: "npm run lint" }), null, "unscoped commands do not block each other");
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "orch", command: "sleep 5" }), null);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "orch", command: "npm test" }), null, "the master is not blocked by a command lock");
    // A writer waits while the command runs, and goes once the command's tool reports back.
    running.set("claude-2", { kind: "implement", scope: ["repo/src/**"], consultId: 8 });
    assert.match(f.engine.guardApproval(f.chat.id, { role: "claude-2", writes: true, paths: ["repo/src/a.ts"] }) ?? "", /같은 범위를 변경 중/);
    f.engine.releaseCommandLock(f.chat.id, 7);
    f.engine.releaseCommandLock(f.chat.id, 9);
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 0, "released when the command ends");
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-2", writes: true, paths: ["repo/src/a.ts"] }), null);
    // While a writer holds its range: unscoped commands wait, the master's changes wait, reads never do.
    assert.match(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "npm run build" }) ?? "", /같은 범위를 변경 중/);
    assert.match(f.engine.guardApproval(f.chat.id, { role: "orch", command: "npm test" }) ?? "", /작업자가 파일을 변경 중/);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "orch", command: "cd repo && git status" }), null);
    assert.equal(f.engine.guardApproval(f.chat.id, { role: "claude-1", command: "rg foo repo" }), null);
  } finally { f.close(); }
});

test("a worker's tool result ends its command lock", async () => {
  const f = fixture();
  try {
    await f.chats.send(f.chat.id, "조사", []);
    await f.call("route_request", { mode: "delegated", reason: "r", split: "single" });
    await f.call("spawn", { kind: "claude", job: "a" });
    const asked = f.call("ask", { to: "클로드 1호", kind: "opinion", message: "m", reason: "r" });
    await waitFor(() => f.worker("클로드 1호").sendCalls.length === 1);
    const key = f.store.listAgents(f.chat.id)[0].key;
    assert.equal(f.engine.guardApproval(f.chat.id, { role: key, command: "npm run build", toolId: "t1" }), null);
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 1);
    f.worker("클로드 1호").emitEvent({ type: "tool_call", id: "t1", name: "Bash", input: "npm run build" });
    f.worker("클로드 1호").emitEvent({ type: "tool_result", id: "t1", ok: true, output: "" });
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length, 0);
    f.worker("클로드 1호").finish();
    await asked;
  } finally { f.close(); }
});

test("isReadCommand accepts cd chains, discarded stderr and sleep, and still refuses changes", () => {
  for (const c of ["cd /c/Apps/x && rg foo src", "cd repo && git status && git diff --stat", "ls /c/Apps 2>/dev/null | head", "rg x 2>&1 | head -5", "Get-ChildItem 2>$null", "sleep 5", "grep -n plan src/a.ts", "git blame src/a.ts"])
    assert.equal(isReadCommand(c), true, c);
  for (const c of ["cd repo && rm -rf x", "cd repo; rg x", "cd $(pwd) && ls", "ls > out.txt", "rg x 2>err.txt", "cd a b && ls", "npm test", "cd repo && git checkout .", "ls | sort -o out",
    // External programs and output files stay out: git grep's pager command, rg's preprocessor.
    "git grep -Osh foo", "git grep \"-Osh -c 'rm -rf x'\" foo", "git grep --open-files-in-pager=vim foo", "git grep -iO foo", "rg --pre cat x", "cd repo && git grep -Ovim x",
    // nul is a device only for PowerShell/cmd; in a POSIX shell it would create a file.
    "ls 2>nul"])
    assert.equal(isReadCommand(c), false, c);
  assert.equal(isReadCommand(`powershell.exe -Command "Get-ChildItem 2>nul"`), true, "inside a PowerShell wrapper");
  assert.equal(isReadCommand("git grep -n foo"), true);
});

test("plan step helpers: task fields survive checklist updates and the ready group follows group order", () => {
  const steps = validateProposedTasks(goodTasks);
  assert.deepEqual(readyGroupSteps(steps).map((s) => s.id), ["main", "ui"]);
  const updated = validatePlanSteps(steps.map((s) => ({ id: s.id, title: s.title, status: s.id === "main" ? "completed" : s.status })), steps);
  assert.equal(updated[0].scope?.[0], "repo/src/main/**", "a checklist without task fields keeps them");
  assert.deepEqual(readyGroupSteps(updated).map((s) => s.id), ["ui"]);
  const later = updated.map((s) => s.id === "ui" ? { ...s, status: "completed" as const } : s);
  assert.deepEqual(readyGroupSteps(later).map((s) => s.id), ["rev"]);
  assert.throws(() => validatePlanSteps([{ title: "x", kind: "build" }]), /kind/);
  assert.throws(() => validatePlanSteps([{ title: "x", group: 0 }]), /group/);
});

test("bridge deny rules: found in settings files and reported with missing tools", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-deny-"));
  try {
    const home = join(root, "home"), parent = join(root, "Apps"), cwd = join(parent, "repo");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(parent, ".claude"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(parent, ".claude", "settings.local.json"), "﻿" + JSON.stringify({ permissions: { deny: ["CronCreate", "mcp__chatterbox_bridge__ask_parallel", "mcp__chatterbox_bridge__send_message"] } }));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["WebFetch"] } }));
    const rules = findBridgeDenyRules(cwd, home);
    assert.deepEqual(rules.map((r) => r.rules), [["mcp__chatterbox_bridge__ask_parallel", "mcp__chatterbox_bridge__send_message"]]);
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { deny: ["mcp__chatterbox_bridge__ask"] } }));
    assert.equal(findBridgeDenyRules(cwd, home)[0].file, join(cwd, ".claude", "settings.local.json"), "the folder's own settings come first");
    const expected = ["mcp__chatterbox_bridge__ask", "mcp__chatterbox_bridge__ask_parallel"];
    const missing = missingBridgeTools(["Bash", "mcp__chatterbox_bridge__ask"], expected);
    assert.deepEqual(missing, ["mcp__chatterbox_bridge__ask_parallel"]);
    assert.deepEqual(missingBridgeTools(undefined, expected), [], "no tool list, no guess");
    const notice = bridgeDenyNotice(missing, rules)!;
    assert.match(notice, /빠져 있습니다: ask_parallel[^]*permissions\.deny:\n- .*settings\.local\.json: ask_parallel, send_message/);
    assert.equal(bridgeDenyNotice([], rules), undefined, "rules alone never warn: only tools actually missing do");
    assert.equal(bridgeConnected([{ name: "chatterbox_bridge", status: "connected" }]), true);
    assert.equal(bridgeConnected([{ name: "chatterbox_bridge", status: "pending" }]), false, "not judged before the server connects");
    assert.equal(bridgeConnected(undefined), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

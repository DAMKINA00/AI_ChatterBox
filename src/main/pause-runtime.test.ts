import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type AgentEvent, type AgentInput, type AgentKind, type Role } from "../shared/types";
import type { AgentDriver } from "./drivers/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";

type Instruction = {
  id: number;
  mode: "direct" | "delegated";
  dualInvestigation?: boolean;
  text: string;
  asks: number;
  reviews: number;
  startedAt: number;
  requests: Map<string, number>;
  queued: AgentInput[];
  pinned: string[];
  repaired?: boolean;
};

class FakeDriver implements AgentDriver {
  running = false;
  readonly sendCalls: AgentInput[] = [];
  stopCalls = 0;
  emitPartial = false;
  private stopDone = false;

  constructor(
    readonly agent: AgentKind,
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly stopDelayMs: number,
  ) {}

  async send(input: AgentInput) {
    this.sendCalls.push(input);
    this.running = true;
    this.stopDone = false;
    if (this.emitPartial) this.emitEvent({ type: "text", text: "partial worker progress" });
  }

  async stop() {
    this.stopCalls++;
    if (this.stopDone) return;
    this.running = false;
    await delay(this.stopDelayMs);
    if (this.stopDone) return;
    this.stopDone = true;
    this.emitEvent({ type: "turn_end", ok: false, interrupted: true });
  }

  async dispose() {
    this.running = false;
    this.stopDone = true;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs) assert.fail("timed out waiting for fake runtime state");
    await delay(5);
  }
}

function seedInstruction(store: Store, engine: any, chatId: number, text = "pause runtime regression"): Instruction {
  const user = store.addEvent(chatId, "orch", null, { type: "user", text, attachments: [] });
  const instruction: Instruction = {
    id: user.id,
    mode: "delegated",
    text,
    asks: 0,
    reviews: 0,
    startedAt: Date.now(),
    requests: new Map(),
    queued: [],
    pinned: [],
  };
  engine.instructions.set(chatId, instruction);
  store.updateChat(chatId, { status: "working" });
  return instruction;
}

function fixture(options: { stopDelayMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cbx-pause-runtime-"));
  const dbPath = join(root, "test.db");
  const store = new Store(dbPath);
  const project = store.createProject("pause test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "pause test");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const stopDelayMs = options.stopDelayMs ?? 25;
  const drivers = new Map<string, FakeDriver>();

  chats.models = async (agent) => [{
    id: agent === "claude" ? "opus" : agent === "codex" ? "gpt-6-astra" : "gemini-test-medium",
    label: agent,
    isDefault: true,
    reasoningEfforts: ["medium", "high", "xhigh"],
  }];
  chats.cliInfo = () => [
    { agent: "claude", path: "fake-claude" },
    { agent: "codex", path: "fake-codex" },
    { agent: "gemini", path: "fake-gemini" },
  ];

  const driverFor = (chatId: number, role: Role) => {
    const key = `${chatId}:${role}`;
    const existing = drivers.get(key);
    if (existing) return existing;
    const worker = store.agentByKey(chatId, role);
    const agent: AgentKind = role === "orch" ? "claude" : worker?.kind === "gpt" ? "codex" : worker?.kind === "gemini" ? "gemini" : "claude";
    const driver = new FakeDriver(agent, (event) => {
      const node = chats.route(chatId, role);
      chats.emit(chatId, node, role, event);
      chats.onDriverEvent?.(chatId, role, event);
      if (role === "orch" && event.type === "turn_end") chats.orchTurnEnded(chatId, event);
    }, stopDelayMs);
    drivers.set(key, driver);
    const live = (chats as any).live as Map<number, Record<string, unknown>>;
    const slot = live.get(chatId) ?? {};
    slot[role] = { driver, agent, model: "fake", effort: "high" };
    live.set(chatId, slot);
    return driver;
  };

  chats.driver = async (chatId, role) => driverFor(chatId, role);
  const instruction = seedInstruction(store, engine, chat.id);
  let closed = false;
  return {
    root,
    dbPath,
    store,
    project,
    chat,
    chats,
    engine,
    instruction,
    driverFor,
    async close(remove = true) {
      if (closed) return;
      closed = true;
      await engine.judge.dispose();
      await chats.dispose();
      store.close();
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}

test("pause is per chat, waits for stops and queues, preserves the snapshot, and resumes once", async () => {
  const f = fixture({ stopDelayMs: 35 });
  try {
    const other = f.store.createChat(f.project.id, "other chat");
    seedInstruction(f.store, f.engine, other.id, "other chat must continue");
    const otherMaster = f.driverFor(other.id, "orch");
    otherMaster.running = true;

    const master = f.driverFor(f.chat.id, "orch");
    master.running = true;
    f.store.updateChat(f.chat.id, { orchClaudeSessionId: "claude-master-session" });

    f.instruction.asks = 3;
    f.instruction.reviews = 1;
    f.instruction.repaired = true;
    f.instruction.requests.set("previous-request", 2);
    f.instruction.pinned.push("preserved partial note");
    f.instruction.queued.push({ text: "queued before pause", attachments: [] });

    const routed = await f.engine.call(f.chat.id, "orch", "route_request", { mode: "delegated", reason: "pause lifecycle test" });
    assert.equal(routed.isError, false);
    await f.engine.call(f.chat.id, "orch", "spawn", { kind: "claude", job: "implementation" });
    await f.engine.call(f.chat.id, "orch", "spawn", { kind: "gpt", job: "independent check" });
    const claude = f.store.listAgents(f.chat.id).find((agent) => agent.kind === "claude")!;
    const gpt = f.store.listAgents(f.chat.id).find((agent) => agent.kind === "gpt")!;
    const claudeDriver = f.driverFor(f.chat.id, claude.key);
    const gptDriver = f.driverFor(f.chat.id, gpt.key);
    claudeDriver.emitPartial = true;
    f.store.updateAgent(claude.id, { sessionId: "claude-worker-session" });
    f.store.updateAgent(gpt.id, { sessionId: "codex-worker-thread" });

    const claudeAsk = f.engine.call(f.chat.id, "orch", "ask", {
      to: claude.nickname,
      kind: "implement",
      message: "finish the partial implementation",
      reason: "Claude owns the scoped implementation",
      effort: "high",
      scope: ["src/pause-runtime.ts"],
    });
    const gptAsk = f.engine.call(f.chat.id, "orch", "ask", {
      to: gpt.nickname,
      kind: "opinion",
      message: "cross-check the partial implementation",
      reason: "GPT provides an independent check",
      effort: "medium",
    });
    await waitFor(() => f.store.listConsults(f.chat.id).length === 2 && claudeDriver.sendCalls.length === 1 && gptDriver.sendCalls.length === 1);

    f.store.updateProject(f.project.id, { settings: { ...DEFAULT_SETTINGS, approvalMode: "user" } });
    const pendingApproval = f.chats.approvals.request(f.chat.id, f.project.folder, {
      role: claude.key,
      node: claude.key,
      title: "Write",
      detail: "src/pause-runtime.ts",
      key: "Write",
      paths: ["src/pause-runtime.ts"],
      writes: true,
    });
    await waitFor(() => f.store.chat(f.chat.id)?.status === "approval");

    let releaseQueue!: () => void;
    f.engine.workerQueue.set(`${f.chat.id}:queued-consult`, new Promise<void>((resolve) => { releaseQueue = resolve; }));
    const firstPause = f.engine.pause(f.chat.id);
    const duplicatePause = f.engine.pause(f.chat.id);
    assert.strictEqual(firstPause, duplicatePause);
    assert.equal(f.store.chat(f.chat.id)?.status, "pausing");
    assert.equal(otherMaster.stopCalls, 0);
    assert.equal(otherMaster.running, true);

    await delay(8);
    assert.equal(f.store.chat(f.chat.id)?.status, "pausing");
    assert.equal(master.stopCalls, 1);
    assert.equal(claudeDriver.stopCalls, 1);
    assert.equal(gptDriver.stopCalls, 1);
    assert.equal(f.store.chat(other.id)?.status, "working");

    const savedBeforeQueue = JSON.parse(f.store.getSetting(`pause:${f.chat.id}`)!);
    assert.equal(savedBeforeQueue.instruction.id, f.instruction.id);
    assert.equal(savedBeforeQueue.instruction.asks, 5);
    assert.equal(savedBeforeQueue.instruction.reviews, 1);
    assert.equal(savedBeforeQueue.instruction.repaired, true);
    const savedRequests = new Map<string, number>(savedBeforeQueue.instruction.requests);
    assert.equal(savedRequests.get("previous-request"), 2);
    assert.equal(savedRequests.size, f.instruction.requests.size);
    assert.equal(savedBeforeQueue.assignments.length, 2);
    const savedImplementation = savedBeforeQueue.assignments.find((a: any) => a.target.key === claude.key);
    assert.deepEqual(savedImplementation.scope, ["src/pause-runtime.ts"]);
    assert.equal(savedImplementation.message, "finish the partial implementation");

    releaseQueue();
    await firstPause;
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");
    assert.equal(otherMaster.stopCalls, 0);
    assert.equal(otherMaster.running, true);
    assert.match(f.store.listConsults(f.chat.id).find((c) => c.toRole === claude.key)?.responseSummary ?? "", /partial worker progress/);
    assert.equal((await pendingApproval).verdict, "deny");
    const expired = f.store.events(f.chat.id).findLast((e) => e.event.type === "approval_resolved");
    assert.equal(expired?.event.type === "approval_resolved" && expired.event.decision, "expired");
    await Promise.all([claudeAsk, gptAsk]);

    const blockedAgents = await f.engine.call(f.chat.id, "orch", "agents", {});
    assert.equal(blockedAgents.isError, false);
    const agentCount = f.store.listAgents(f.chat.id).length;
    for (const [name, args] of [
      ["route_request", { mode: "delegated", reason: "must be blocked while paused" }],
      ["spawn", { kind: "claude", job: "must not start" }],
      ["ask", { to: claude.nickname, kind: "opinion", message: "must not start", reason: "paused", effort: "medium" }],
    ] as const) {
      const blocked = await f.engine.call(f.chat.id, "orch", name, args);
      assert.equal(blocked.isError, true, name);
    }
    assert.equal(f.store.listAgents(f.chat.id).length, agentCount);
    const guard = f.chats.approvalGuard?.(f.chat.id, {
      role: "orch",
      node: "orch",
      title: "Write",
      detail: "src/pause-runtime.ts",
      key: "Write",
      writes: true,
    });
    assert.match(guard ?? "", /작업이 중지되었습니다/);

    const pausedInputCount = master.sendCalls.length + claudeDriver.sendCalls.length + gptDriver.sendCalls.length;
    await f.chats.send(f.chat.id, "queued while paused", [], "now");
    assert.equal(master.sendCalls.length + claudeDriver.sendCalls.length + gptDriver.sendCalls.length, pausedInputCount);
    const queuedState = JSON.parse(f.store.getSetting(`pause:${f.chat.id}`)!);
    assert.ok(queuedState.instruction.queued.some((input: AgentInput) => input.text === "queued while paused"));
    assert.ok(f.store.events(f.chat.id).some((e) => e.event.type === "user" && e.event.queued && e.event.text === "queued while paused"));

    f.chats.emit(f.chat.id, "orch", "orch", { type: "turn_end", ok: true });
    f.chats.onDriverEvent?.(f.chat.id, "orch", { type: "turn_end", ok: true });
    f.chats.orchTurnEnded(f.chat.id, { type: "turn_end", ok: true });
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");

    const beforeResume = JSON.parse(f.store.getSetting(`pause:${f.chat.id}`)!);
    const originalConsults = f.store.listConsults(f.chat.id);
    const originalImplementation = originalConsults.find((c) => c.toRole === claude.key)!;
    const resume = f.engine.resume(f.chat.id);
    const duplicateResume = f.engine.resume(f.chat.id);
    await Promise.all([resume, duplicateResume]);
    await waitFor(() => claudeDriver.sendCalls.length === 2 && gptDriver.sendCalls.length === 2 && master.sendCalls.length === 1);
    assert.equal(f.store.chat(f.chat.id)?.status, "working");
    assert.equal(master.sendCalls.length, 1);
    assert.equal(claudeDriver.sendCalls.length, 2);
    assert.equal(gptDriver.sendCalls.length, 2);
    assert.equal(f.store.chat(f.chat.id)?.orchClaudeSessionId, "claude-master-session");
    assert.equal(f.store.agentByKey(f.chat.id, claude.key)?.sessionId, "claude-worker-session");
    assert.equal(f.store.agentByKey(f.chat.id, gpt.key)?.sessionId, "codex-worker-thread");

    const restored = f.engine.instructions.get(f.chat.id);
    assert.equal(restored.id, beforeResume.instruction.id);
    assert.equal(restored.startedAt, beforeResume.instruction.startedAt);
    assert.equal(restored.asks, beforeResume.instruction.asks);
    assert.equal(restored.reviews, beforeResume.instruction.reviews);
    assert.equal(restored.repaired, true);
    assert.deepEqual([...restored.requests.entries()], beforeResume.instruction.requests);
    assert.ok(master.sendCalls[0].text.includes("queued before pause"));
    assert.ok(master.sendCalls[0].text.includes("queued while paused"));
    assert.ok(restored.pinned.some((note: string) => note.includes("queued while paused")));

    await waitFor(() => f.store.listConsults(f.chat.id).length >= 4);
    const resumedImplementation = f.store.listConsults(f.chat.id).find((c) => c.supersedes === originalImplementation.id)!;
    assert.deepEqual(resumedImplementation.scope, ["src/pause-runtime.ts"]);
    assert.equal(resumedImplementation.instructionId, f.instruction.id);
    assert.match(claudeDriver.sendCalls[1].text, /finish the partial implementation/);
    assert.match(claudeDriver.sendCalls[1].text, /partial worker progress/);

    await f.engine.stop(f.chat.id);
  } finally {
    await f.close();
  }
});

test("planning survives pause, keeps the write guard, and sends the resumed master as no-writes", async () => {
  const f = fixture();
  try {
    f.engine.planning.add(f.chat.id);
    const master = f.driverFor(f.chat.id, "orch");
    master.running = true;
    await f.engine.pause(f.chat.id);
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");
    const denied = f.chats.approvalGuard?.(f.chat.id, {
      role: "orch",
      node: "orch",
      title: "Write",
      detail: "src/plan.ts",
      key: "Write",
      writes: true,
    });
    assert.match(denied ?? "", /작업이 중지되었습니다/);
    await f.engine.resume(f.chat.id);
    await waitFor(() => master.sendCalls.length === 1);
    assert.equal(master.sendCalls[0].noWrites, true);
    await f.engine.stop(f.chat.id);
  } finally {
    await f.close();
  }
});

test("a paused chat and its snapshot survive Store restart", async () => {
  const f = fixture();
  try {
    await f.engine.pause(f.chat.id);
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");
    assert.ok(f.store.getSetting(`pause:${f.chat.id}`));
    const chatId = f.chat.id;
    const dbPath = f.dbPath;
    await f.close(false);

    const reopened = new Store(dbPath);
    try {
      assert.equal(reopened.chat(chatId)?.status, "paused");
      const saved = JSON.parse(reopened.getSetting(`pause:${chatId}`)!);
      assert.equal(saved.instruction.id, f.instruction.id);
      assert.equal(saved.folder, f.project.folder);
      reopened.updateChat(chatId, { status: "paused" });
    } finally {
      reopened.close();
      rmSync(f.root, { recursive: true, force: true });
    }
    return;
  } finally {
    await f.close();
  }
});

test("stop after pause hard-clears the saved pause state", async () => {
  const f = fixture();
  try {
    await f.engine.pause(f.chat.id);
    await f.engine.stop(f.chat.id);
    assert.equal(f.store.getSetting(`pause:${f.chat.id}`), "");
    assert.equal(f.store.chat(f.chat.id)?.status, "idle");
  } finally {
    await f.close();
  }
});

test("late master preparation from an earlier resume cannot restart after a newer pause/play", async () => {
  for (const fail of [false, true]) {
  const f = fixture();
  try {
    await f.engine.pause(f.chat.id);
    const driver = f.driverFor(f.chat.id, "orch");
    let release!: (driver: AgentDriver) => void;
    let reject!: (error: Error) => void;
    let calls = 0;
    f.chats.driver = async () => ++calls === 1 ? new Promise<AgentDriver>((resolve, fail) => { release = resolve; reject = fail; }) : driver;
    const oldResume = f.engine.resume(f.chat.id);
    await waitFor(() => calls === 1);
    await f.engine.pause(f.chat.id);
    assert.equal(f.store.chat(f.chat.id)?.status, "paused");
    await f.engine.resume(f.chat.id);
    assert.equal(driver.sendCalls.length, 1);
    if (fail) reject(new Error("late preparation failure")); else release(driver);
    await oldResume;
    assert.equal(driver.sendCalls.length, 1);
    assert.equal(f.store.chat(f.chat.id)?.status, "working");
    assert.equal(f.store.events(f.chat.id).filter(e => e.event.type === "error").length, 0);
    await f.engine.stop(f.chat.id);
  } finally {
    await f.close();
  }
  }
});

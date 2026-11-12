import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, priorityOrder, type CliAccountId, type CliAccountKind, type Role } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { Orchestrator } from "./orchestrator";
import {
  PRIORITY_COOLDOWN_MS, isAuthError, isQuotaError, priorityFailure, priorityFailureActive, priorityRecovered, prioritySkipReason,
  resolveAccountPolicy, sanitizePolicies, validPolicy,
} from "./cli-accounts";
import { CodexServer } from "./drivers/codex";

/** Per account: "ok" finishes, "hold" keeps running, any other string fails the turn with that error. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-priority-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("priority", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "priority");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.cliInfo = () => ["claude", "codex", "grok"].map(agent => ({ agent, path: "fake.exe" })) as any;
  chats.assignmentEffort = async (_chatId, _role, requested) => ({ requestedEffort: requested ?? "medium", effort: requested ?? "medium" });
  const plan = new Map<CliAccountId, string>();
  const sent: { role: Role; accountId: CliAccountId | undefined; text: string }[] = [];
  const closes: CliAccountId[] = [];
  chats.driver = async (_id, role) => {
    const accountId = chats.roleAccount(chat.id, role)?.accountId;
    const driver: any = {
      agent: "codex", running: false,
      stop: async () => { driver.running = false; chats.onDriverEvent!(chat.id, role, { type: "turn_end", ok: false, interrupted: true }); },
      dispose: async () => { driver.running = false; },
      closeStrict: async () => { closes.push(accountId!); driver.running = false; },
      send: async (input: any) => {
        driver.running = true;
        sent.push({ role, accountId, text: input.text });
        chats.onDriverEvent!(chat.id, role, { type: "text", text: `draft from ${accountId}` });
        const action = plan.get(accountId!) ?? "ok";
        if (action === "hold") return;
        driver.running = false;
        chats.onDriverEvent!(chat.id, role, action === "ok" ? { type: "turn_end", ok: true } : { type: "turn_end", ok: false, error: action });
      },
    };
    const slot = (chats as any).live.get(chat.id) ?? {};
    slot[role] = { driver, agent: "codex", accountId };
    (chats as any).live.set(chat.id, slot);
    return driver;
  };
  const engine = new Orchestrator(chats) as any;
  engine.instructions.set(chat.id, { id: 1, mode: "delegated", text: "priority", asks: 0, reviews: 0, startedAt: Date.now(), requests: new Map(), queued: [], pinned: [] });
  let n = 0;
  const call = (name: string, args: any = {}, caller: Role = "orch") => engine.call(chat.id, caller, name, args);
  const ask = (nickname: string, extra: any = {}) => call("ask", { to: nickname, kind: "opinion", message: `task ${++n}`, reason: "priority test", effort: "medium", ...extra });
  const add = (kind: CliAccountKind) => { chats.createCliAccount(kind); return chats.listCliAccounts(kind).at(-1)!.accountId; };
  const priority = (order?: CliAccountId[], where: "project" | "global" = "project") => {
    const policy = { gpt: { mode: "priority" as const, ...(order ? { order } : {}) } };
    if (where === "global") chats.setCliAccountPolicy(policy);
    else store.updateProject(project.id, { settings: { ...store.project(project.id)!.settings, accountPolicy: policy } });
  };
  return { root, store, project, chat, chats, engine, call, ask, add, plan, sent, closes, priority,
    async close() { await engine.judge.dispose(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const body = (r: any) => r.content.map((c: any) => c.text).join("\n");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("priority schema keeps a same-family order, rejects malformed lists and leaves fixed/auto files untouched", () => {
  assert.deepEqual(validPolicy("gpt", { mode: "priority", order: ["gpt-3", "gpt-1", "gpt-3"] }), { mode: "priority", order: ["gpt-3", "gpt-1"] });
  assert.deepEqual(validPolicy("gpt", { mode: "priority", order: [] }), { mode: "priority" });
  for (const order of [["claude-1"], ["gpt-0"], "gpt-1", Array.from({ length: 11 }, () => "gpt-1")]) assert.equal(validPolicy("gpt", { mode: "priority", order }), undefined, JSON.stringify(order));
  // Older settings: fixed/auto keep exactly their shape (an order on them is ignored).
  assert.deepEqual(validPolicy("gpt", { mode: "fixed", accountId: "gpt-2" }), { mode: "fixed", accountId: "gpt-2" });
  assert.deepEqual(validPolicy("gpt", { mode: "auto", order: ["gpt-2"] }), { mode: "auto" });
  assert.deepEqual(sanitizePolicies({ claude: { mode: "priority", order: ["claude-2", "claude-1"] }, gpt: { mode: "auto" } }), { claude: { mode: "priority", order: ["claude-2", "claude-1"] }, gpt: { mode: "auto" } });
  // Empty order: the policy account, then *-1.
  assert.deepEqual(priorityOrder("gpt", { order: [] }), ["gpt-1"]);
  assert.deepEqual(priorityOrder("gpt", { accountId: "gpt-3" }), ["gpt-3", "gpt-1"]);
  assert.deepEqual(priorityOrder("gpt", { accountId: "gpt-3", order: ["gpt-2"] }), ["gpt-2"]);
  assert.deepEqual(resolveAccountPolicy("gpt", { gpt: { mode: "priority", order: ["gpt-3", "gpt-1"] } }, undefined), { kind: "gpt", mode: "priority", accountId: "gpt-3", source: "project", order: ["gpt-3", "gpt-1"] });
  assert.deepEqual(resolveAccountPolicy("gpt", undefined, { gpt: { mode: "priority" } }, "gpt-2"), { kind: "gpt", mode: "priority", accountId: "gpt-2", source: "explicit", order: ["gpt-1"] });
  assert.deepEqual(resolveAccountPolicy("claude", undefined, { gpt: { mode: "priority" } }), { kind: "claude", mode: "fixed", accountId: "claude-1", source: "default" });
});

test("priority failure cooldowns use the limit reset, fixed waits and clear on a newer recovered reading", () => {
  const at = 1_800_000_000_000;
  assert.equal(priorityFailure("auth", undefined, at).until, at + PRIORITY_COOLDOWN_MS.auth);
  assert.equal(priorityFailure("unresponsive", undefined, at).until, at + 10 * 60_000);
  assert.equal(priorityFailure("quota", undefined, at).until, at + 30 * 60_000);
  const reset = (at + 3 * 3_600_000) / 1000;
  const exhausted = { usage: { checkedAt: at, fiveHour: { usedPercent: 100, resetsAt: reset }, weekly: { usedPercent: 40, resetsAt: reset + 86_400 } } };
  assert.equal(priorityFailure("quota", exhausted, at).until, reset * 1000);
  const failure = priorityFailure("quota", undefined, at);
  assert.equal(priorityFailureActive(failure, at + 1000), true);
  assert.equal(priorityFailureActive(failure, failure.until), false);
  assert.equal(priorityFailureActive(undefined, at), false);
  const account = (patch: any = {}) => ({ accountId: "gpt-2" as const, kind: "gpt" as const, label: "b", configDir: "x", enabled: true, createdAt: 1, ...patch });
  assert.equal(prioritySkipReason(account(), undefined, at), undefined, "unknown usage is tried");
  assert.equal(prioritySkipReason(account({ enabled: false }), undefined, at), "배정 제외");
  assert.equal(prioritySkipReason(account({ auth: { loggedIn: false, checkedAt: at } }), undefined, at), "로그인 필요");
  assert.equal(prioritySkipReason(account({ usage: { checkedAt: at, fiveHour: { usedPercent: 100 } } }), undefined, at), "잔여 0%");
  assert.equal(prioritySkipReason(account({ usage: { checkedAt: at - 700_000, fiveHour: { usedPercent: 100 } } }), undefined, at), undefined, "a stale 0% is unknown");
  assert.equal(prioritySkipReason(account(), failure, at + 1000), "최근 한도 소진");
  for (const e of ["API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}", "Not logged in · Please run /login", "로그인이 필요합니다.", "CLI 계정 gpt-2은(는) 배정에서 제외되어 있어 실행하지 않았습니다."]) assert.equal(isAuthError(e), true, e);
  for (const e of ["compile failed", "reached max turns limit", "context length limit reached"]) { assert.equal(isAuthError(e), false, e); assert.equal(isQuotaError(e), false, e); }
});

test("[review 2-4] recovery counts only checks that began after the failure and applies to every failure kind", () => {
  const at = 1_800_000_000_000;
  const quota = priorityFailure("quota", undefined, at), auth = priorityFailure("auth", undefined, at), silent = priorityFailure("unresponsive", undefined, at);
  // A reading that began before (or at) the failure never counts, however late it arrives.
  for (const startedAt of [at - 60_000, at]) for (const f of [quota, auth, silent])
    assert.equal(priorityRecovered(f, { startedAt, remaining: 80, loggedIn: true }), false, `${f.reason}@${startedAt}`);
  // Limit: remaining > 0 only.
  assert.equal(priorityRecovered(quota, { startedAt: at + 1, remaining: 80 }), true);
  assert.equal(priorityRecovered(quota, { startedAt: at + 1, remaining: 0 }), false);
  assert.equal(priorityRecovered(quota, { startedAt: at + 1, loggedIn: true }), false);
  // Sign-in: a confirmed login (a usage number alone is not proof of a fixed sign-in).
  assert.equal(priorityRecovered(auth, { startedAt: at + 1, loggedIn: true }), true);
  assert.equal(priorityRecovered(auth, { startedAt: at + 1, remaining: 80 }), false);
  // No response: either.
  assert.equal(priorityRecovered(silent, { startedAt: at + 1, remaining: 80 }), true);
  assert.equal(priorityRecovered(silent, { startedAt: at + 1, loggedIn: true }), true);
  assert.equal(priorityRecovered(silent, { startedAt: at + 1 }), false);
});

test("[review 5] provider limits are recognized while disk quotas, line numbers and context limits are not", () => {
  const provider = [
    "rate_limit_exceeded", "usage_limit_reached", "insufficient_quota", "429 Too Many Requests", "HTTP 429", "status: 429",
    "You've hit your limit", "You exceeded your current quota, please check your plan and billing details",
    "Claude AI usage limit reached|1760000000", "5-hour limit reached", "Weekly limit reached · resets Mon",
    "Quota exceeded", "API quota exhausted", "RESOURCE_EXHAUSTED", "사용량 한도 초과", "한도 소진",
  ];
  const ordinary = [
    "Disk quota exceeded", "write failed: EDQUOT (disk quota exceeded)", "error: user quota exceeded on /home",
    "No space left: filesystem quota exceeded", "storage quota exceeded for volume D:", "quota exceeded on device /dev/sda1",
    "src/app.ts:429: Type error", "error at line 429", "reached max turns limit", "exceeded context window limit",
    "context length limit reached", "최대 턴 한도 초과", "컨텍스트 한도 초과", "compile failed",
  ];
  for (const e of provider) assert.equal(isQuotaError(e), true, e);
  for (const e of ordinary) assert.equal(isQuotaError(e), false, e);
});

test("priority assigns the first usable account, skipping disabled, signed-out and confirmed-0% accounts but trying unknown usage", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt"); f.add("gpt");
    f.priority(["gpt-3", "gpt-4", "gpt-2", "gpt-1"]);
    const worker = f.store.createAgent(f.chat.id, "gpt", "first");
    assert.equal((await f.ask(worker.nickname)).isError, false);
    assert.equal(f.sent[0].accountId, "gpt-3");
    f.chats.updateCliAccount("gpt-3", { enabled: false });
    f.chats.cliAccounts().setAuth("gpt-4", { loggedIn: false, checkedAt: Date.now() });
    f.chats.cliAccounts().setUsage("gpt-2", { fiveHour: { usedPercent: 100 } }, false);
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, false);
    assert.equal(f.sent[1].accountId, "gpt-1");
    assert.match(body(reply), /gpt-3 건너뜀\(배정 제외\), gpt-4 건너뜀\(로그인 필요\), gpt-2 건너뜀\(잔여 0%\)/);
    assert.match(body(reply), /모드=priority/);
    const info = JSON.parse(body(await f.call("cli_accounts", { kind: "gpt" })));
    assert.deepEqual(info.policies.gpt.order, ["gpt-3", "gpt-4", "gpt-2", "gpt-1"]);
    assert.deepEqual(info.policies.gpt.priorityState.map((s: any) => s.skip), ["배정 제외", "로그인 필요", "잔여 0%", null]);
    // Nothing usable: refused before dispatch with the reasons.
    f.chats.cliAccounts().setUsage("gpt-1", { fiveHour: { usedPercent: 100 } }, false);
    const none = await f.ask(worker.nickname);
    assert.equal(none.isError, true); assert.match(body(none), /사용할 수 있는 gpt 계정이 없어 맡기지 않았습니다.*gpt-1\(잔여 0%\)/);
    assert.equal(f.sent.length, 2);
  } finally { await f.close(); }
});

test("priority continues a quota-failed consult on the next account with a handover and reports the switch", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    f.priority(["gpt-1", "gpt-2", "gpt-3"], "global");
    f.plan.set("gpt-1", "usage_limit_reached");
    const worker = f.store.createAgent(f.chat.id, "gpt", "failover");
    const reply = await f.ask(worker.nickname, { message: "finish the report" });
    assert.equal(reply.isError, false, body(reply));
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.match(f.sent[1].text, /^[\s\S]*finish the report[\s\S]*\[앱 우선 할당 전환\] 이전 계정 gpt-1에서 한도 소진/);
    assert.match(f.sent[1].text, /draft from gpt-1/);
    assert.match(body(reply), /우선 할당: gpt-1 실패\(한도 소진\) → gpt-2로 전환 · 실제 실행 계정=gpt-2/);
    assert.match(body(reply), /지정 계정=gpt-1 · 실제 실행 계정=gpt-2/);
    assert.doesNotMatch(body(reply), /자동 계정 전환·재시도 없음/);
    const consults = f.store.listConsults(f.chat.id);
    assert.equal(consults.length, 1); assert.equal(consults[0].status, "done");
    assert.match(consults[0].responseSummary!, /draft from gpt-2/);
  } finally { await f.close(); }
});

test("priority switches on sign-in failures and reports every attempt when all accounts fail", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    f.priority(["gpt-1", "gpt-2", "gpt-3"]);
    f.chats.updateCliAccount("gpt-3", { enabled: false });
    f.plan.set("gpt-1", "unexpected status 401 Unauthorized, url: https://chatgpt.com/backend-api/codex/responses"); f.plan.set("gpt-2", "rate_limit_exceeded");
    const worker = f.store.createAgent(f.chat.id, "gpt", "all fail");
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, true);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.match(body(reply), /우선 할당: 시도한 계정 모두 실패 — gpt-1\(인증 실패: unexpected status 401 Unauthorized, url: https:\/\/chatgpt\.com\/backend-api\/codex\/responses\), gpt-2\(한도 소진: rate_limit_exceeded\) · 남은 계정: gpt-3\(배정 제외\)/);
    assert.match(body(reply), /우선 할당 목록에 이어서 실행할 계정이 남지 않아/);
    assert.equal(f.store.listConsults(f.chat.id).length, 1);
  } finally { await f.close(); }
});

test("priority never switches for ordinary failures or stops, and fixed/auto quota failures stay as before", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    f.plan.set("gpt-1", "compile failed");
    const worker = f.store.createAgent(f.chat.id, "gpt", "plain failure");
    const failed = await f.ask(worker.nickname);
    assert.equal(failed.isError, true); assert.equal(f.sent.length, 1);
    assert.doesNotMatch(body(failed), /우선 할당:/);
    f.plan.set("gpt-1", "hold");
    const pending = f.ask(worker.nickname); await flush();
    f.engine.stopped.add(f.chat.id);
    const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
    live.running = false; f.chats.onDriverEvent!(f.chat.id, worker.key, { type: "turn_end", ok: false, error: "usage_limit_reached" });
    await pending;
    assert.equal(f.sent.length, 2, "a stop never moves to another account");
    f.engine.stopped.delete(f.chat.id);
    for (const mode of ["fixed", "auto"] as const) {
      f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { gpt: mode === "fixed" ? { mode, accountId: "gpt-1" } : { mode } } } });
      f.plan.set("gpt-1", "usage_limit_reached");
      const before = f.sent.length;
      const reply = await f.ask(worker.nickname);
      assert.equal(reply.isError, true); assert.equal(f.sent.length, before + 1, mode);
      assert.match(body(reply), /자동 계정 전환·재시도 없음/);
    }
  } finally { await f.close(); }
});

test("priority returns to the first account once it recovers; a running assignment keeps its account", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    const worker = f.store.createAgent(f.chat.id, "gpt", "return");
    f.plan.set("gpt-1", "usage_limit_reached");
    assert.equal((await f.ask(worker.nickname)).isError, false);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    // Cooling down: the next assignment starts on gpt-2 without retrying gpt-1.
    f.plan.set("gpt-1", "ok");
    const second = await f.ask(worker.nickname);
    assert.equal(f.sent.at(-1)!.accountId, "gpt-2"); assert.match(body(second), /gpt-1 건너뜀\(최근 한도 소진\)/);
    // Hold an assignment on gpt-2, then gpt-1 recovers: the running one stays on gpt-2.
    f.plan.set("gpt-2", "hold");
    const pending = f.ask(worker.nickname); await flush();
    assert.equal(f.sent.at(-1)!.accountId, "gpt-2");
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 } } }, "gpt-1", undefined, Date.now() + 5);
    assert.equal(f.chats.roleAccount(f.chat.id, worker.key)!.accountId, "gpt-2");
    const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
    live.running = false; f.chats.onDriverEvent!(f.chat.id, worker.key, { type: "turn_end", ok: true });
    assert.equal((await pending).isError, false);
    assert.equal(f.chats.roleAccount(f.chat.id, worker.key)!.accountId, "gpt-1");
    await f.ask(worker.nickname);
    assert.equal(f.sent.at(-1)!.accountId, "gpt-1");
  } finally { await f.close(); }
});

test("priority uses an explicit account first and falls back to the order when it fails", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    const spawn = await f.call("spawn", { kind: "gpt", job: "explicit", accountId: "gpt-3" });
    assert.equal(spawn.isError, false, "priority never rejects an explicit account like fixed does");
    const worker = f.store.listAgents(f.chat.id)[0];
    f.plan.set("gpt-3", "You've hit your limit");
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, false);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-3", "gpt-1"]);
    assert.match(body(reply), /우선 할당: gpt-3 실패\(한도 소진\) → gpt-1로 전환/);
    assert.match(body(reply), /출처=explicit/);
    // A saved binding that becomes unusable falls back to the order before dispatch.
    f.chats.updateCliAccount("gpt-3", { enabled: false });
    f.plan.set("gpt-3", "ok");
    const next = await f.ask(worker.nickname);
    assert.equal(next.isError, false); assert.equal(f.sent.at(-1)!.accountId, "gpt-1");
    assert.match(body(next), /지정 계정 gpt-3 사용 불가\(배정 제외\)/);
  } finally { await f.close(); }
});

test("priority treats a master recover of a silent worker as no response and continues on the next account", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    f.plan.set("gpt-1", "hold");
    const worker = f.store.createAgent(f.chat.id, "gpt", "silent");
    const pending = f.ask(worker.nickname); await flush();
    const recovered = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(recovered.isError, false);
    assert.match(body(recovered), /다음 계정으로 이어서 실행.*재배정하지 말고/);
    const reply = await pending;
    assert.equal(reply.isError, false, body(reply));
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.match(body(reply), /gpt-1 실패\(무응답\) → gpt-2로 전환/);
  } finally { await f.close(); }
});

test("removing an account drops it from priority orders and the master rules describe the priority mode", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    f.priority(["gpt-2", "gpt-3", "gpt-1"]);
    f.chats.setCliAccountPolicy({ gpt: { mode: "priority", order: ["gpt-3", "gpt-2"] }, claude: { mode: "auto" } });
    await f.chats.removeCliAccount("gpt-2");
    assert.deepEqual(f.store.project(f.project.id)!.settings.accountPolicy, { gpt: { mode: "priority", order: ["gpt-3", "gpt-1"] } });
    assert.deepEqual(f.chats.getCliAccountPolicy(), { gpt: { mode: "priority", order: ["gpt-3"] }, claude: { mode: "auto" } });
    await f.chats.removeCliAccount("gpt-3");
    assert.deepEqual(f.chats.getCliAccountPolicy().gpt, { mode: "priority" });
    assert.deepEqual(f.chats.resolveAccountPolicy("gpt", undefined).order, ["gpt-1"]);
    assert.deepEqual(f.chats.sanitizeAccountPolicy({ gpt: { mode: "priority", order: ["gpt-9", "gpt-1"] } }), { gpt: { mode: "priority", order: ["gpt-1"] } });
    assert.throws(() => f.chats.setCliAccountPolicy({ gpt: { mode: "priority", order: ["gpt-9"] } }), /등록되지 않은/);
    const rules = f.chats.instructionsFor!(f.chat, f.project, "orch", "codex")!;
    assert.match(rules, /priority\(계정 우선 할당\)에서는 앱이/);
    assert.match(rules, /fixed·auto에서 앱은 CLI 한도 소진 시 자동 계정 전환이나 작업 재시도를 하지 않는다/);
  } finally { await f.close(); }
});

test("[review 2-3] a usage read that began before the failure never clears it, and a cleared failure never revives", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    const order = ["gpt-1", "gpt-2"] as CliAccountId[];
    const skipOf = (now = Date.now()) => f.chats.priorityCandidates(order, now)[0].skip;
    const t = Date.now();
    f.chats.markPriorityFailure("gpt-1", "quota", t);
    // Codex: a rate-limit read started before the failure and answered after it keeps its start time.
    let seenStart: number | undefined;
    await CodexServer.prototype.readUsage.call({
      ensure: async () => {},
      request: async () => { f.chats.markPriorityFailure("gpt-1", "quota", Date.now() + 1); return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }; },
      onUsage: (u: any, startedAt?: number) => { seenStart = startedAt; f.chats.mergeUsage(u, "gpt-1", undefined, startedAt); },
    } as any);
    assert.ok(seenStart !== undefined && seenStart <= f.chats.priorityFailureOf("gpt-1")!.at, "start time travels with the late answer");
    assert.equal(skipOf(), "최근 한도 소진", "a late answer to an earlier read is not recovery");
    const failedAt = f.chats.priorityFailureOf("gpt-1")!.at;
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 } } }, "gpt-1", undefined, failedAt - 1);
    assert.equal(skipOf(), "최근 한도 소진");
    // A read that began after the failure clears it and removes the record.
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 } } }, "gpt-1", undefined, failedAt + 1);
    assert.equal(f.chats.priorityFailureOf("gpt-1"), undefined);
    assert.equal(skipOf(), undefined);
    // Eleven minutes later the reading is stale (unknown): still tried, the old failure does not come back.
    assert.equal(skipOf(failedAt + 11 * 60_000), undefined);
  } finally { await f.close(); }
});

test("[review 4] sign-in and no-response failures clear on a newer login check; sign-in ignores a usage number", async () => {
  const f = fixture();
  try {
    f.add("gpt"); f.add("gpt");
    const t = Date.now();
    f.chats.markPriorityFailure("gpt-2", "auth", t);
    f.chats.markPriorityFailure("gpt-3", "unresponsive", t);
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 } } }, "gpt-2", undefined, t + 1);
    assert.equal(f.chats.priorityFailureOf("gpt-2")?.reason, "auth", "a usage number does not prove the sign-in was fixed");
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 } } }, "gpt-3", undefined, t + 1);
    assert.equal(f.chats.priorityFailureOf("gpt-3"), undefined, "no response clears on a newer usable reading");
    // The real login check path: one that began before the failure does not count, a later one does.
    f.chats.codex = (() => ({ ensure: async () => {}, request: async () => { f.chats.markPriorityFailure("gpt-2", "auth", Date.now() + 1); return { account: { email: "a@example.com" } }; } })) as any;
    await (f.chats as any).refreshAccountAuth("gpt-2", f.chats.accountToken("gpt-2"));
    assert.equal(f.chats.priorityFailureOf("gpt-2")?.reason, "auth");
    await new Promise(resolve => setTimeout(resolve, 5));
    f.chats.codex = (() => ({ ensure: async () => {}, request: async () => ({ account: { email: "a@example.com" } }) })) as any;
    await (f.chats as any).refreshAccountAuth("gpt-2", f.chats.accountToken("gpt-2"));
    assert.equal(f.chats.priorityFailureOf("gpt-2"), undefined);
    f.chats.markPriorityFailure("gpt-3", "unresponsive", Date.now() - 10);
    await (f.chats as any).refreshAccountAuth("gpt-3", f.chats.accountToken("gpt-3"));
    assert.equal(f.chats.priorityFailureOf("gpt-3"), undefined, "no response also clears on a confirmed login");
  } finally { await f.close(); }
});

test("[review 1] an unconfirmed exit holds the switch and the scope, alerts the master, and recover resumes it", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.priority(["gpt-1", "gpt-2"]);
    const worker = f.store.createAgent(f.chat.id, "gpt", "stuck");
    f.plan.set("gpt-1", "hold");
    const pending = f.call("ask", { to: worker.nickname, kind: "implement", message: "edit", reason: "priority test", effort: "medium", scope: ["src/**"] });
    await flush();
    const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
    let disposeFails = true;
    live.closeStrict = async () => { if (disposeFails) throw new Error("taskkill failed"); live.running = false; };
    live.running = false; f.chats.onDriverEvent!(f.chat.id, worker.key, { type: "turn_end", ok: false, error: "usage_limit_reached" });
    // The master's wait is released with the failure report; the consult itself stays open.
    const released = body(await pending);
    assert.match(released, /우선 할당 전환 실패: 이전 계정 gpt-1의 실행 종료를 확인하지 못해.*recover=true/);
    const consult = () => f.store.listConsults(f.chat.id)[0];
    assert.equal(consult().status, "running", "the consult stays open");
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"], "no run on the next account");
    assert.ok(f.engine.scopeLocks.get(f.chat.id)?.length, "the write scope stays locked");
    assert.equal(f.chats.liveDriver(f.chat.id, worker.key), live, "the handle stays for recover");
    const check = JSON.parse(body(await f.call("check_agent", { to: worker.nickname })));
    assert.match(check.error, /전환 실패: 이전 계정 gpt-1의 실행 종료를 확인하지 못해 다음 계정 gpt-2로 전환하지 않았습니다\(taskkill failed\)/);
    assert.match(body(await f.call("agents")), /우선 할당: gpt-1 실패\(한도 소진\) → 전환 보류/);
    const alert = f.store.events(f.chat.id).find(e => e.event.type === "room_message" && e.event.text.includes("recover=true"));
    assert.ok(alert, "the master is told to clean up");
    // Recover confirms the exit; the app then continues on gpt-2 and the result keeps the first cause.
    disposeFails = false;
    const recovered = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(recovered.isError, false, body(recovered));
    assert.match(body(recovered), /다음 계정으로 이어서 실행/);
    for (let i = 0; i < 50 && consult().status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(consult().status, "done");
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.match(consult().responseSummary!, /우선 할당: gpt-1 실패\(한도 소진\) → gpt-2로 전환 · 실제 실행 계정=gpt-2/);
    assert.equal(f.engine.scopeLocks.get(f.chat.id)?.length ?? 0, 0, "released only after the run ends");
  } finally { await f.close(); }
});

/** Starts a held priority implement on gpt-1, fails it with a limit while closing keeps failing. */
async function heldSwitch(f: ReturnType<typeof fixture>) {
  f.add("gpt");
  f.priority(["gpt-1", "gpt-2"]);
  const worker = f.store.createAgent(f.chat.id, "gpt", "stuck");
  f.plan.set("gpt-1", "hold");
  const pending = f.call("ask", { to: worker.nickname, kind: "implement", message: "edit", reason: "priority test", effort: "medium", scope: ["src/**"] });
  await flush();
  const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
  const state = { fail: true, calls: 0, disposes: 0 };
  live.closeStrict = async () => { state.calls++; if (state.fail) throw new Error("taskkill failed"); live.running = false; };
  live.dispose = async () => { state.disposes++; live.running = false; };
  live.running = false; f.chats.onDriverEvent!(f.chat.id, worker.key, { type: "turn_end", ok: false, error: "usage_limit_reached" });
  await pending; // the master's wait is released with the failure report
  const consult = () => f.store.listConsults(f.chat.id)[0];
  assert.equal(consult().status, "running");
  return { worker, live, state, consult };
}
const settleConsult = async (consult: () => any) => { for (let i = 0; i < 100 && consult().status === "running"; i++) await new Promise(r => setTimeout(r, 10)); };

test("[review2 1] the automatic sweep uses the same confirmed close: a failing close keeps handle, scope and account", async () => {
  const f = fixture();
  try {
    const { worker, live, state, consult } = await heldSwitch(f);
    const before = state.calls;
    for (let i = 1; i <= 2; i++) {
      await f.engine.sweepWorkerRecovery(Date.now() + i * 61_000);
      await flush();
      assert.equal(state.calls, before + i, "the sweep retried the confirmed close");
      assert.equal(state.disposes, 0, "never the unchecked dispose");
      assert.equal(f.chats.liveDriver(f.chat.id, worker.key), live, "handle kept");
      assert.ok(f.engine.scopeLocks.get(f.chat.id)?.length, "scope kept");
      assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"], "no run on gpt-2");
      assert.equal(consult().status, "running");
    }
    // Once the exit is confirmed, the sweep's cleanup continues the work on gpt-2.
    state.fail = false;
    await f.engine.sweepWorkerRecovery(Date.now() + 5 * 61_000);
    await settleConsult(consult);
    assert.equal(consult().status, "done");
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.match(consult().responseSummary!, /우선 할당: gpt-1 실패\(한도 소진\) → gpt-2로 전환/);
  } finally { await f.close(); }
});

test("[review2 1] a failing manual recover keeps the handle and never starts the next account", async () => {
  const f = fixture();
  try {
    const { worker, live, state, consult } = await heldSwitch(f);
    const recovered = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(recovered.isError, true);
    assert.match(body(recovered), /기존 실행 정리 실패: .*이전 실행 종료를 확인하지 못했습니다: taskkill failed/);
    assert.equal(state.disposes, 0);
    assert.equal(f.chats.liveDriver(f.chat.id, worker.key), live);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"]);
    assert.equal(consult().status, "running");
    assert.ok(f.engine.scopeLocks.get(f.chat.id)?.length);
  } finally { await f.close(); }
});

test("[review2 2] fixed/auto recovery keeps its ordinary recover/dispose steps and never uses the strict close", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { gpt: { mode: "auto" } } } });
    const worker = f.store.createAgent(f.chat.id, "gpt", "auto");
    f.plan.set("gpt-1", "hold");
    const pending = f.ask(worker.nickname);
    await flush();
    const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
    const used: string[] = [];
    live.closeStrict = async () => { used.push("closeStrict"); };
    live.dispose = async () => { used.push("dispose"); live.running = false; };
    const recovered = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(recovered.isError, false, body(recovered));
    assert.match(body(recovered), /supersedes로 이어 맡기세요/);
    assert.equal(used.includes("closeStrict"), false, "the strict close is priority-only");
    assert.equal(used[0], "dispose", "recover → dispose as before");
    assert.equal((await pending).isError, true);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"]);
  } finally { await f.close(); }
});

test("[review2 3] an empty usage response never clears a failure through cached values", async () => {
  const f = fixture();
  try {
    f.add("gpt");
    // Cached: plenty left. Then the account fails.
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 20 } } }, "gpt-2", undefined, Date.now() - 1000);
    const at = Date.now();
    f.chats.markPriorityFailure("gpt-2", "quota", at);
    f.chats.mergeUsage({ codex: {} }, "gpt-2", undefined, at + 1);
    assert.equal(f.chats.priorityFailureOf("gpt-2")?.reason, "quota", "nothing read, nothing proven");
    f.chats.mergeUsage({ codex: { updatedAt: at } }, "gpt-2", undefined, at + 2);
    assert.equal(f.chats.priorityFailureOf("gpt-2")?.reason, "quota");
    // A window that is read counts, but a cached exhausted window still vetoes it.
    f.chats.cliAccounts().setUsage("gpt-2", { weekly: { usedPercent: 100 } }, true);
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 10 } } }, "gpt-2", undefined, at + 3);
    assert.equal(f.chats.priorityFailureOf("gpt-2")?.reason, "quota", "weekly still exhausted");
    f.chats.mergeUsage({ codex: { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: 50 } } }, "gpt-2", undefined, at + 4);
    assert.equal(f.chats.priorityFailureOf("gpt-2"), undefined);
  } finally { await f.close(); }
});

test("[review2 4] sign-in detection needs the CLI's own wording; line numbers and the user's servers are not account failures", async () => {
  const provider = [
    "Invalid API key · Please run /login", "Not logged in · Please run /login",
    "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired.\"}}",
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses",
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    "refresh_token_reused", "Grok 로그인이 필요합니다. 터미널에서 grok login을 완료한 뒤 다시 실행하세요.",
    "CLI 계정 gpt-2에 로그인되어 있지 않습니다. 사용자에게 알리세요.", "CLI 계정 gpt-2은(는) 배정에서 제외되어 있어 실행하지 않았습니다.",
    "CLI 계정 gpt-2은(는) 배정에서 제외되어 있습니다.",
  ];
  const ordinary = [
    "src/app.ts:401: Type 'string' is not assignable", "error at line 401", "401", "401 Unauthorized",
    "GET http://localhost:3000/api/users 401 (Unauthorized)", "Request failed with status code 401",
    "AxiosError: Request failed with status code 401 at https://api.example.com/login", "Unauthorized",
    "password authentication failed for user \"postgres\"", "Authentication failed for 'https://github.com/org/repo.git/'",
    "인증 실패: 테스트 서버가 거부했습니다", "JWT token expired in test fixture", "compile failed",
  ];
  for (const e of provider) assert.equal(isAuthError(e), true, e);
  for (const e of ordinary) assert.equal(isAuthError(e), false, e);
  // An ordinary 401 from the user's project fails the consult without switching accounts.
  const f = fixture();
  try {
    f.add("gpt"); f.priority(["gpt-1", "gpt-2"]);
    f.plan.set("gpt-1", "src/app.ts:401: Unauthorized handler test failed");
    const worker = f.store.createAgent(f.chat.id, "gpt", "user 401");
    const reply = await f.ask(worker.nickname);
    assert.equal(reply.isError, true); assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"]);
    assert.doesNotMatch(body(reply), /우선 할당:/);
  } finally { await f.close(); }
});

/** Starts a held priority opinion on gpt-1 and fails it with a limit; returns the live fake driver. */
async function failingPriorityRun(f: ReturnType<typeof fixture>, prepare: (live: any) => void) {
  f.add("gpt");
  f.priority(["gpt-1", "gpt-2"]);
  const worker = f.store.createAgent(f.chat.id, "gpt", "archive");
  f.plan.set("gpt-1", "hold");
  const pending = f.ask(worker.nickname);
  await flush();
  const live = f.chats.liveDriver(f.chat.id, worker.key) as any;
  prepare(live);
  live.running = false; f.chats.onDriverEvent!(f.chat.id, worker.key, { type: "turn_end", ok: false, error: "usage_limit_reached" });
  return { worker, live, pending, consult: () => f.store.listConsults(f.chat.id)[0] };
}

test("[review3 2] a silent archive after a confirmed close only warns: the switch continues and switching is cleared", async () => {
  const f = fixture();
  try {
    f.engine.switchCleanupMs = 40;
    const { pending, consult } = await failingPriorityRun(f, live => { live.archive = () => new Promise(() => {}); });
    const reply = await pending;
    assert.equal(reply.isError, false, body(reply));
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
    assert.equal(consult().status, "done");
    const warning = f.store.events(f.chat.id).find(e => e.event.type === "notice" && e.event.text.includes("세션 보관을 완료하지 못했습니다"));
    assert.ok(warning, "a warning is left");
    assert.match((warning!.event as any).text, /시간 초과.*계정 전환은 계속합니다/);
  } finally { await f.close(); }
});

test("[review3 2] a close that never answers or throws is held with switching cleared, so recover is never refused for good", async () => {
  const f = fixture();
  try {
    f.engine.switchCloseMs = 40;
    const { worker, live, consult } = await failingPriorityRun(f, live => { live.closeStrict = () => new Promise(() => {}); });
    for (let i = 0; i < 50 && !f.engine.running.get(f.chat.id)?.get(worker.key)?.failover?.includes("보류"); i++) await new Promise(r => setTimeout(r, 10));
    const running = f.engine.running.get(f.chat.id).get(worker.key);
    assert.equal(running.switching, false);
    assert.match(running.lastError, /전환 실패: .*시간 초과/);
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1"]);
    // Even an unexpected exception in the close path leaves switching cleared.
    const close = f.engine.closeForSwitch.bind(f.engine);
    f.engine.closeForSwitch = async () => { throw new Error("boom"); };
    const refused = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(refused.isError, true);
    assert.doesNotMatch(body(refused), /전환을 진행 중/, "not refused as an endless switch");
    assert.equal(running.switching, false);
    // A working close lets recover finish the switch.
    f.engine.closeForSwitch = close;
    live.closeStrict = async () => { live.running = false; };
    const recovered = await f.call("check_agent", { to: worker.nickname, recover: true });
    assert.equal(recovered.isError, false, body(recovered));
    for (let i = 0; i < 100 && consult().status === "running"; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(consult().status, "done");
    assert.deepEqual(f.sent.map(s => s.accountId), ["gpt-1", "gpt-2"]);
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mock, test } from "node:test";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS, type AgentEvent } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { CliAccounts, OWNER_MARKER, cliRemaining, resolveAccountPolicy, sanitizePolicies } from "./cli-accounts";
import { CODEX_DISPOSE_TIMEOUT_MS, CodexDriver, CodexServer } from "./drivers/codex";
import { readGrokAuth } from "./drivers/grok";

const OLD_SESSION = "11111111-1111-4111-8111-111111111111";
const NEW_SESSION = "22222222-2222-4222-8222-222222222222";

function settingsStub() {
  const values = new Map<string, string>();
  return { getSetting: (k: string) => values.get(k), setSetting: (k: string, v: string) => void values.set(k, v), values };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-backend-"));
  const store = new Store(join(root, "app.db"));
  const project = store.createProject("accounts", root, DEFAULT_SETTINGS);
  const claudeExe = join(root, "claude.exe"), codexExe = join(root, "codex.exe"), grokExe = join(root, "grok.exe");
  for (const exe of [claudeExe, codexExe, grokExe]) writeFileSync(exe, "fake");
  store.setSetting("claudePath", claudeExe); store.setSetting("codexPath", codexExe); store.setSetting("grokPath", grokExe);
  const events: { role: string | null; event: AgentEvent }[] = [];
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event: e => events.push({ role: e.role, event: e.event }) }, root, "unused");
  const close = async () => { await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, store, project, chats, events, claudeExe, close };
}

/** Fake `claude -p` stream-json: answers each user message with init(session) + result. */
function fakeClaude(sessionFor: () => string) {
  const calls: { exe: string; args: string[]; env: Record<string, string | undefined>; inputs: string[] }[] = [];
  const patched = mock.method(childProcess, "spawn", (exe: string, args: string[], options: any) => {
    const call = { exe, args, env: options?.env ?? {}, inputs: [] as string[] };
    calls.push(call);
    const child: any = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 60_000 + calls.length });
    child.stdin.on("finish", () => { if (child.exitCode !== null) return; child.exitCode = 0; child.stdout.end(); child.emit("exit", 0); });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.type !== "user") continue;
        call.inputs.push(msg.message.content.map((c: any) => c.text ?? "").join(""));
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionFor(), claude_code_version: "2.1.310" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\n");
        });
      }
    });
    return child;
  });
  return { calls, restore: () => patched.mock.restore() };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("policy priority: explicit > project > global > default fixed *-1", () => {
  const project = { claude: { mode: "fixed" as const, accountId: "claude-3" as const } };
  const global = { claude: { mode: "auto" as const, accountId: "claude-2" as const }, grok: { mode: "auto" as const } };
  assert.deepEqual(resolveAccountPolicy("claude", project, global, "claude-4"), { kind: "claude", mode: "fixed", accountId: "claude-4", source: "explicit" });
  assert.deepEqual(resolveAccountPolicy("claude", project, global), { kind: "claude", mode: "fixed", accountId: "claude-3", source: "project" });
  assert.deepEqual(resolveAccountPolicy("claude", undefined, global), { kind: "claude", mode: "auto", accountId: "claude-2", source: "global" });
  assert.deepEqual(resolveAccountPolicy("grok", project, global), { kind: "grok", mode: "auto", accountId: "grok-1", source: "global" });
  assert.deepEqual(resolveAccountPolicy("gpt", undefined, undefined), { kind: "gpt", mode: "fixed", accountId: "gpt-1", source: "default" });
  assert.throws(() => resolveAccountPolicy("gpt", undefined, undefined, "claude-2"), /계열/);
  // A malformed or foreign-family entry is ignored, never applied.
  assert.deepEqual(resolveAccountPolicy("gpt", { gpt: { mode: "fixed", accountId: "claude-2" } as any }, undefined).source, "default");
  assert.deepEqual(sanitizePolicies({ claude: { mode: "auto" }, gpt: { mode: "weird" }, other: { mode: "fixed" } }), { claude: { mode: "auto" } });
});

test("remaining uses the lowest window and treats stale, failed or unread usage as unknown", () => {
  const now = 1_800_000_000_000;
  assert.equal(cliRemaining({ fiveHour: { usedPercent: 30 }, weekly: { usedPercent: 80 }, checkedAt: now }, now), 20);
  assert.equal(cliRemaining({ usage: { fiveHour: { usedPercent: 5 }, checkedAt: now } }, now), 95);
  assert.equal(cliRemaining({ weekly: { usedPercent: 10 }, checkedAt: now - 600_001 }, now), undefined);
  assert.equal(cliRemaining({ error: "x", checkedAt: now }, now), undefined);
  assert.equal(cliRemaining(undefined, now), undefined);
});

test("account store: defaults keep the CLI directory, added accounts get a fresh empty directory, removal is scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-store-"));
  try {
    const settings = settingsStub();
    const accounts = new CliAccounts(join(root, "cli-accounts"), settings);
    assert.deepEqual(accounts.list().map(a => [a.accountId, a.configDir]), [["claude-1", null], ["gpt-1", null], ["grok-1", null]]);
    assert.deepEqual(accounts.env("claude-1"), {});
    // An unverified leftover is neither adopted nor deleted: its number is skipped.
    mkdirSync(join(root, "cli-accounts", "gpt-2"), { recursive: true });
    writeFileSync(join(root, "cli-accounts", "gpt-2", "auth.json"), "{}");
    const skipped = accounts.create("gpt", "업무");
    assert.equal(skipped.accountId, "gpt-3");
    assert.equal(existsSync(join(root, "cli-accounts", "gpt-2", "auth.json")), true);
    assert.deepEqual(readdirSync(skipped.configDir!), [OWNER_MARKER]);
    accounts.remove("gpt-3");
    rmSync(join(root, "cli-accounts", "gpt-2"), { recursive: true, force: true });
    const created = accounts.create("gpt", "업무");
    assert.equal(created.accountId, "gpt-2");
    assert.equal(created.configDir, join(root, "cli-accounts", "gpt-2"));
    assert.deepEqual(readdirSync(created.configDir!), [OWNER_MARKER]);
    assert.deepEqual(accounts.env("gpt-2"), { CODEX_HOME: created.configDir });
    assert.deepEqual(accounts.env(accounts.create("claude").accountId), { CLAUDE_CONFIG_DIR: join(root, "cli-accounts", "claude-2") });
    assert.deepEqual(accounts.env(accounts.create("grok").accountId), { GROK_HOME: join(root, "cli-accounts", "grok-2") });
    assert.throws(() => accounts.remove("gpt-1"), /기본 계정/);
    // Reload keeps the list; a tampered configDir is ignored in favor of our own path.
    const saved = JSON.parse(settings.values.get("cliAccounts")!);
    saved.find((a: any) => a.accountId === "gpt-2").configDir = "C:\\Users\\someone\\.codex";
    settings.setSetting("cliAccounts", JSON.stringify(saved));
    const reloaded = new CliAccounts(join(root, "cli-accounts"), settings);
    assert.equal(reloaded.get("gpt-2")?.configDir, join(root, "cli-accounts", "gpt-2"));
    reloaded.remove("gpt-2");
    assert.equal(existsSync(join(root, "cli-accounts", "gpt-2")), false);
    assert.equal(existsSync(join(root, "cli-accounts", "claude-2")), true);
    for (let i = 3; i <= 10; i++) reloaded.create("claude");
    assert.throws(() => reloaded.create("claude"), /최대 10개/);
    assert.throws(() => reloaded.setPolicies({ grok: { mode: "fixed", accountId: "grok-9" } }), /등록되지 않은/);
    assert.throws(() => reloaded.setPolicies({ claude: { mode: "sometimes" } }), /정책/);
    assert.deepEqual(reloaded.setPolicies({ claude: { mode: "auto" } }), { claude: { mode: "auto" } });
    assert.deepEqual(reloaded.policies(), { claude: { mode: "auto" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("env injection: Codex app-server per account and Grok connections get their home directory", async () => {
  const seen: { exe: string; env: Record<string, string | undefined> }[] = [];
  const patched = mock.method(childProcess, "spawn", (exe: string, _args: string[], options: any) => {
    seen.push({ exe, env: options?.env ?? {} });
    const child: any = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 70_000 + seen.length });
    child.stdin.on("finish", () => { if (child.exitCode !== null) return; child.exitCode = 0; child.stdout.end(); child.emit("exit", 0); });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const r = JSON.parse(line);
        if (r.id === undefined) continue;
        const result = r.method === "initialize" ? { _meta: { defaultAuthMethodId: "cached_token" } } : {};
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n"));
      }
    });
    return child;
  });
  try {
    const server = new CodexServer("C:\\fake\\codex.exe", { CODEX_HOME: "C:\\data\\cli-accounts\\gpt-2" });
    await server.ensure();
    assert.equal(seen[0].env.CODEX_HOME, "C:\\data\\cli-accounts\\gpt-2");
    await server.dispose();
    assert.equal(await readGrokAuth("C:\\fake\\grok.exe", tmpdir(), { GROK_HOME: "C:\\data\\cli-accounts\\grok-3" }), "authenticated");
    assert.equal(seen[1].env.GROK_HOME, "C:\\data\\cli-accounts\\grok-3");
    // The default account adds nothing: the inherited environment is unchanged.
    const plain = new CodexServer("C:\\fake\\codex.exe");
    await plain.ensure();
    assert.equal(seen[2].env.CODEX_HOME, process.env.CODEX_HOME);
    await plain.dispose();
  } finally { patched.mock.restore(); }
});

test("usage merge: added accounts stay separate, the family keys keep the default account, partial windows merge", async () => {
  const f = fixture();
  try {
    f.chats.createCliAccount("claude");
    f.chats.mergeUsage({ claude: { fiveHour: { usedPercent: 30, resetsAt: 1 } } }, "claude-2");
    assert.equal(f.chats.usage().claude, undefined);
    f.chats.mergeUsage({ claude: { weekly: { usedPercent: 60, resetsAt: 2 } } }, "claude-2");
    assert.deepEqual(f.chats.usage().accounts?.["claude-2"], { fiveHour: { usedPercent: 30, resetsAt: 1 }, weekly: { usedPercent: 60, resetsAt: 2 } });
    const status = f.chats.getCliAccount("claude-2")!;
    assert.equal(typeof status.usage?.checkedAt, "number");
    assert.equal(status.remainingPercent, 40);
    // Legacy callers (no account) still update the family key and mirror into claude-1.
    f.chats.mergeUsage({ claude: { weekly: { usedPercent: 10 } } });
    assert.deepEqual(f.chats.usage().claude, { fiveHour: undefined, weekly: { usedPercent: 10 } });
    assert.deepEqual(f.chats.usage().accounts?.["claude-1"]?.weekly, { usedPercent: 10 });
    // A Codex server reports for its own account.
    f.chats.createCliAccount("gpt");
    f.chats.codex("gpt-2").onUsage!({ codex: { weekly: { usedPercent: 25 } } });
    assert.equal(f.chats.usage().codex, undefined);
    assert.equal(f.chats.usage().accounts?.["gpt-2"]?.weekly?.usedPercent, 25);
    assert.notEqual(f.chats.codex("gpt-2"), f.chats.codex());
    // Grok is a complete snapshot: an error replaces the reading.
    f.chats.createCliAccount("grok");
    f.chats.mergeUsage({ grok: { weekly: { usedPercent: 5 } } }, "grok-2");
    f.chats.mergeUsage({ grok: { error: "실패" } }, "grok-2");
    assert.deepEqual(f.chats.usage().accounts?.["grok-2"], { error: "실패" });
    assert.equal(f.chats.getCliAccount("grok-2")!.remainingPercent, undefined);
  } finally { await f.close(); }
});

test("migration adds CLI account columns to an existing agents table and keeps sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-migrate-"));
  try {
    const file = join(root, "app.db");
    let store = new Store(file);
    const project = store.createProject("p", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "c");
    const agent = store.createAgent(chat.id, "gpt", "job");
    store.updateAgent(agent.id, { sessionId: "thread-1" });
    store.close();
    const raw = new DatabaseSync(file);
    raw.exec("ALTER TABLE agents DROP COLUMN cli_account_id; ALTER TABLE agents DROP COLUMN session_account_id;");
    raw.close();
    store = new Store(file);
    const loaded = store.agent(agent.id)!;
    assert.equal(loaded.sessionId, "thread-1");
    assert.equal(loaded.cliAccountId, undefined);
    assert.equal(loaded.sessionAccountId, undefined);
    store.updateAgent(agent.id, { cliAccountId: "gpt-2", sessionAccountId: "gpt-2" });
    store.updateAgent(agent.id, { job: "next" });
    assert.equal(store.agent(agent.id)!.cliAccountId, "gpt-2");
    assert.equal(store.agent(agent.id)!.sessionAccountId, "gpt-2");
    store.updateAgent(agent.id, { cliAccountId: null });
    assert.equal(store.agent(agent.id)!.cliAccountId, undefined);
    store.updateAgent(agent.id, { cliAccountId: "gpt-3" });
    store.clearCliAccount("gpt-3");
    assert.equal(store.agent(agent.id)!.cliAccountId, undefined);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an account switch never resumes: new session with handoff, then the new session resumes on its own account", async () => {
  const f = fixture();
  let session = OLD_SESSION;
  const claude = fakeClaude(() => session);
  try {
    const chat = f.store.createChat(f.project.id, "c");
    const agent = f.store.createAgent(chat.id, "claude", "job");
    f.store.updateAgent(agent.id, { sessionId: OLD_SESSION });
    const consult = f.store.createConsult(chat.id, "orch", agent.key, "implement", "이전 요청: 로그인 화면 수정");
    f.store.finishConsult(consult.id, "done", "이전 응답: 버튼 색 변경 완료", []);
    f.chats.createCliAccount("claude");

    // Default account: legacy session resumes, no account env, no notice — unchanged behavior.
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "hi", attachments: [] });
    await settle();
    assert.ok(claude.calls[0].args.includes("--resume") && claude.calls[0].args.includes(OLD_SESSION));
    assert.equal(claude.calls[0].env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
    assert.deepEqual(claude.calls[0].inputs, ["hi"]);
    // A resumed legacy session keeps no account tag; it counts as the default account.
    assert.equal(f.store.agent(agent.id)!.sessionAccountId, undefined);
    assert.equal(f.events.some(e => e.event.type === "notice" && e.event.cliAccountId), false);
    assert.equal(f.chats.runningAccount(chat.id, agent.key), "claude-1");

    // Master assigns claude-2: a new process on the new directory, no --resume, handoff first.
    assert.throws(() => f.chats.assertCliAccount("claude-9", "claude"), /등록되지 않은/);
    assert.throws(() => f.chats.assertCliAccount("gpt-1", "claude"), /계열/);
    f.chats.assertCliAccount("claude-2", "claude");
    f.chats.setWorkerAccount(chat.id, agent.key, "claude-2");
    assert.deepEqual(f.chats.roleAccount(chat.id, agent.key), { kind: "claude", mode: "fixed", accountId: "claude-2", source: "explicit" });
    session = NEW_SESSION;
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "계속", attachments: [] });
    await settle();
    const second = claude.calls[1];
    assert.equal(second.args.includes("--resume"), false);
    assert.equal(second.env.CLAUDE_CONFIG_DIR, join(f.root, "cli-accounts", "claude-2"));
    assert.match(second.inputs[0], /^\[AI_ChatterBox 계정 전환 인계 — CLI 계정 claude-1 → claude-2\]/);
    assert.match(second.inputs[0], /이전 요청: 로그인 화면 수정[\s\S]*이전 응답: 버튼 색 변경 완료[\s\S]*계속$/);
    assert.equal(f.store.agent(agent.id)!.sessionId, NEW_SESSION);
    assert.equal(f.store.agent(agent.id)!.sessionAccountId, "claude-2");
    assert.ok(f.events.some(e => e.event.type === "notice" && e.event.cliAccountId === "claude-2"));
    assert.equal(f.chats.runningAccount(chat.id, agent.key), "claude-2");

    // Same driver: the handoff is sent only once.
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "다음", attachments: [] });
    await settle();
    assert.equal(claude.calls.length, 2);
    assert.equal(second.inputs[1], "다음");

    // A fresh process on the same account resumes its own session without a handoff.
    await f.chats.disposeRole(chat.id, agent.key);
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "재개", attachments: [] });
    await settle();
    assert.ok(claude.calls[2].args.includes("--resume") && claude.calls[2].args.includes(NEW_SESSION));
    assert.deepEqual(claude.calls[2].inputs, ["재개"]);

    // Project policy applies when the master gives no explicit account.
    f.chats.setWorkerAccount(chat.id, agent.key, null);
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { claude: { mode: "auto", accountId: "claude-2" } } } });
    assert.deepEqual(f.chats.roleAccount(chat.id, agent.key), { kind: "claude", mode: "auto", accountId: "claude-2", source: "project" });
  } finally { claude.restore(); await f.close(); }
});

test("login opens a console with the account env; removal clears assignments and policies", async () => {
  const f = fixture();
  try {
    const launched: { exe: string; args: string[]; env: Record<string, string> }[] = [];
    f.chats.consoleLauncher = (exe, args, env) => void launched.push({ exe, args, env });
    f.chats.createCliAccount("claude", "보조");
    f.chats.createCliAccount("gpt");
    f.chats.loginCliAccount("claude-2");
    f.chats.loginCliAccount("gpt-2");
    f.chats.loginCliAccount("claude-1");
    assert.deepEqual(launched[0], { exe: f.claudeExe, args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: join(f.root, "cli-accounts", "claude-2") } });
    assert.deepEqual(launched[1].args, ["login"]);
    assert.deepEqual(launched[1].env, { CODEX_HOME: join(f.root, "cli-accounts", "gpt-2") });
    assert.deepEqual(launched[2].env, {});

    const chat = f.store.createChat(f.project.id, "c");
    const agent = f.store.createAgent(chat.id, "claude", "job");
    f.chats.setWorkerAccount(chat.id, agent.key, "claude-2");
    f.chats.setCliAccountPolicy({ claude: { mode: "fixed", accountId: "claude-2" }, gpt: { mode: "auto" } });
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { claude: { mode: "fixed", accountId: "claude-2" } } } });
    await assert.rejects(f.chats.removeCliAccount("claude-1"), /기본 계정/);
    const list = await f.chats.removeCliAccount("claude-2");
    assert.equal(list.some(a => a.accountId === "claude-2"), false);
    assert.equal(existsSync(join(f.root, "cli-accounts", "claude-2")), false);
    assert.equal(f.store.agent(agent.id)!.cliAccountId, undefined);
    assert.deepEqual(f.chats.getCliAccountPolicy(), { gpt: { mode: "auto" } });
    assert.deepEqual(f.store.project(f.project.id)!.settings.accountPolicy, {});
    const status = f.chats.listCliAccounts("claude");
    assert.deepEqual(status.map(a => [a.accountId, a.isDefault, a.authStatus, a.runningWorkers]), [["claude-1", true, "unknown", 0]]);
  } finally { await f.close(); }
});

test("[P1] junctions are never followed: a linked account folder or root is skipped/refused and its target survives", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-accounts-junction-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "important");
    writeFileSync(join(outside, OWNER_MARKER), JSON.stringify({ accountId: "gpt-2", createdAt: 1 }));
    const accounts = new CliAccounts(join(root, "cli-accounts"), settingsStub());
    mkdirSync(join(root, "cli-accounts"));
    symlinkSync(outside, join(root, "cli-accounts", "gpt-2"), "junction");
    // Even with a forged marker, a junction is not ours: skip the number, keep the target.
    assert.equal(accounts.create("gpt").accountId, "gpt-3");
    assert.equal(existsSync(join(outside, "keep.txt")), true);

    // A junction root: nothing is created or deleted through it.
    const linkedRoot = join(root, "linked-root");
    symlinkSync(outside, linkedRoot, "junction");
    const linked = new CliAccounts(linkedRoot, settingsStub());
    assert.throws(() => linked.create("claude"), /링크\(junction\)/);
    assert.equal(existsSync(join(outside, "claude-2")), false);

    // An account whose folder was swapped for a junction after creation is not deleted.
    const swap = new CliAccounts(join(root, "swap"), settingsStub());
    const made = swap.create("grok");
    rmSync(made.configDir!, { recursive: true, force: true });
    writeFileSync(join(outside, OWNER_MARKER), JSON.stringify({ accountId: made.accountId, createdAt: made.createdAt }));
    symlinkSync(outside, made.configDir!, "junction");
    assert.throws(() => swap.remove(made.accountId), /확인되지 않은 폴더/);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    // A folder without our marker is not deleted either.
    rmSync(made.configDir!, { force: true });
    mkdirSync(made.configDir!);
    writeFileSync(join(made.configDir!, "user.txt"), "x");
    assert.throws(() => swap.remove(made.accountId), /확인되지 않은 폴더/);
    assert.equal(existsSync(join(made.configDir!, "user.txt")), true);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[P2] a removed and re-created account ID never resumes the old sessions (worker and master) and hands off", async () => {
  const f = fixture();
  const claude = fakeClaude(() => NEW_SESSION);
  try {
    const chat = f.store.createChat(f.project.id, "c");
    const agent = f.store.createAgent(chat.id, "claude", "job");
    const consult = f.store.createConsult(chat.id, "orch", agent.key, "implement", "옛 요청");
    f.store.finishConsult(consult.id, "done", "옛 응답", []);
    f.chats.createCliAccount("claude");
    const first = f.chats.getCliAccount("claude-2")!;
    f.store.updateAgent(agent.id, { sessionId: OLD_SESSION, sessionAccountId: "claude-2", sessionAccountGeneration: first.createdAt });
    f.store.setSetting(`orchSessionAccount:${chat.id}:claude`, `claude-2@${first.createdAt}`);
    await f.chats.removeCliAccount("claude-2");
    assert.equal(f.store.agent(agent.id)!.sessionAccountGeneration, -1);
    assert.equal(f.store.getSetting(`orchSessionAccount:${chat.id}:claude`), "claude-2@-1");
    f.chats.createCliAccount("claude");
    const second = f.chats.getCliAccount("claude-2")!;
    assert.ok(second.createdAt > first.createdAt);
    f.chats.setWorkerAccount(chat.id, agent.key, "claude-2");
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "이어서", attachments: [] });
    await settle();
    assert.equal(claude.calls[0].args.includes("--resume"), false);
    assert.match(claude.calls[0].inputs[0], /claude-2\(삭제된 이전 계정\) → claude-2[\s\S]*옛 요청[\s\S]*옛 응답[\s\S]*이어서$/);
    assert.equal(f.store.agent(agent.id)!.sessionAccountGeneration, second.createdAt);
    // The new incarnation's own session resumes afterwards.
    await f.chats.disposeRole(chat.id, agent.key);
    await (await f.chats.driver(chat.id, agent.key, "")).send({ text: "재개", attachments: [] });
    await settle();
    assert.ok(claude.calls[1].args.includes(NEW_SESSION));
    assert.deepEqual(claude.calls[1].inputs, ["재개"]);
  } finally { claude.restore(); await f.close(); }
});

test("[P2] late auth and usage results for a removed/re-created or logged-out account are discarded", async () => {
  const f = fixture();
  let release: () => void = () => {};
  const patched = mock.method(childProcess, "execFile", ((_exe: string, args: string[], _o: any, cb: Function) => {
    if (args[0] === "auth" && args[1] === "status") release = () => cb(null, JSON.stringify({ loggedIn: true, email: "old@example.com" }), "");
    else queueMicrotask(() => cb(null, "", ""));
    return { stdin: { end() {} } };
  }) as any);
  try {
    f.chats.createCliAccount("claude");
    const pending = f.chats.refreshCliAccount("claude-2");
    await settle();
    await f.chats.removeCliAccount("claude-2");
    f.chats.createCliAccount("claude");
    release();
    await pending.catch(() => undefined);
    assert.equal(f.chats.getCliAccount("claude-2")!.auth, undefined);
    assert.equal(f.chats.getCliAccount("claude-2")!.authStatus, "unknown");
    // A usage reading captured before the re-creation is dropped; a fresh one lands.
    const stale = `${f.chats.getCliAccount("claude-2")!.createdAt - 1}:0`;
    f.chats.mergeUsage({ claude: { weekly: { usedPercent: 99 } } }, "claude-2", stale);
    assert.equal(f.chats.usage().accounts?.["claude-2"], undefined);
    f.chats.mergeUsage({ claude: { weekly: { usedPercent: 10 } } }, "claude-2");
    assert.equal(f.chats.usage().accounts?.["claude-2"]?.weekly?.usedPercent, 10);
    // Logout invalidates a refresh that was in flight.
    const again = f.chats.refreshCliAccount("claude-2");
    await settle();
    await f.chats.logoutCliAccount("claude-2");
    release();
    await again;
    assert.equal(f.chats.getCliAccount("claude-2")!.authStatus, "required");
  } finally { patched.mock.restore(); await f.close(); }
});

test("[P2] model lists and effort checks use the executing account with per-account caches", async () => {
  const f = fixture();
  try {
    const asked: (string | undefined)[] = [];
    (f.chats as any).codex = (id?: string) => ({ models: async () => { asked.push(id); return [{ id: `model-${id}`, label: "m", isDefault: true, reasoningEfforts: ["high"] }]; } });
    f.chats.createCliAccount("gpt");
    assert.equal((await f.chats.models("codex"))[0].id, "model-gpt-1");
    assert.equal((await f.chats.models("codex", "gpt-2"))[0].id, "model-gpt-2");
    await f.chats.models("codex", "gpt-2");
    assert.deepEqual(asked, ["gpt-1", "gpt-2"]);
    await assert.rejects(f.chats.models("codex", "claude-2" as any), /계정이 아닙니다/);
    const chat = f.store.createChat(f.project.id, "c");
    const agent = f.store.createAgent(chat.id, "gpt", "job");
    f.chats.setWorkerAccount(chat.id, agent.key, "gpt-2");
    const seen: (string | undefined)[] = [];
    f.chats.models = async (_agent, accountId) => { seen.push(accountId); return [{ id: DEFAULT_SETTINGS.codexModel, label: "x", isDefault: true, reasoningEfforts: ["high"] }]; };
    await f.chats.assignmentEffort(chat.id, agent.key, "high");
    assert.deepEqual(seen, ["gpt-2"]);
  } finally { await f.close(); }
});

test("[P2/결정] disabled accounts never run, *-1 cannot be excluded, fixed policy beats stored assignments, release clears them", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.chats.updateCliAccount("claude-1", { enabled: false }), /기본 계정/);
    f.chats.createCliAccount("claude");
    f.chats.updateCliAccount("claude-2", { enabled: false });
    const chat = f.store.createChat(f.project.id, "c");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: { claude: { mode: "fixed", accountId: "claude-2" } } } });
    await assert.rejects(f.chats.driver(chat.id, "orch", ""), /배정에서 제외되어 있어 실행하지 않았습니다/);
    f.chats.updateCliAccount("claude-2", { enabled: true });
    f.chats.createCliAccount("claude");

    const agent = f.store.createAgent(chat.id, "claude", "job");
    f.chats.setWorkerAccount(chat.id, agent.key, "claude-3");
    // Project fixed claude-2 wins over the stored claude-3.
    assert.deepEqual(f.chats.roleAccount(chat.id, agent.key), { kind: "claude", mode: "fixed", accountId: "claude-2", source: "project" });
    // Global fixed also wins when the project has no entry.
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, accountPolicy: {} } });
    f.chats.setCliAccountPolicy({ claude: { mode: "fixed", accountId: "claude-2" } });
    assert.equal(f.chats.roleAccount(chat.id, agent.key)!.source, "global");
    // Under auto (or the default policy) the stored assignment applies.
    f.chats.setCliAccountPolicy({ claude: { mode: "auto" } });
    assert.deepEqual(f.chats.roleAccount(chat.id, agent.key), { kind: "claude", mode: "auto", accountId: "claude-3", source: "explicit" });
    f.chats.setCliAccountPolicy({});
    assert.equal(f.chats.roleAccount(chat.id, agent.key)!.source, "explicit");
    f.store.updateAgent(agent.id, { status: "released" });
    assert.equal(f.store.agent(agent.id)!.cliAccountId, undefined);
    assert.deepEqual(f.chats.roleAccount(chat.id, agent.key), { kind: "claude", mode: "fixed", accountId: "claude-1", source: "default" });

    // Project policies keep only registered accounts (the projects:update path).
    assert.deepEqual(f.chats.sanitizeAccountPolicy({ claude: { mode: "fixed", accountId: "claude-9" }, gpt: { mode: "auto" }, grok: { mode: "bad" } }), { gpt: { mode: "auto" } });
  } finally { await f.close(); }
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("[P2] removal blocks replacement servers and refreshes until disposal ends, then leaves no server", async () => {
  const f = fixture(), entered = deferred(), gate = deferred();
  let removal: Promise<unknown> | undefined;
  let restore = () => {};
  try {
    f.chats.createCliAccount("gpt");
    const server = f.chats.codex("gpt-2");
    const dispose = mock.method(server, "dispose", async () => { entered.resolve(); await gate.promise; });
    restore = () => dispose.mock.restore();
    removal = f.chats.removeCliAccount("gpt-2");
    await entered.promise;
    assert.throws(() => f.chats.codex("gpt-2"), /변경 중/);
    await assert.rejects(f.chats.models("codex", "gpt-2"), /변경 중/);
    await assert.rejects(f.chats.logoutCliAccount("gpt-2"), /변경 중/);
    let queries = 0;
    const auth = mock.method(f.chats as any, "refreshAccountAuth", async () => { queries++; return null; });
    try { await f.chats.refreshCliAccount("gpt-2"); assert.equal(queries, 0); } finally { auth.mock.restore(); }
    server.onUsage!({ codex: { weekly: { usedPercent: 99 } } });
    assert.equal(f.chats.usage().accounts?.["gpt-2"], undefined);
    assert.doesNotThrow(() => f.chats.codex("gpt-1"), "another account is not locked");
    gate.resolve(); await removal;
    assert.equal((f.chats as any).codexServers.has("gpt-2"), false);
    assert.throws(() => f.chats.codex("gpt-2"), /등록되지 않은/);
    f.chats.createCliAccount("gpt");
    const next = f.chats.codex("gpt-2");
    assert.notEqual(next, server);
    next.onUsage!({ codex: { weekly: { usedPercent: 20 } } });
    server.onUsage!({ codex: { weekly: { usedPercent: 99 } } });
    assert.equal(f.chats.getCliAccount("gpt-2")!.remainingPercent, 80);
  } finally { gate.resolve(); await removal?.catch(() => undefined); restore(); await f.close(); }
});

test("[P2] logout locks server creation through both process disposal and the logout command", async () => {
  const f = fixture(), entered = deferred(), gate = deferred(), commandEntered = deferred();
  let finishCommand = () => {}, logout: Promise<unknown> | undefined, restore = () => {};
  const exec = mock.method(childProcess, "execFile", ((_exe: string, args: string[], _opts: any, cb: Function) => {
    assert.deepEqual(args, ["logout"]);
    finishCommand = () => cb(null, "", ""); commandEntered.resolve();
    return { stdin: { end() {} } };
  }) as any);
  try {
    f.chats.createCliAccount("gpt");
    const server = f.chats.codex("gpt-2");
    const dispose = mock.method(server, "dispose", async () => { entered.resolve(); await gate.promise; });
    restore = () => dispose.mock.restore();
    logout = f.chats.logoutCliAccount("gpt-2"); await entered.promise;
    assert.throws(() => f.chats.codex("gpt-2"), /변경 중/);
    gate.resolve(); await commandEntered.promise;
    assert.throws(() => f.chats.codex("gpt-2"), /변경 중/);
    assert.throws(() => f.chats.loginCliAccount("gpt-2"), /변경 중/);
    await assert.rejects(f.chats.removeCliAccount("gpt-2"), /변경 중/);
    assert.equal((f.chats as any).codexServers.has("gpt-2"), false);
    finishCommand(); await logout;
    assert.equal(f.chats.getCliAccount("gpt-2")!.authStatus, "required");
    assert.equal((f.chats as any).codexServers.has("gpt-2"), false);
    const next = f.chats.codex("gpt-2"); assert.notEqual(next, server);
    next.onUsage!({ codex: { weekly: { usedPercent: 15 } } });
    assert.equal(f.chats.getCliAccount("gpt-2")!.remainingPercent, 85);
  } finally { gate.resolve(); if (logout) { await commandEntered.promise; finishCommand(); await logout.catch(() => undefined); } restore(); exec.mock.restore(); await f.close(); }
});

test("[P2] cached Codex servers are replaced when account generation or login epoch changes", async () => {
  const f = fixture();
  try {
    f.chats.createCliAccount("gpt");
    const first = f.chats.codex("gpt-2");
    const dispose = mock.method(first, "dispose", async () => {});
    (f.chats as any).bumpAccount("gpt-2");
    assert.throws(() => f.chats.codex("gpt-2"), /이전 Codex 서버 종료 중/);
    assert.equal((f.chats as any).codexServers.get("gpt-2").server, first);
    await (f.chats as any).codexServers.get("gpt-2").closing;
    const second = f.chats.codex("gpt-2");
    assert.notEqual(second, first); assert.equal(dispose.mock.callCount(), 1); dispose.mock.restore();
    first.onUsage!({ codex: { weekly: { usedPercent: 99 } } });
    assert.equal(f.chats.getCliAccount("gpt-2")!.usage, undefined);
    const secondDispose = mock.method(second, "dispose", async () => {});
    f.chats.cliAccounts().remove("gpt-2"); f.chats.cliAccounts().create("gpt");
    assert.throws(() => f.chats.codex("gpt-2"), /이전 Codex 서버 종료 중/);
    await (f.chats as any).codexServers.get("gpt-2").closing;
    const third = f.chats.codex("gpt-2");
    assert.notEqual(third, second); assert.equal(secondDispose.mock.callCount(), 1); secondDispose.mock.restore();
    third.onUsage!({ codex: { weekly: { usedPercent: 25 } } });
    second.onUsage!({ codex: { weekly: { usedPercent: 99 } } });
    assert.equal(f.chats.getCliAccount("gpt-2")!.remainingPercent, 75);
  } finally { await f.close(); }
});

test("[P2] ownership adoption happens once and missing markers never regain approval after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-marker-once-"));
  try {
    const settings = settingsStub(), dir = join(root, "new");
    const accounts = new CliAccounts(dir, settings), made = accounts.create("gpt");
    rmSync(made.configDir!, { recursive: true, force: true }); mkdirSync(made.configDir!);
    writeFileSync(join(made.configDir!, "keep.txt"), "replacement");
    const reopened = new CliAccounts(dir, settings);
    assert.equal(existsSync(join(made.configDir!, OWNER_MARKER)), false);
    assert.throws(() => reopened.remove(made.accountId), /확인되지 않은 폴더/);
    // Simulate upgrading an account made by the earlier marker-enabled version (no migration flag).
    settings.values.delete("cliAccountOwnerMarkersMigrated");
    const upgraded = new CliAccounts(dir, settings);
    assert.equal(existsSync(join(made.configDir!, OWNER_MARKER)), false);
    assert.throws(() => upgraded.remove(made.accountId), /확인되지 않은 폴더/);
    assert.equal(existsSync(join(made.configDir!, "keep.txt")), true);

    const legacySettings = settingsStub(), legacyRoot = join(root, "legacy"), legacyDir = join(legacyRoot, "claude-2");
    mkdirSync(legacyDir, { recursive: true });
    legacySettings.setSetting("cliAccounts", JSON.stringify([{ accountId: "claude-2", enabled: true, createdAt: 7 }]));
    new CliAccounts(legacyRoot, legacySettings);
    assert.equal(existsSync(join(legacyDir, OWNER_MARKER)), true, "pre-marker accounts migrate once");
    rmSync(join(legacyDir, OWNER_MARKER)); writeFileSync(join(legacyDir, "keep.txt"), "legacy replacement");
    const secondRestart = new CliAccounts(legacyRoot, legacySettings);
    assert.equal(existsSync(join(legacyDir, OWNER_MARKER)), false);
    assert.throws(() => secondRestart.remove("claude-2"), /확인되지 않은 폴더/);
    assert.equal(existsSync(join(legacyDir, "keep.txt")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[B] login makes cached auth unknown for default and added accounts and invalidates an older auth check", async () => {
  const f = fixture();
  let release = () => {}, pending: Promise<unknown> | undefined;
  const exec = mock.method(childProcess, "execFile", ((_exe: string, args: string[], _opts: any, cb: Function) => {
    assert.deepEqual(args, ["auth", "status", "--json"]);
    release = () => cb(null, JSON.stringify({ loggedIn: false }), "");
    return { stdin: { end() {} } };
  }) as any);
  try {
    f.chats.createCliAccount("claude"); f.chats.createCliAccount("gpt");
    const envs: Record<string, string>[] = [];
    f.chats.consoleLauncher = (_exe, _args, env) => { envs.push(env); };
    for (const id of ["claude-1", "claude-2", "gpt-1", "gpt-2", "grok-1"] as const) {
      f.chats.cliAccounts().setAuth(id, { loggedIn: false, checkedAt: Date.now() });
      const kind = f.chats.getCliAccount(id)!.kind;
      assert.throws(() => f.chats.assertCliAccount(id, kind), /상태 새로고침 또는 cli_accounts\(refresh=true\)/);
      f.chats.loginCliAccount(id);
      assert.equal(f.chats.getCliAccount(id)!.authStatus, "unknown");
      assert.doesNotThrow(() => f.chats.assertCliAccount(id, kind));
    }
    assert.deepEqual(envs[0], {}); assert.deepEqual(envs[2], {}); assert.deepEqual(envs[4], {});
    assert.deepEqual(envs[1], { CLAUDE_CONFIG_DIR: join(f.root, "cli-accounts", "claude-2") });
    assert.deepEqual(envs[3], { CODEX_HOME: join(f.root, "cli-accounts", "gpt-2") });
    pending = f.chats.refreshCliAccount("claude-2"); await settle();
    f.chats.loginCliAccount("claude-2"); release(); await pending;
    assert.equal(f.chats.getCliAccount("claude-2")!.authStatus, "unknown", "a pre-login response cannot restore required");
  } finally { release(); await pending?.catch(() => undefined); exec.mock.restore(); await f.close(); }
});

test("failed account changes release their locks without reviving the disposed server", async () => {
  const f = fixture();
  const exec = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _opts: any, cb: Function) => {
    queueMicrotask(() => cb(new Error("fake failure"), "", "")); return { stdin: { end() {} } };
  }) as any);
  try {
    f.chats.createCliAccount("gpt");
    const old = f.chats.codex("gpt-2");
    await assert.rejects(f.chats.logoutCliAccount("gpt-2"), /로그아웃에 실패/);
    const next = f.chats.codex("gpt-2"); assert.notEqual(next, old);
    rmSync(join(f.root, "cli-accounts", "gpt-2", OWNER_MARKER));
    await assert.rejects(f.chats.removeCliAccount("gpt-2"), /확인되지 않은 폴더/);
    assert.notEqual(f.chats.codex("gpt-2"), next);
    assert.equal((f.chats as any).accountChanges.size, 0);
  } finally { exec.mock.restore(); await f.close(); }
});

/** Real Codex RPC/driver with a process that can ignore unsubscribe and EOF. */
function codexCleanupFixture(respondToUnsubscribe = false) {
  const f = fixture(), children: any[] = [], calls: string[] = [];
  let failKill = false, skipExit = false;
  const makeChild = () => {
    const child: any = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 90_000 + children.length });
    child.finish = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.stdout.end(); child.emit("exit", 0); };
    child.kill = () => { if (failKill) return false; if (!skipExit) setTimeout(child.finish, 20); return true; };
    child.stdin.on("finish", () => { if (respondToUnsubscribe) child.finish(); });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const r = JSON.parse(line);
        if (r.id === undefined) continue;
        calls.push(r.method);
        if (r.method === "thread/unsubscribe" && !respondToUnsubscribe) continue;
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\n"));
      }
    });
    children.push(child); return child;
  };
  const spawn = mock.method(childProcess, "spawn", makeChild);
  const exec = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _options: any, cb: Function) => {
    if (_exe === "taskkill") {
      calls.push("kill");
      const child = children.find(c => String(c.pid) === _args[1]);
      queueMicrotask(() => cb(failKill ? new Error("fake denied kill") : null, "", ""));
      if (!failKill && !skipExit) setTimeout(child.finish, 20);
    } else {
      calls.push("logout");
      assert.ok(children.every(c => c.exitCode !== null), "CLI logout starts only after exit, not after taskkill acknowledgement");
      queueMicrotask(() => cb(null, "", ""));
    }
    return { stdin: { end() {} } };
  }) as any);
  return { ...f, children, calls, failKill: () => { failKill = true; }, skipExit: () => { skipExit = true; }, close: async () => {
    for (const child of children) child.finish();
    try { await f.close(); } finally { spawn.mock.restore(); exec.mock.restore(); }
  } };
}

async function idleCodexMaster(f: ReturnType<typeof codexCleanupFixture>) {
  f.chats.createCliAccount("gpt");
  const chat = f.store.createChat(f.project.id, "idle Codex master");
  const server = f.chats.codex("gpt-2");
  await server.ensure();
  const driver = new CodexDriver({ cwd: f.root, nativeId: "idle-thread", exePath: "unused" }, server,
    { nativeId() {}, emit() {}, approve: async () => ({ verdict: "allow_chat" }) });
  server.loaded.add("idle-thread");
  (f.chats as any).live.set(chat.id, { orch: { driver, accountId: "gpt-2" } });
  return { server, driver, chat };
}

for (const operation of ["logout", "remove"] as const) test(`[P2] unresponsive unsubscribe: ${operation} waits for confirmed server exit, unlocks and permits a fresh server`, async () => {
  const f = codexCleanupFixture();
  try {
    const { server } = await idleCodexMaster(f);
    const dir = f.chats.getCliAccount("gpt-2")!.configDir!;
    const started = Date.now();
    const change = operation === "logout" ? f.chats.logoutCliAccount("gpt-2") : f.chats.removeCliAccount("gpt-2");
    await settle();
    assert.equal(f.calls.includes("thread/unsubscribe"), true);
    assert.throws(() => f.chats.codex("gpt-2"), /변경 중/);
    assert.equal(existsSync(dir), true);
    await change;
    assert.ok(Date.now() - started >= CODEX_DISPOSE_TIMEOUT_MS - 50, "unsubscribe deadline elapsed");
    assert.ok(Date.now() - started < CODEX_DISPOSE_TIMEOUT_MS + 5000, "cleanup has a bounded deadline");
    assert.equal(f.children[0].exitCode, 0);
    assert.equal((server as any).pending.size, 0);
    assert.equal((server as any).threads.size, 0);
    assert.equal((f.chats as any).accountChanges.size, 0);
    assert.equal((f.chats as any).codexServers.has("gpt-2"), false);
    if (operation === "remove") {
      assert.equal(existsSync(dir), false);
      f.chats.createCliAccount("gpt");
    } else assert.equal(f.chats.getCliAccount("gpt-2")!.authStatus, "required");
    const next = f.chats.codex("gpt-2"); assert.notEqual(next, server);
    await next.ensure();
    await next.request("account/rateLimits/read", {});
    assert.equal(f.children.length, 2);
  } finally { await f.close(); }
});

for (const operation of ["logout", "remove"] as const) test(`[P2] failed forced server termination aborts ${operation}, preserves data and unlocks without allowing server replacement`, async () => {
  const f = codexCleanupFixture();
  try {
    await idleCodexMaster(f); f.failKill();
    const dir = f.chats.getCliAccount("gpt-2")!.configDir!;
    const change = operation === "logout" ? f.chats.logoutCliAccount("gpt-2") : f.chats.removeCliAccount("gpt-2");
    await assert.rejects(change, /서버 종료를 확인하지 못했습니다.*계정 변경을 중단/);
    assert.equal((f.chats as any).accountChanges.size, 0);
    assert.equal(existsSync(dir), true);
    assert.equal(f.children[0].exitCode, null);
    assert.equal(f.calls.includes("logout"), false);
    assert.equal((f.chats as any).codexServers.has("gpt-2"), true);
    assert.throws(() => f.chats.codex("gpt-2"), /서버 종료가 확인되지 않았습니다/);
    // Once the process does exit, retry can complete and the account is usable again.
    f.children[0].finish();
    if (operation === "logout") await f.chats.logoutCliAccount("gpt-2");
    else { await f.chats.removeCliAccount("gpt-2"); f.chats.createCliAccount("gpt"); }
    assert.doesNotThrow(() => f.chats.codex("gpt-2"));
  } finally { await f.close(); }
});

test("normal Codex unsubscribe detaches only its thread and preserves the shared server", async () => {
  const f = codexCleanupFixture(true);
  try {
    const { server, driver } = await idleCodexMaster(f);
    server.loaded.add("other-thread");
    await driver.dispose();
    assert.equal(f.children[0].exitCode, null);
    assert.equal(server.loaded.has("idle-thread"), false);
    assert.equal(server.loaded.has("other-thread"), true);
    assert.equal(f.calls.includes("kill"), false);
    assert.equal((server as any).threads.size, 0);
    await server.request("account/rateLimits/read", {});
  } finally { await f.close(); }
});

test("taskkill acknowledgement without process exit never permits account deletion", async () => {
  const f = codexCleanupFixture();
  try {
    await idleCodexMaster(f); f.skipExit();
    const dir = f.chats.getCliAccount("gpt-2")!.configDir!;
    await assert.rejects(f.chats.removeCliAccount("gpt-2"), /강제 종료 후에도 프로세스 종료 응답이 없습니다/);
    assert.equal(existsSync(dir), true);
    assert.equal((f.chats as any).accountChanges.size, 0);
    assert.equal(f.children[0].exitCode, null);
    assert.throws(() => f.chats.codex("gpt-2"), /서버 종료가 확인되지 않았습니다/);
  } finally { await f.close(); }
});

for (const operation of ["remove", "logout"] as const) test(`[P2] login token replacement retains a failed old server and prevents ${operation} from bypassing cleanup`, async () => {
  const f = fixture();
  let restore = () => {}, logouts = 0;
  const exec = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _options: any, cb: Function) => {
    logouts++; queueMicrotask(() => cb(null, "", "")); return { stdin: { end() {} } };
  }) as any);
  try {
    f.chats.createCliAccount("gpt"); f.chats.consoleLauncher = () => {};
    const first = f.chats.codex("gpt-2"), dir = f.chats.getCliAccount("gpt-2")!.configDir!;
    const dispose = mock.method(first, "dispose", async () => { throw new Error("fake termination failure"); });
    restore = () => dispose.mock.restore();
    f.chats.loginCliAccount("gpt-2");
    assert.throws(() => f.chats.codex("gpt-2"), /이전 Codex 서버 종료 중/);
    const entry = (f.chats as any).codexServers.get("gpt-2");
    assert.equal(entry.server, first);
    await assert.rejects(entry.closing, /서버 종료를 확인하지 못했습니다/);
    assert.throws(() => f.chats.codex("gpt-2"), /서버 종료를 확인하지 못했습니다/);
    const change = operation === "remove" ? f.chats.removeCliAccount("gpt-2") : f.chats.logoutCliAccount("gpt-2");
    await assert.rejects(change, /서버 종료를 확인하지 못했습니다/);
    assert.equal((f.chats as any).codexServers.get("gpt-2"), entry);
    assert.equal(existsSync(dir), true);
    assert.equal((f.chats as any).accountChanges.size, 0);
    assert.equal(logouts, 0, "logout never runs before all old servers are confirmed stopped");
    assert.equal(dispose.mock.callCount(), 2, "explicit account change retries cleanup, never drops the failed server");
    assert.throws(() => f.chats.codex("gpt-2"), /서버 종료를 확인하지 못했습니다/);
    // After confirmed cleanup a retry can finish and a fresh account server is allowed.
    restore();
    if (operation === "remove") { await f.chats.removeCliAccount("gpt-2"); f.chats.createCliAccount("gpt"); }
    else await f.chats.logoutCliAccount("gpt-2");
    assert.notEqual(f.chats.codex("gpt-2"), first);
  } finally { restore(); exec.mock.restore(); await f.close(); }
});

test("[P2] account removal joins an in-progress login token cleanup without creating or losing a server", async () => {
  const f = fixture(), entered = deferred(), gate = deferred();
  let removal: Promise<unknown> | undefined, restore = () => {};
  try {
    f.chats.createCliAccount("gpt"); f.chats.consoleLauncher = () => {};
    const first = f.chats.codex("gpt-2"), dir = f.chats.getCliAccount("gpt-2")!.configDir!;
    const dispose = mock.method(first, "dispose", async () => { entered.resolve(); await gate.promise; });
    restore = () => dispose.mock.restore();
    f.chats.loginCliAccount("gpt-2");
    assert.throws(() => f.chats.codex("gpt-2"), /이전 Codex 서버 종료 중/);
    await entered.promise;
    assert.throws(() => f.chats.codex("gpt-2"), /이전 Codex 서버 종료 중/);
    removal = f.chats.removeCliAccount("gpt-2");
    await settle();
    assert.equal(existsSync(dir), true);
    assert.equal((f.chats as any).codexServers.get("gpt-2").server, first);
    assert.equal(dispose.mock.callCount(), 1);
    gate.resolve(); await removal;
    assert.equal((f.chats as any).codexServers.has("gpt-2"), false);
    assert.equal(existsSync(dir), false);
    assert.equal((f.chats as any).accountChanges.size, 0);
    f.chats.createCliAccount("gpt");
    assert.notEqual(f.chats.codex("gpt-2"), first);
  } finally { gate.resolve(); await removal?.catch(() => undefined); restore(); await f.close(); }
});

// Account-specific judge sessions must never fall back to the CLI's default credentials.
test("approval judge follows master account and blocks account mutation until its decision finishes", async () => {
  const { ApprovalJudge } = await import("./judge");
  const f = fixture();
  const judge = new ApprovalJudge(f.chats, () => ({}));
  try {
    f.chats.createCliAccount("gpt");
    f.chats.setCliAccountPolicy({ gpt: { mode: "fixed", accountId: "gpt-2" } });
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, orchestratorModel: "codex:gpt-6-astra" } });
    const chat = f.store.createChat(f.project.id, "judge");
    const servers: unknown[] = [];
    f.chats.codex = ((id: unknown) => { servers.push(id); return {}; }) as any;
    const session = await (judge as any).session(chat.id, "gpt-2");
    assert.equal(session.driver.opts.accountEnv.CODEX_HOME, join(f.root, "cli-accounts", "gpt-2"));
    assert.deepEqual(servers, ["gpt-2"]);
    let finish!: (value: unknown) => void;
    (judge as any).ask = () => new Promise(resolve => { finish = resolve; });
    const decision = judge.decide(chat.id, {} as any, {} as any);
    await settle();
    assert.equal(f.chats.getCliAccount("gpt-2")?.runningWorkers, 1);
    await assert.rejects(f.chats.removeCliAccount("gpt-2"), /실행 중/);
    assert.throws(() => f.chats.loginCliAccount("gpt-2"), /실행 중/);
    finish({ decision: "allow", reason: "test" }); await decision;
    assert.equal(f.chats.getCliAccount("gpt-2")?.runningWorkers, 0);
    let disposed = false;
    session.driver.stop = async () => {};
    session.driver.dispose = async () => { disposed = true; assert.ok(existsSync(join(f.root, "cli-accounts", "gpt-2"))); };
    await f.chats.removeCliAccount("gpt-2");
    assert.equal(disposed, true);
    assert.equal(f.chats.getCliAccount("gpt-2"), undefined);
  } finally { await judge.dispose(); await f.close(); }
});

test("failed judge disposal preserves the account directory across repeated removal attempts", async () => {
  const { ApprovalJudge } = await import("./judge");
  const f = fixture();
  const judge = new ApprovalJudge(f.chats, () => ({}));
  try {
    f.chats.createCliAccount("gpt");
    f.store.updateProject(f.project.id, { settings: { ...f.project.settings, orchestratorModel: "codex:gpt-6-astra" } });
    const chat = f.store.createChat(f.project.id, "judge");
    f.chats.codex = (() => ({})) as any;
    const session = await (judge as any).session(chat.id, "gpt-2");
    session.driver.stop = async () => {};
    session.driver.dispose = async () => { throw new Error("judge still alive"); };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.chats.removeCliAccount("gpt-2"), /judge still alive/);
      assert.ok(existsSync(join(f.root, "cli-accounts", "gpt-2")));
      assert.ok(f.chats.getCliAccount("gpt-2"));
    }
    session.driver.dispose = async () => {};
  } finally { await judge.dispose(); await f.close(); }
});

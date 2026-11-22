import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, mock } from "node:test";
import { antigravityProfileDir } from "./antigravity-profile";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { startupLoginNotice } from "../renderer/src/lib/cli-status";

const agy = "fixture-agy.exe", claude = "fixture-claude.exe";
const usageReply = JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: .5 }] }] } } });

function token(home: string) {
  const dir = antigravityProfileDir(home); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "antigravity-oauth-token"), "fixture");
}

/** Fake CLIs: claude reports signed out, agy answers usage; tracks how many run at once. */
function fakeClis() {
  const calls: { exe: string; args: string[]; env: Record<string, string>; windowsHide: boolean }[] = [];
  let running = 0, peak = 0;
  const patch = mock.method(childProcess, "execFile", ((exe: string, args: string[], options: any, done: any) => {
    calls.push({ exe, args, env: options.env, windowsHide: options.windowsHide });
    running++; peak = Math.max(peak, running);
    setTimeout(() => {
      running--;
      if (exe === claude) done(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify({ loggedIn: false }), "");
      else done(null, usageReply, "");
    }, 5);
    return { stdin: { end() {} } } as any;
  }) as any);
  return { calls, peak: () => peak, restore: () => patch.mock.restore() };
}

const until = async (ready: () => boolean) => { for (let i = 0; i < 400 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(ready()); };

function manager(root: string, onUsage: () => void = () => {}) {
  const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage: onUsage, event() {} }, root, "unused");
  chats.geminiExe = () => agy; chats.claudeExe = () => claude;
  chats.grokExe = () => { throw new Error("Grok CLI not installed"); };
  (chats as any).codex = () => ({ ensure: async () => { throw new Error("Codex not installed"); }, readUsage: async () => undefined, request: async () => ({}) });
  const consoles: unknown[] = [];
  chats.consoleLauncher = (...args) => { consoles.push(args); };
  return { store, chats, consoles };
}

test("startup login check: enabled accounts once, two at a time, no login console, logged-out accounts named", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-"));
  const { store, chats, consoles } = manager(root);
  chats.createCliAccount("gemini", "A"); chats.createCliAccount("gemini", "B"); chats.createCliAccount("gemini", "Off");
  token(chats.getCliAccount("gemini-2")!.configDir!); token(chats.getCliAccount("gemini-4")!.configDir!);
  chats.updateCliAccount("gemini-4", { enabled: false });
  const cli = fakeClis();
  try {
    const first = chats.checkCliAccountsOnStartup();
    const again = chats.checkCliAccountsOnStartup();
    const [accounts] = await Promise.all([first, again]);
    const callsAfterFirst = cli.calls.length;
    await chats.checkCliAccountsOnStartup();
    assert.equal(cli.calls.length, callsAfterFirst, "a remount or second window never starts another check");
    assert.ok(cli.peak() <= 2, `at most two CLIs at once (peak ${cli.peak()})`);
    assert.equal(consoles.length, 0, "the automatic check never opens an interactive login console");

    const status = (id: string) => accounts.find(a => a.accountId === id)!.authStatus;
    assert.equal(status("claude-1"), "required");
    assert.equal(status("gemini-1"), "authenticated");
    assert.equal(status("gemini-2"), "authenticated");
    assert.equal(status("gemini-3"), "required", "an added Antigravity profile without credentials needs a login");
    assert.equal(status("gemini-4"), "unknown", "disabled accounts are not checked");
    assert.equal(status("gpt-1"), "unknown", "a failing check leaves the state unknown");
    assert.equal(status("grok-1"), "unknown");
    assert.ok(!cli.calls.some(c => c.env.USERPROFILE === chats.getCliAccount("gemini-4")!.configDir), "no process runs for a disabled account");

    const agyCalls = cli.calls.filter(c => c.exe === agy);
    assert.ok(agyCalls.length >= 2 && agyCalls.every(c => c.env.AGY_CLI_DISABLE_AUTO_UPDATE === "true" && c.windowsHide), "background agy runs are hidden and never self-update");
    assert.ok(cli.calls.every(c => c.windowsHide), "every automatic CLI run is hidden");

    const notice = startupLoginNotice(accounts)!;
    assert.match(notice, /claude-1/); assert.match(notice, /gemini-3/);
    assert.doesNotMatch(notice, /gemini-4|gpt-1|grok-1|gemini-2/);
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup login check skips accounts already confirmed this run or being changed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-skip-"));
  const { store, chats } = manager(root);
  chats.createCliAccount("gemini"); chats.createCliAccount("gemini");
  token(chats.getCliAccount("gemini-2")!.configDir!); token(chats.getCliAccount("gemini-3")!.configDir!);
  // Confirmed earlier in this run (e.g. by the periodic usage read): no second process.
  chats.cliAccounts().setAuth("gemini-2", { loggedIn: true, checkedAt: Date.now() });
  // An account change in progress is left alone.
  (chats as any).accountChanges.add("gemini-3");
  const cli = fakeClis();
  try {
    const accounts = await chats.checkCliAccountsOnStartup();
    assert.ok(!cli.calls.some(c => c.env.USERPROFILE === chats.getCliAccount("gemini-2")!.configDir));
    assert.ok(!cli.calls.some(c => c.env.USERPROFILE === chats.getCliAccount("gemini-3")!.configDir));
    assert.equal(accounts.find(a => a.accountId === "gemini-2")!.authStatus, "authenticated");
  } finally { cli.restore(); (chats as any).accountChanges.clear(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("accounts busy or being changed at startup are checked once, after they become free", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-later-"));
  const { store, chats } = manager(root);
  chats.createCliAccount("gemini"); const dir = chats.getCliAccount("gemini-2")!.configDir!; token(dir);
  chats.createCliAccount("gemini"); const busyDir = chats.getCliAccount("gemini-3")!.configDir!; token(busyDir);
  (chats as any).accountChanges.add("gemini-2");
  (chats as any).accountJudges.set("gemini-3", 1); // counts as a running worker
  assert.equal(chats.getCliAccount("gemini-3")!.runningWorkers, 1);
  chats.startupRetryMs = 10;
  const cli = fakeClis();
  try {
    await chats.checkCliAccountsOnStartup();
    assert.equal(cli.calls.filter(c => c.env.USERPROFILE === dir).length, 0, "an account being changed is left alone");
    assert.equal(cli.calls.filter(c => c.env.USERPROFILE === busyDir).length, 0, "an account with a running worker is left alone");
    assert.equal(chats.getCliAccount("gemini-2")!.authStatus, "unknown");
    (chats as any).accountChanges.delete("gemini-2");
    (chats as any).accountJudges.delete("gemini-3");
    await until(() => chats.getCliAccount("gemini-2")!.authStatus === "authenticated" && chats.getCliAccount("gemini-3")!.authStatus === "authenticated");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(cli.calls.filter(c => c.env.USERPROFILE === dir).length, 1, "checked exactly once after it became free");
    assert.equal(cli.calls.filter(c => c.env.USERPROFILE === busyDir).length, 1, "checked exactly once after its worker finished");
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed or slow check never reports an earlier run's state as current; a late answer still lands", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-stale-"));
  let announced = 0;
  const { store, chats } = manager(root, () => { announced++; });
  chats.cliAccounts().setAuth("claude-1", { loggedIn: false, checkedAt: Date.now() - 86_400_000 });
  chats.authTimeoutMs = 20;
  let answerLate: ((stdout: string) => void) | undefined;
  const patch = mock.method(childProcess, "execFile", ((exe: string, _args: string[], _options: any, done: any) => {
    if (exe === claude) answerLate = stdout => done(null, stdout, "");
    else setTimeout(() => done(null, usageReply, ""), 1);
    return { stdin: { end() {} } } as any;
  }) as any);
  try {
    const accounts = await chats.checkCliAccountsOnStartup();
    const before = accounts.find(a => a.accountId === "claude-1")!;
    assert.equal(before.authStatus, "required"); assert.equal(before.authStale, true, "yesterday's answer is marked as such");
    assert.equal(startupLoginNotice(accounts), undefined, "a timed-out check does not announce an old logout");
    const announcedBefore = announced;
    answerLate!(JSON.stringify({ loggedIn: true }));
    await until(() => chats.getCliAccount("claude-1")!.authStale !== true);
    assert.equal(chats.getCliAccount("claude-1")!.authStatus, "authenticated");
    assert.ok(announced > announcedBefore, "the late answer is announced so the screen re-reads the accounts");
  } finally { patch.mock.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("after a caller times out, a new check joins the still-running CLI instead of starting a second one", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-join-"));
  const { store, chats } = manager(root);
  chats.cliInfo = () => [{ agent: "claude", path: claude }];
  chats.authTimeoutMs = 20;
  const answers: ((stdout: string) => void)[] = [];
  const patch = mock.method(childProcess, "execFile", ((exe: string, _args: string[], _options: any, done: any) => {
    if (exe === claude) answers.push(stdout => done(null, stdout, ""));
    else setTimeout(() => done(null, usageReply, ""), 1);
    return { stdin: { end() {} } } as any;
  }) as any);
  try {
    await chats.checkCliAccountsOnStartup();            // gives up waiting after 20 ms
    const [info] = await chats.checkedCliInfo("claude"); // asks again while the first CLI still runs
    assert.equal(info.authStatus, "unknown");
    assert.equal(answers.length, 1, "no second claude process for the same account");
    answers[0](JSON.stringify({ loggedIn: true }));
    await until(() => chats.getCliAccount("claude-1")!.authStatus === "authenticated");
    // Once the first run ended, a new check may start again.
    (chats as any).authChecks.clear();
    void chats.checkedCliInfo("claude");
    await until(() => answers.length === 2);
    answers[1](JSON.stringify({ loggedIn: false }));
    await until(() => chats.getCliAccount("claude-1")!.authStatus === "required");
  } finally { patch.mock.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a usage read that never finishes does not hold back the startup login check", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-hung-"));
  const { store, chats } = manager(root);
  chats.usageWaitMs = 20;
  chats.refreshClaudeUsage = () => new Promise<void>(() => undefined); // hangs forever
  chats.refreshGrokUsage = async () => undefined; chats.refreshDeepSeekBalance = async () => undefined;
  const cli = fakeClis();
  try {
    void chats.refreshUsage();
    const accounts = await chats.checkCliAccountsOnStartup();
    assert.equal(cli.calls.filter(c => c.exe === claude).length, 1, "the login check ran despite the hung usage read");
    assert.equal(accounts.find(a => a.accountId === "claude-1")!.authStatus, "required");
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the CLI status check and the startup check share one run per account", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-auth-shared-"));
  const { store, chats } = manager(root);
  chats.cliInfo = () => [{ agent: "claude", path: claude }, { agent: "gemini", path: agy }];
  const cli = fakeClis();
  try {
    const [infos] = await Promise.all([chats.checkedCliInfo(), chats.checkCliAccountsOnStartup()]);
    // Only the default accounts exist here, so every call belongs to claude-1 or gemini-1.
    assert.equal(cli.calls.filter(c => c.exe === claude).length, 1);
    assert.equal(cli.calls.filter(c => c.exe === agy).length, 1);
    assert.equal(infos.find(i => i.agent === "claude")!.authStatus, "required");
    assert.equal(infos.find(i => i.agent === "gemini")!.authStatus, "authenticated");
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("startup notice ignores enabled accounts with a login already in progress and accounts not confirmed signed out", () => {
  const base = { kind: "claude", configDir: null, createdAt: 0, isDefault: false, runningWorkers: 0 } as const;
  assert.equal(startupLoginNotice([
    { ...base, accountId: "claude-1", label: "기본 계정", enabled: true, authStatus: "unknown" },
    { ...base, accountId: "claude-2", label: "B", enabled: true, authStatus: "authenticated" },
    { ...base, accountId: "claude-3", label: "C", enabled: false, authStatus: "required" },
    { ...base, accountId: "claude-4", label: "D", enabled: true, authStatus: "required", loginError: "콘솔이 종료되었습니다." },
  ] as any), undefined);
});

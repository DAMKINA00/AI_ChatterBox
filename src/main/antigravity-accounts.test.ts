import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, mock } from "node:test";
import { antigravityProfileDir } from "./antigravity-profile";
import { CliAccounts } from "./cli-accounts";
import { clearGeminiModels, listGeminiModels } from "./drivers/gemini-protocol";
import { readGeminiUsage } from "./drivers/gemini-usage";
import { ChatManager } from "./chats";
import { Store } from "./db";

const exe = "fixture-agy.exe";
function token(home: string) {
  const dir = antigravityProfileDir(home); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "antigravity-oauth-token"), "fixture");
}
function fakeCli() {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const patch = mock.method(childProcess, "execFile", ((_exe: string, args: string[], options: any, done: any) => {
    calls.push({ args, env: options.env });
    const a = options.env.USERPROFILE?.endsWith("gemini-2");
    const stdout = args[0] === "models" ? `${a ? "gemini-4-argon-medium" : "gemini-4-hydrogen-high"} Native model\n`
      : JSON.stringify({ status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: a ? .8 : .25 }] }] } } });
    queueMicrotask(() => done(null, stdout, ""));
    return { stdin: { end() {} } } as any;
  }) as any);
  return { calls, restore: () => patch.mock.restore() };
}

test("Antigravity models and usage run in their own profile; model caches never cross accounts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-profiles-")), settings = new Map<string, string>();
  const accounts = new CliAccounts(root, { getSetting: k => settings.get(k), setSetting: (k, v) => void settings.set(k, v) });
  const a = accounts.create("gemini"), b = accounts.create("gemini");
  const cli = fakeCli(), originalHome = process.env.USERPROFILE; clearGeminiModels();
  try {
    await assert.rejects(readGeminiUsage(exe, root, accounts.env(a.accountId)), /로그인/);
    await assert.rejects(listGeminiModels(exe, root, accounts.env(a.accountId)), /로그인/);
    assert.equal(cli.calls.length, 0, "an empty added profile must not silently authenticate using the default account");
    token(a.configDir!); token(b.configDir!);
    const [ma, mb] = await Promise.all([listGeminiModels(exe, root, accounts.env(a.accountId)), listGeminiModels(exe, root, accounts.env(b.accountId))]);
    assert.equal(ma[0].id, "gemini-4-argon-medium"); assert.equal(mb[0].id, "gemini-4-hydrogen-high");
    await listGeminiModels(exe, root, accounts.env(a.accountId)); assert.equal(cli.calls.length, 2);
    const [ua, ub] = await Promise.all([readGeminiUsage(exe, root, accounts.env(a.accountId)), readGeminiUsage(exe, root, accounts.env(b.accountId))]);
    assert.equal(Math.round(ua.weekly!.usedPercent), 20); assert.equal(ub.weekly!.usedPercent, 75);
    assert.ok(cli.calls.every(c => c.env.HOME === c.env.USERPROFILE && !!c.env.SSH_CONNECTION));
    assert.equal(process.env.USERPROFILE, originalHome); assert.deepEqual(accounts.env("gemini-1"), {});
  } finally { cli.restore(); clearGeminiModels(); rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity account refresh, login and logout keep other account readings and credentials intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-manager-")); const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.geminiExe = () => exe;
  chats.createCliAccount("gemini", "A"); chats.createCliAccount("gemini", "B");
  const a = chats.getCliAccount("gemini-2")!, b = chats.getCliAccount("gemini-3")!; token(a.configDir!); token(b.configDir!);
  const cli = fakeCli(); const consoles: any[] = [];
  chats.consoleLauncher = (...args) => { consoles.push(args); };
  try {
    const first = chats.refreshGeminiUsage("gemini-2"); assert.equal(first, chats.refreshGeminiUsage("gemini-2"));
    const second = chats.refreshGeminiUsage("gemini-3"); assert.notEqual(first, second); await Promise.all([first, second]);
    assert.equal(Math.round(chats.getCliAccount("gemini-2")!.remainingPercent!), 80);
    assert.equal(chats.getCliAccount("gemini-3")!.remainingPercent, 25);
    assert.equal(chats.getCliAccount("gemini-2")!.authStatus, "authenticated", "a successful read-only usage query confirms login");
    assert.equal(chats.getCliAccount("gemini-3")!.authStatus, "authenticated");
    assert.equal(chats.usage().gemini, undefined, "added account readings never replace default-account usage");
    chats.loginCliAccount("gemini-2"); assert.deepEqual(consoles[0][1], ["acp", "--login"]); assert.equal(consoles[0][2].USERPROFILE, a.configDir);
    const calls = cli.calls.length; await chats.logoutCliAccount("gemini-2");
    assert.equal(cli.calls.length, calls, "added-account logout never executes shared-keyring logout");
    assert.equal(chats.getCliAccount("gemini-2")!.authStatus, "required");
    assert.equal(existsSync(join(antigravityProfileDir(a.configDir!), "antigravity-oauth-token")), false);
    assert.equal(existsSync(join(antigravityProfileDir(b.configDir!), "antigravity-oauth-token")), true);
    assert.equal(chats.getCliAccount("gemini-3")!.remainingPercent, 25);
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity logout rejects a profile store redirected outside its owned folder", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-auth-link-"));
  const accounts = new CliAccounts(join(root, "accounts"), { getSetting: () => undefined, setSetting() {} });
  const a = accounts.create("gemini"), target = join(root, "other-account"); mkdirSync(target);
  writeFileSync(join(target, "antigravity-oauth-token"), "keep");
  mkdirSync(join(a.configDir!, ".gemini")); symlinkSync(target, antigravityProfileDir(a.configDir!), process.platform === "win32" ? "junction" : "dir");
  try { assert.throws(() => accounts.clearAntigravityCredentials(a.accountId), /다른 위치/); assert.equal(existsSync(join(target, "antigravity-oauth-token")), true); }
  finally { rmSync(root, { recursive: true, force: true }); }
});


test("an Antigravity login invalidates in-flight usage without blocking a fresh account reading", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-login-race-")); const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.geminiExe = () => exe; chats.consoleLauncher = () => {};
  chats.createCliAccount("gemini"); token(chats.getCliAccount("gemini-2")!.configDir!);
  const callbacks: any[] = [];
  const patch = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _options: any, done: any) => { callbacks.push(done); return { stdin: { end() {} } } as any; }) as any);
  const reply = (n: number) => JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: n }] }] } } });
  try {
    const old = chats.refreshGeminiUsage("gemini-2"); await Promise.resolve();
    chats.loginCliAccount("gemini-2");
    const current = chats.refreshGeminiUsage("gemini-2"); await Promise.resolve();
    assert.notEqual(old, current); assert.equal(callbacks.length, 2);
    callbacks[0](null, reply(1), ""); await old;
    assert.equal(chats.usage().accounts?.["gemini-2"], undefined, "old login readings are discarded");
    assert.equal(chats.refreshGeminiUsage("gemini-2"), current, "old completion cannot remove the new in-flight reading");
    callbacks[1](null, reply(.25), ""); await current;
    assert.equal(chats.getCliAccount("gemini-2")!.remainingPercent, 25);
  } finally { patch.mock.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity account changes and scoped checks preserve other provider and account auth caches", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-auth-scope-")); const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.cliInfo = () => [{ agent: "claude", path: "fixture-claude" }, { agent: "gemini", path: exe }];
  chats.geminiExe = () => exe; chats.consoleLauncher = () => {};
  const cache = (chats as any).authChecks as Map<string, { expires: number; promise: Promise<string> }>;
  const claude = { expires: Date.now() + 60_000, promise: Promise.resolve("authenticated") };
  const gemini = { expires: Date.now() + 60_000, promise: Promise.resolve("required") };
  const claudeKey = "claude:fixture-claude:claude-1", geminiKey = `gemini:${exe}:gemini-1`;
  cache.set(claudeKey, claude); cache.set(geminiKey, gemini);
  try {
    chats.createCliAccount("gemini"); chats.loginCliAccount("gemini-2");
    await chats.refreshCliAccount("gemini-2");
    assert.equal(cache.get(claudeKey), claude);
    assert.equal(cache.get(geminiKey), gemini, "added-account login never resets the default account");
    assert.deepEqual(await chats.checkedCliInfo("claude"), [{ agent: "claude", path: "fixture-claude", authStatus: "authenticated" }]);
    assert.deepEqual(await chats.checkedCliInfo("gemini"), [{ agent: "gemini", path: exe, authStatus: "required" }]);
    assert.equal(chats.getCliAccount("gemini-2")!.authStatus, "required");
  } finally { await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity console completion confirms its account or records a visible failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-agy-login-exit-")); const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.geminiExe = () => exe;
  const exits: ((code: number | null) => void)[] = [];
  chats.consoleLauncher = (_exe, _args, _env, _cwd, onExit) => { if (onExit) exits.push(onExit); };
  const cli = fakeCli();
  const until = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await new Promise<void>(resolve => setImmediate(resolve)); assert.ok(ready()); };
  try {
    chats.createCliAccount("gemini"); chats.createCliAccount("gemini");
    chats.cliAccounts().setAuth("gemini-3", { loggedIn: true, checkedAt: Date.now() });
    chats.loginCliAccount("gemini-2"); exits[0](1);
    await until(() => !!chats.getCliAccount("gemini-2")?.loginError);
    assert.match(chats.getCliAccount("gemini-2")!.loginError!, /종료 코드 1/);
    assert.equal(chats.getCliAccount("gemini-3")!.authStatus, "authenticated");
    chats.loginCliAccount("gemini-2");
    assert.equal(chats.getCliAccount("gemini-2")!.loginError, undefined);
    exits[0](1);
    assert.equal(chats.getCliAccount("gemini-2")!.loginError, undefined, "an older console cannot fail a newer login attempt");
    token(chats.getCliAccount("gemini-2")!.configDir!); exits[1](0);
    await until(() => chats.getCliAccount("gemini-2")!.authStatus === "authenticated");
    assert.equal(chats.getCliAccount("gemini-2")!.loginError, undefined);
    assert.equal(chats.getCliAccount("gemini-3")!.authStatus, "authenticated");
    chats.loginCliAccount("gemini-2");
    await chats.removeCliAccount("gemini-2"); chats.createCliAccount("gemini"); exits[2](0);
    assert.equal(chats.getCliAccount("gemini-2")!.authStatus, "unknown", "old login console cannot authenticate a recreated account");
  } finally { cli.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

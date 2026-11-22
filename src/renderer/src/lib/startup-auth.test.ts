import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, mock } from "node:test";
import { ChatManager } from "../../../main/chats";
import { Store } from "../../../main/db";
import { antigravityProfileDir } from "../../../main/antigravity-profile";

const agy = "fixture-agy.exe", claude = "fixture-claude.exe";
const usageReply = JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: .5 }] }] } } });

/**
 * The real renderer start (store.init: install refresh, usage read, startup check) against a real
 * ChatManager wired like the core IPC handlers, with fake CLI processes.
 */
test("app start: each account's CLI runs once, never two at a time beyond the limit, after the usage read; only fresh logouts are announced", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-startup-store-"));
  const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  chats.geminiExe = () => agy; chats.claudeExe = () => claude;
  chats.grokExe = () => { throw new Error("Grok CLI not installed"); };
  chats.cliInfo = () => [{ agent: "claude", path: claude }, { agent: "codex", path: null }, { agent: "gemini", path: agy }, { agent: "grok", path: null }, { agent: "deepseek", path: null }];
  (chats as any).codex = () => ({ ensure: async () => { throw new Error("Codex not installed"); }, readUsage: async () => undefined, request: async () => ({}) });
  chats.refreshClaudeUsage = async () => undefined; chats.refreshGrokUsage = async () => undefined; chats.refreshDeepSeekBalance = async () => undefined;
  const consoles: unknown[] = [];
  chats.consoleLauncher = (...args) => { consoles.push(args); };
  chats.createCliAccount("gemini", "B");
  const extra = chats.getCliAccount("gemini-2")!.configDir!;
  mkdirSync(antigravityProfileDir(extra), { recursive: true }); writeFileSync(join(antigravityProfileDir(extra), "antigravity-oauth-token"), "fixture");
  // Yesterday's answer for an account whose check fails today must not be announced.
  chats.createCliAccount("claude", "Old");
  chats.cliAccounts().setAuth("claude-2", { loggedIn: false, checkedAt: Date.now() - 86_400_000 });
  const oldDir = chats.getCliAccount("claude-2")!.configDir!;

  const calls: { exe: string; profile?: string; start: number; end?: number }[] = [];
  let running = 0, peak = 0;
  const patch = mock.method(childProcess, "execFile", ((exe: string, _args: string[], options: any, done: any) => {
    // Default accounts inherit the process environment, so a call belongs to an added account only by its directory.
    const profile = options.env.CLAUDE_CONFIG_DIR === oldDir ? oldDir : options.env.USERPROFILE === extra ? extra : undefined;
    const call: { exe: string; profile?: string; start: number; end?: number } = { exe, profile, start: Date.now() };
    calls.push(call); running++; peak = Math.max(peak, running);
    setTimeout(() => {
      running--; call.end = Date.now();
      if (exe === claude) done(Object.assign(new Error("exit"), { code: 1 }), call.profile ? "not json" : JSON.stringify({ loggedIn: false }), "");
      else done(null, usageReply, "");
    }, 15);
    return { stdin: { end() {} } } as any;
  }) as any);

  const listeners: unknown[] = [];
  Object.assign(globalThis, {
    window: Object.assign((globalThis as any).window ?? {}, { chatterbox: (globalThis as any).window?.chatterbox ?? {}, setTimeout, clearTimeout, addEventListener: (...args: unknown[]) => listeners.push(args) }),
    document: { documentElement: { classList: { toggle() {} } }, hasFocus: () => false },
    localStorage: { getItem: () => null },
  });
  const { api } = await import("./utils");
  const noop = () => undefined;
  Object.assign(api, {
    onUsage: noop, onEvent: noop, onChatUpdated: noop, onConsultUpdated: noop, onAgentsUpdated: noop, onSelectChat: noop, onChatDeleted: noop, onProjectsUpdated: noop,
    listProjects: async () => [], listChats: async () => [], getTheme: async () => "dark",
    // Same handlers as core.ts.
    cliInfo: (checkAuth?: boolean, agent?: string) => checkAuth ? chats.checkedCliInfo(agent as any) : Promise.resolve(chats.cliInfo().filter(info => !agent || info.agent === agent)),
    usage: async (wait = false) => { const refresh = chats.refreshUsage(); if (wait === true) await refresh; return chats.usage(); },
    cliAccounts: { list: async () => chats.listCliAccounts(), startupCheck: () => chats.checkCliAccountsOnStartup() },
  });
  const { useStore } = await import("../store");
  const toasts: string[] = [];
  useStore.setState({ toast: (text: string) => { toasts.push(text); } } as any);
  try {
    await useStore.getState().init();
    await (async () => { for (let i = 0; i < 400 && !toasts.length; i++) await new Promise(resolve => setTimeout(resolve, 5)); })();
    await new Promise(resolve => setTimeout(resolve, 60));

    const claudeDefault = calls.filter(c => c.exe === claude && !c.profile), claudeOld = calls.filter(c => c.exe === claude && c.profile);
    const agyDefault = calls.filter(c => c.exe === agy && !c.profile), agyExtra = calls.filter(c => c.exe === agy && c.profile === extra);
    assert.equal(claudeDefault.length, 1, "the default Claude login is checked once, not again by the CLI status refresh");
    assert.equal(claudeOld.length, 1);
    assert.equal(agyDefault.length, 1, "the usage read already confirms Antigravity; the startup check does not repeat it");
    assert.equal(agyExtra.length, 1);
    assert.ok(peak <= 2, `at most two CLIs at once (peak ${peak})`);
    const usageEnd = Math.max(...[...agyDefault, ...agyExtra].map(c => c.end!));
    assert.ok([...claudeDefault, ...claudeOld].every(c => c.start >= usageEnd), "login checks start after the usage read");
    assert.equal(consoles.length, 0, "no login console opens by itself");

    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /claude-1/);
    assert.doesNotMatch(toasts[0], /claude-2|gemini/);
    const state = useStore.getState();
    assert.equal(state.cli.find(c => c.agent === "claude")?.authStatus, "required");
    assert.equal(state.cli.find(c => c.agent === "gemini")?.authStatus, "authenticated");
    assert.equal(state.cliAccounts.find(a => a.accountId === "claude-2")?.authStale, true);
  } finally { patch.mock.restore(); await chats.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

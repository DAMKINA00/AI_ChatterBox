import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { CliAccountId, CliAccountStatus, UsageInfo } from "../shared/types";
import type { UsageMonitorState } from "../shared/usage-companion";
import { UsageCompanion, type UsageChild } from "./usage-companion";
import { MONITOR_ACCOUNTS_VERSION, MonitorFeed, monitorAccountsPayload, type MonitorAccountsPayload } from "./usage-monitor-feed";

const NOW = 1_800_000_000_000;
function account(accountId: CliAccountId, label: string, used: number, extra: Partial<CliAccountStatus> = {}): CliAccountStatus {
  const kind = accountId.split("-")[0] as CliAccountStatus["kind"];
  return {
    accountId, kind, label, enabled: true, createdAt: 0, isDefault: accountId.endsWith("-1"), authStatus: "authenticated", runningWorkers: 0,
    configDir: accountId.endsWith("-1") ? null : `C:\\Users\\damki\\AppData\\Roaming\\AI_ChatterBox\\cli-accounts\\${accountId}`,
    auth: { loggedIn: true, checkedAt: NOW, email: `${accountId}@example.com` },
    usage: { checkedAt: NOW - 60_000, fiveHour: { usedPercent: 10, resetsAt: NOW / 1000 + 600 }, weekly: { usedPercent: used, resetsAt: NOW / 1000 + 86_400 } },
    ...extra,
  };
}
const ACCOUNTS = [account("claude-1", "기본 클로드", 29), account("gpt-1", "PREVATE", 57), account("gpt-2", "PUBLIC 1", 51), account("gpt-3", "PUBLIC 2", 15), account("grok-1", "기본 그록", 1)];
const USAGE: UsageInfo = { deepseek: { state: "ready", balances: [{ currency: "USD", total: "5.20", granted: "0", toppedUp: "5.20" }] } };

test("the monitor payload is ChatterBox's accounts in order with labels, flags, windows and check times only", () => {
  const p = monitorAccountsPayload(ACCOUNTS, USAGE, NOW);
  assert.equal(p.version, MONITOR_ACCOUNTS_VERSION);
  assert.equal(p.sentAt, NOW);
  assert.deepEqual(p.groups.map(g => [g.kind, g.accounts.map(a => [a.accountId, a.label])]), [
    ["claude", [["claude-1", "기본 클로드"]]], ["gpt", [["gpt-1", "PREVATE"], ["gpt-2", "PUBLIC 1"], ["gpt-3", "PUBLIC 2"]]], ["grok", [["grok-1", "기본 그록"]]],
  ]);
  const gpt3 = p.groups[1].accounts[2];
  assert.deepEqual([gpt3.enabled, gpt3.checkedAt, Math.round(gpt3.display!.remaining), gpt3.display!.window], [true, NOW - 60_000, 85, "주간"]);
  assert.deepEqual(gpt3.windows, { fiveHour: { usedPercent: 10, resetsAt: NOW / 1000 + 600 }, weekly: { usedPercent: 15, resetsAt: NOW / 1000 + 86_400 } });
  assert.deepEqual(p.deepseek, { state: "ready", balances: [{ currency: "USD", total: "5.20" }] });
});

test("nothing secret goes to the monitor: no email, folder, token, key or path in an error", () => {
  const withSecrets = [...ACCOUNTS.slice(0, 2), account("gpt-2", "PUBLIC 1", 51, { usage: { checkedAt: NOW, error: "spawn C:\\Users\\damki\\codex.exe ENOENT (token sk-abc)" } })];
  const usage: UsageInfo = { ...USAGE, deepseek: { state: "error", balances: [], error: "401 https://api.deepseek.com/user/balance" }, geminiWeb: { status: "available", detail: "me@gmail.com", checkedAt: NOW } };
  const text = JSON.stringify(monitorAccountsPayload(withSecrets, usage, NOW));
  assert.doesNotMatch(text, /@|AppData|Users|configDir|"auth"|email|sk-|https?:|deepseek\.com|toppedUp|granted|geminiWeb/, text);
  assert.match(text, /자세한 내용은 데스크톱 앱에서 확인/);
});

test("the feed pushes after usage updates and account changes, coalesced, without asking the core to refresh", async () => {
  let accounts = ACCOUNTS;
  let reads = 0;
  const sent: MonitorAccountsPayload[] = [];
  const feed = new MonitorFeed({ accounts: async () => { reads++; return accounts; }, send: p => sent.push(p), delayMs: 5, now: () => NOW });
  feed.usage(USAGE);
  feed.changed();
  feed.changed();
  await new Promise(ok => setTimeout(ok, 30));
  assert.equal(sent.length, 1, "several triggers in a moment send one snapshot");
  assert.equal(sent[0].deepseek?.balances[0].total, "5.20");
  // Rename, disable, add and remove accounts in ChatterBox: the next push is exactly the new list.
  accounts = [account("claude-1", "기본 클로드", 29), account("gpt-1", "개인", 57), { ...account("gpt-2", "PUBLIC 1", 51), enabled: false }, account("gpt-5", "새 계정", 0)];
  feed.changed();
  await new Promise(ok => setTimeout(ok, 30));
  assert.deepEqual(sent[1].groups.flatMap(g => g.accounts.map(a => `${a.accountId}:${a.label}:${a.enabled}`)), ["claude-1:기본 클로드:true", "gpt-1:개인:true", "gpt-2:PUBLIC 1:false", "gpt-5:새 계정:true"]);
  assert.equal(reads, 2);
  feed.dispose();
});

class FakeStream extends EventEmitter {
  writes: string[] = [];
  write(data: string) { this.writes.push(data); return true; }
  end() { this.emit("finish"); }
}
class FakeChild extends EventEmitter implements UsageChild {
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  send(value: unknown) { this.stdout.emit("data", JSON.stringify(value) + "\n"); }
}
const STATE: UsageMonitorState = { visible: false, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: false, claudeLoggedIn: false };

test("the companion sends the snapshot only to a monitor that announces the version, again after a restart, and forwards refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-monitor-feed-"));
  const children: FakeChild[] = [];
  let refreshes = 0;
  const companion = new UsageCompanion({
    exe: join(root, "AIUsageMonitor.exe"), settingsFile: join(root, "desktop.json"), allowed: true, changed() {}, notification() {},
    refreshRequested: () => { refreshes++; },
  }, () => { const child = new FakeChild(); children.push(child); return child; });
  const payload = monitorAccountsPayload(ACCOUNTS, USAGE, NOW);
  const accountLines = (child: FakeChild) => child.stdin.writes.map(line => JSON.parse(line)).filter(m => m.command === "chatterbox-accounts");

  // An older monitor (no accountsVersion in its state) never receives it.
  const old = companion.start();
  children[0].send({ type: "state", state: STATE });
  await old;
  companion.setAccounts(payload);
  assert.deepEqual(accountLines(children[0]), []);

  // A monitor that reads version 1 gets the current snapshot as soon as it announces itself, then every change once.
  children[0].emit("exit", 0);
  const next = companion.start();
  children[1].send({ type: "state", state: { ...STATE, accountsVersion: MONITOR_ACCOUNTS_VERSION } });
  await next;
  assert.deepEqual(accountLines(children[1]).map(m => m.value), [payload]);
  children[1].send({ type: "state", state: { ...STATE, accountsVersion: MONITOR_ACCOUNTS_VERSION, visible: true } });
  assert.equal(accountLines(children[1]).length, 1, "the same snapshot is not sent twice");
  const changed = monitorAccountsPayload(ACCOUNTS.slice(0, 1), USAGE, NOW + 1);
  companion.setAccounts(changed);
  assert.deepEqual(accountLines(children[1]).map(m => m.value.groups.length), [3, 1]);
  assert.ok(children[1].stdin.writes.every(line => line.endsWith("\n") && !line.slice(0, -1).includes("\n")), "one JSON line per message");

  children[1].send({ type: "refresh" });
  assert.equal(refreshes, 1);
  rmSync(root, { recursive: true, force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliAccountId, CliAccountStatus, UsageInfo } from "./types";
import { deepSeekBalanceText, usageGroups, usageSummary } from "./usage-view";

const NOW = 1_800_000_000_000;
function account(accountId: CliAccountId, label: string, used?: number, extra: Partial<CliAccountStatus> = {}): CliAccountStatus {
  const kind = accountId.split("-")[0] as CliAccountStatus["kind"];
  return {
    accountId, kind, label, configDir: accountId.endsWith("-1") ? null : `C:\\Users\\x\\AppData\\Roaming\\AI_ChatterBox\\cli-accounts\\${accountId}`,
    enabled: true, createdAt: 0, isDefault: accountId.endsWith("-1"), authStatus: "authenticated", runningWorkers: 0,
    auth: { loggedIn: true, checkedAt: NOW, email: `${accountId}@example.com` },
    ...(used === undefined ? {} : { usage: { checkedAt: NOW, weekly: { usedPercent: used, resetsAt: NOW / 1000 + 3600 } } }),
    ...extra,
  };
}

// The accounts and values of the desktop panel in the request (claude 71%, gpt 43/49/85%, grok 99%).
const accounts = [
  account("claude-1", "기본 클로드", 29),
  account("gpt-1", "PREVATE", 57), account("gpt-2", "PUBLIC 1", 51), account("gpt-3", "PUBLIC 2", 15),
  account("grok-1", "기본 그록", 1),
];

test("usage groups are exactly the account store's accounts, labels and order, with each account's stored reading", () => {
  const groups = usageGroups(accounts, {});
  assert.deepEqual(groups.map(g => [g.kind, g.name, g.accounts.map(a => a.label)]), [
    ["claude", "클로드", ["기본 클로드"]], ["gpt", "지피티", ["PREVATE", "PUBLIC 1", "PUBLIC 2"]], ["grok", "그록", ["기본 그록"]],
  ]);
  assert.deepEqual(groups.flatMap(g => g.accounts.map(a => Math.round(a.display!.remaining))), [71, 43, 49, 85, 99]);
  const row = groups[1].accounts[2];
  assert.equal(row.checkedAt, NOW);
  assert.equal(row.display?.window, "주간");
  assert.equal(row.display?.resetsAt, NOW / 1000 + 3600);
  assert.equal(usageSummary(groups), "클로드 주간 71% · 지피티 PREVATE 주간 43%, PUBLIC 1 주간 49%, PUBLIC 2 주간 85% · 그록 주간 99%");
});

test("adding, renaming, disabling and removing accounts in ChatterBox is all a usage view needs", () => {
  // Readings left in the usage state for an account that no longer exists are not shown.
  const usage: UsageInfo = { accounts: { "gpt-4": { weekly: { usedPercent: 1 } } } };
  const changed = [account("claude-1", "기본 클로드", 29), account("gpt-1", "개인", 57), { ...account("gpt-2", "PUBLIC 1", 51), enabled: false }, account("gpt-5", "새 계정")];
  const gpt = usageGroups(changed, usage).find(g => g.kind === "gpt")!;
  assert.deepEqual(gpt.accounts.map(a => [a.accountId, a.label, a.enabled]), [["gpt-1", "개인", true], ["gpt-2", "PUBLIC 1", false], ["gpt-5", "새 계정", true]]);
  assert.equal(gpt.accounts[2].display, null, "a new account without a reading shows no value, not another account's");
  assert.equal(usageGroups(changed, usage).some(g => g.kind === "grok"), false, "a family without accounts is left out");
});

test("rows carry no email, folder or auth detail; errors and the DeepSeek balance read the same everywhere", () => {
  const groups = usageGroups([account("grok-1", "그록", undefined, { usage: { checkedAt: NOW, error: "Grok 사용량 조회에 실패했습니다." } })], {});
  const text = JSON.stringify(groups);
  assert.doesNotMatch(text, /@example\.com|AppData|configDir|"auth"/);
  assert.equal(groups[0].accounts[0].error, "Grok 사용량 조회에 실패했습니다.");
  assert.equal(groups[0].accounts[0].display, null);
  assert.equal(usageSummary(groups), "그록 조회 실패");
  assert.equal(deepSeekBalanceText({ state: "ready", balances: [{ currency: "USD", total: "5.20", granted: "0", toppedUp: "5.20" }] }), "5.20 USD");
  assert.equal(deepSeekBalanceText({ state: "unconfigured", balances: [] }), "키 미설정");
  assert.equal(deepSeekBalanceText(undefined), "조회 중");
});

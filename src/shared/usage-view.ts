// One view of subscription usage for every place that shows it (desktop panel, command palette,
// remote web usage sheet). The account list, labels and enabled flags come only from ChatterBox's CLI
// account store (cli-accounts:list); each account's numbers are the reading stored with that account
// (with its check time). Nothing here keeps its own account list, labels or thresholds.
import { CLI_ACCOUNT_KINDS, type CliAccountId, type CliAccountKind, type CliAccountStatus, type UsageInfo } from "./types";
import type { DeepSeekBalance } from "./deepseek";
import { pickUsage, type ProviderUsage, type UsageDisplay } from "./usage";

export const USAGE_KIND_NAME: Record<CliAccountKind, string> = { claude: "클로드", gpt: "지피티", grok: "그록" };

/** One CLI account as usage displays show it. No email, folder or other local detail. */
export interface UsageAccountRow {
  accountId: CliAccountId;
  kind: CliAccountKind;
  label: string;
  /** false: excluded from assignment in ChatterBox; its usage is no longer refreshed. */
  enabled: boolean;
  isDefault: boolean;
  authStatus: CliAccountStatus["authStatus"];
  runningWorkers: number;
  /** Window shown (weekly, or 5-hour when nearly used up), remaining percent and reset time. */
  display: UsageDisplay | null;
  error?: string;
  /** When this account's reading was taken (ms). */
  checkedAt?: number;
  /** Every window the reading has (used percent and reset time), for displays that show more than one. */
  windows?: { fiveHour?: UsageWindowView; weekly?: UsageWindowView; monthly?: UsageWindowView };
}
export interface UsageWindowView { usedPercent: number; resetsAt?: number | null }

export interface UsageKindGroup {
  kind: CliAccountKind;
  name: string;
  accounts: UsageAccountRow[];
}

/**
 * The reading of one account: the one stored with the account (it carries `checkedAt`); before the
 * account store has one, the live per-account value, and for the default `*-1` account the legacy
 * family value from older versions.
 */
export function accountUsage(account: CliAccountStatus, usage: UsageInfo): (ProviderUsage & { checkedAt?: number }) | undefined {
  if (account.usage) return account.usage;
  const live = usage.accounts?.[account.accountId];
  if (live) return live;
  return account.isDefault ? usage[account.kind === "gpt" ? "codex" : account.kind] : undefined;
}

export function usageAccountRow(account: CliAccountStatus, usage: UsageInfo): UsageAccountRow {
  const u = accountUsage(account, usage);
  const checkedAt = u?.checkedAt ?? u?.updatedAt;
  return {
    accountId: account.accountId, kind: account.kind, label: account.label, enabled: account.enabled, isDefault: account.isDefault,
    authStatus: account.authStatus, runningWorkers: account.runningWorkers,
    display: u && !u.error ? pickUsage(u) : null,
    ...(u?.error ? { error: u.error } : {}),
    ...(typeof checkedAt === "number" && Number.isFinite(checkedAt) ? { checkedAt } : {}),
    ...(u && !u.error ? windowsOf(u) : {}),
  };
}

function windowsOf(u: ProviderUsage): Pick<UsageAccountRow, "windows"> {
  const view = (w: ProviderUsage["weekly"]) => (w && Number.isFinite(w.usedPercent) ? { usedPercent: w.usedPercent, ...(w.resetsAt != null ? { resetsAt: w.resetsAt } : {}) } : undefined);
  const windows = Object.fromEntries((["fiveHour", "weekly", "monthly"] as const).map(k => [k, view(u[k])]).filter(([, w]) => w));
  return Object.keys(windows).length ? { windows } : {};
}

/** Text that may leave this PC (remote web, the usage monitor) without emails, local paths or URLs. */
export const safeUsageText = (text: string) =>
  /@|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\/|https?:\/\//i.test(text) ? "조회 실패(자세한 내용은 데스크톱 앱에서 확인)" : text.slice(0, 300);

/** Accounts grouped by family in the account store's order; families without accounts are left out. */
export function usageGroups(accounts: CliAccountStatus[], usage: UsageInfo): UsageKindGroup[] {
  return CLI_ACCOUNT_KINDS
    .map(kind => ({ kind, name: USAGE_KIND_NAME[kind], accounts: accounts.filter(a => a.kind === kind).map(a => usageAccountRow(a, usage)) }))
    .filter(g => g.accounts.length > 0);
}

/** DeepSeek API balance as one short text (the key itself never leaves the core). */
export function deepSeekBalanceText(balance: DeepSeekBalance | undefined): string {
  if (!balance || balance.state === "loading") return "조회 중";
  if (balance.state === "unconfigured") return "키 미설정";
  if (balance.error || balance.state === "error") return balance.error ?? "조회 실패";
  return balance.balances.map(b => `${b.total} ${b.currency}`).join(" · ") || "정보 없음";
}

/** Short text such as "클로드 주간 71% · 지피티 PREVATE 주간 43%, PUBLIC 1 주간 49%". */
export function usageSummary(groups: UsageKindGroup[]): string {
  const one = (r: UsageAccountRow) => (r.error ? "조회 실패" : r.display ? `${r.display.window} ${Math.round(r.display.remaining)}%` : "정보 없음");
  return groups.map(g => g.accounts.length === 1
    ? `${g.name} ${one(g.accounts[0])}`
    : `${g.name} ${g.accounts.map(r => `${r.label} ${one(r)}`).join(", ")}`).join(" · ");
}

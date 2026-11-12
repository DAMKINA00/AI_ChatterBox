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

// ---- what may leave this PC (remote web, the usage monitor)
// An error's original text never leaves: it can quote tokens, paths, emails or URLs. Only one of these
// codes and its fixed text does; the desktop app keeps showing the original.

export const USAGE_ERROR_TEXT = {
  login_required: "로그인이 필요합니다",
  not_installed: "CLI를 찾지 못했습니다",
  rate_limited: "조회 한도에 걸렸습니다. 잠시 뒤 다시 조회합니다",
  timeout: "조회 시간이 초과되었습니다",
  network: "네트워크 오류로 조회하지 못했습니다",
  failed: "사용량 조회에 실패했습니다",
} as const;
export type UsageErrorCode = keyof typeof USAGE_ERROR_TEXT;

/** The kind of a usage/balance error, from its original (local) text. Anything unknown is "failed". */
export function usageErrorCode(text: string): UsageErrorCode {
  if (/찾지 못|설치|not installed|not found|ENOENT/i.test(text)) return "not_installed";
  if (/429|rate.?limit|too many requests|한도에 걸/i.test(text)) return "rate_limited";
  if (/로그인|인증|sign.?in|log.?in|unauthori[sz]ed|forbidden|\b40[13]\b|auth/i.test(text)) return "login_required";
  if (/timed? ?out|시간 초과|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|네트워크|fetch failed|socket/i.test(text)) return "network";
  return "failed";
}

/**
 * Labels are the user's own names for accounts. One that looks like an email, a path, a URL or a token
 * (key prefixes such as sk-/ghp_, "Bearer", or a 20+ character run of letters and digits) is replaced by
 * "계정 N" (N = the account's number) wherever it leaves this PC.
 */
export function publicAccountLabel(accountId: CliAccountId, label: string): string {
  const looksPrivate = /@|[\\/]|^[A-Za-z]:|^~|https?:|www\.|[\x00-\x1f]/i.test(label)
    || /\bbearer\b|\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{4,}/i.test(label)
    || /(?=[A-Za-z0-9_\-+=]*\d)(?=[A-Za-z0-9_\-+=]*[A-Za-z])[A-Za-z0-9_\-+=]{20,}/.test(label);
  return looksPrivate || !label.trim() ? `계정 ${accountId.slice(accountId.lastIndexOf("-") + 1)}` : label.slice(0, 80);
}

/** A row as it may leave this PC: label by publicAccountLabel, error only as a code and its fixed text. */
export function publicUsageRow(row: UsageAccountRow): UsageAccountRow & { errorCode?: UsageErrorCode } {
  const { error, ...rest } = row;
  const code = error ? usageErrorCode(error) : undefined;
  return { ...rest, label: publicAccountLabel(row.accountId, row.label), ...(code ? { error: USAGE_ERROR_TEXT[code], errorCode: code } : {}) };
}

export const publicUsageGroups = (groups: UsageKindGroup[]): UsageKindGroup[] =>
  groups.map(g => ({ ...g, accounts: g.accounts.map(publicUsageRow) }));

export const publicUsageError = (text: string) => USAGE_ERROR_TEXT[usageErrorCode(text)];

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

import type { CliAccountStatus, CliAccountKind, CliAccountPolicies } from "../../../shared/types";
import { CLI_ACCOUNT_KINDS, defaultCliAccountId } from "../../../shared/types";
import type { UsageWindow } from "../../../shared/usage";

export const CLI_KINDS = CLI_ACCOUNT_KINDS;
export type CliKind = CliAccountKind;
export const CLI_KIND_LABEL: Record<CliKind, string> = { claude: "Claude", gpt: "Codex", grok: "Grok" };

export function multipleCliAccounts(accounts: CliAccountStatus[] | undefined, kind: CliKind): CliAccountStatus[] {
  const list = accounts?.filter(account => account.kind === kind) ?? [];
  return list.length > 1 ? list : [];
}

export function cliRemaining(window: UsageWindow | undefined): number | undefined {
  const used = window?.usedPercent;
  return typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100 ? 100 - used : undefined;
}

export function cliCheckedText(timestamp: number | undefined): string {
  if (!timestamp) return "확인 시각 없음";
  const date = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
  return Number.isNaN(date.valueOf()) ? "확인 시각 없음" : `${date.toLocaleString("ko-KR")} 확인`;
}

export function existingCliAccountPolicies(policies: CliAccountPolicies | undefined, accounts: CliAccountStatus[] | undefined): CliAccountPolicies | undefined {
  if (!policies || !accounts) return policies;
  const next: CliAccountPolicies = {};
  for (const kind of CLI_KINDS) {
    const policy = policies[kind];
    if (policy?.mode === "auto" || (policy?.mode === "fixed" && accounts.some(account => account.kind === kind && account.accountId === (policy.accountId ?? defaultCliAccountId(kind))))) next[kind] = policy;
  }
  return next;
}

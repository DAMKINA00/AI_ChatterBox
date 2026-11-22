import type { CliAccountStatus, CliInfo } from "../../../shared/types";

const AGENT_OF_KIND = { claude: "claude", gpt: "codex", gemini: "gemini", grok: "grok" } as const;

/** CLI login states from the default accounts (`*-1`); a state from an earlier run counts as unknown. */
export function cliAuthFromAccounts(cli: CliInfo[], accounts: CliAccountStatus[]): CliInfo[] {
  return cli.map(info => {
    const account = accounts.find(a => a.isDefault && AGENT_OF_KIND[a.kind] === info.agent);
    return account && info.path ? { ...info, authStatus: account.authStale ? "unknown" : account.authStatus } : info;
  });
}

/**
 * After the automatic startup check: names only enabled accounts confirmed signed out during this run.
 * Failed or timed-out checks and states remembered from an earlier run are not reported.
 */
export function startupLoginNotice(accounts: CliAccountStatus[]): string | undefined {
  const need = accounts.filter(a => a.enabled && a.authStatus === "required" && !a.authStale && !a.loginError);
  if (!need.length) return undefined;
  return `로그인이 필요한 CLI 계정: ${need.map(a => `${a.label}(${a.accountId})`).join(", ")} · 연결 설정 > CLI 계정 관리에서 로그인하세요.`;
}

/** Installation-only refreshes must not erase verified login states of unchanged CLIs. */
export function mergeCliInfo(previous: CliInfo[], updates: CliInfo[]): CliInfo[] {
  const merged = new Map(previous.map(info => [info.agent, info]));
  for (const info of updates) {
    const old = merged.get(info.agent);
    merged.set(info.agent, info.path && old?.path === info.path && info.authStatus === undefined
      ? { ...info, authStatus: old.authStatus }
      : info);
  }
  return [...merged.values()];
}

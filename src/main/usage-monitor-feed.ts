// Feeds the hosted AI usage monitor with ChatterBox's account store (protocol in docs/usage-monitor-protocol.md).
// The monitor keeps no account list of its own: it shows exactly these accounts, labels, enabled flags and
// readings. Only ids, labels, flags and numbers go out (no email, token, folder or API key).
import type { CliAccountStatus, UsageInfo } from "../shared/types";
import { safeUsageText, usageGroups, type UsageKindGroup } from "../shared/usage-view";
import type { DeepSeekBalance } from "../shared/deepseek";

/** Major version of the `chatterbox-accounts` message; the monitor announces the one it reads in its state. */
export const MONITOR_ACCOUNTS_VERSION = 1;

export interface MonitorAccountsPayload {
  version: typeof MONITOR_ACCOUNTS_VERSION;
  /** When ChatterBox built this snapshot (ms). Each account also has its own `checkedAt`. */
  sentAt: number;
  groups: UsageKindGroup[];
  deepseek?: { state: DeepSeekBalance["state"]; balances: { currency: string; total: string }[]; error?: string };
}

export function monitorAccountsPayload(accounts: CliAccountStatus[], usage: UsageInfo, now = Date.now()): MonitorAccountsPayload {
  const groups = usageGroups(accounts, usage).map(g => ({
    ...g, accounts: g.accounts.map(r => ({ ...r, label: r.label.slice(0, 80), ...(r.error ? { error: safeUsageText(r.error) } : {}) })),
  }));
  const d = usage.deepseek;
  return {
    version: MONITOR_ACCOUNTS_VERSION, sentAt: now, groups,
    ...(d ? { deepseek: { state: d.state, balances: d.balances.map(b => ({ currency: b.currency, total: b.total })), ...(d.error ? { error: safeUsageText(d.error) } : {}) } } : {}),
  };
}

export interface MonitorFeedOptions {
  /** cli-accounts:list (a synchronous read in the core; never triggers a usage refresh). */
  accounts(): Promise<CliAccountStatus[]>;
  send(payload: MonitorAccountsPayload): void;
  delayMs?: number;
  now?(): number;
}

/**
 * Pushes a new snapshot after every usage update and account change (coalesced). The last usage comes
 * from the core's `usage` events, so pushing never asks the core to refresh (no feedback loop).
 */
export class MonitorFeed {
  private usageState: UsageInfo = {};
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(private readonly options: MonitorFeedOptions) {}

  usage(usage: UsageInfo) {
    this.usageState = usage;
    this.changed();
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.options.delayMs ?? 300);
    this.timer.unref?.();
  }

  /** Builds and sends one snapshot now; a request during a send runs once more afterwards. */
  async flush(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          const accounts = await this.options.accounts();
          this.options.send(monitorAccountsPayload(accounts, this.usageState, this.options.now?.() ?? Date.now()));
        } catch { /* the core is busy or closing; the next change sends again */ }
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

import type { ProviderUsage } from "../../shared/usage";

/** Account allowance from the CLI's `_x.ai/billing`, never session token totals. */
export function parseGrokUsage(value: unknown): ProviderUsage | null {
  if (!record(value) || !record(value.config)) return null;
  const config = value.config;
  const period = record(config.currentPeriod) ? config.currentPeriod : undefined;
  const window = period?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly"
    : period?.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly"
    : !period && record(config.monthlyLimit) ? "monthly" : undefined;
  if (!window) return null;
  let used = config.creditUsagePercent;
  if (used === undefined) {
    const limit = record(config.monthlyLimit) ? config.monthlyLimit.val : undefined;
    const spent = record(config.used) ? config.used.val ?? 0 : 0;
    if (typeof limit === "number" && limit > 0 && Number.isFinite(limit) && typeof spent === "number" && spent >= 0 && Number.isFinite(spent)) {
      used = Math.min(100, spent / limit * 100);
    } else if (period && typeof period.end === "string" && Number.isFinite(Date.parse(period.end)) && config.monthlyLimit === undefined && config.used === undefined) {
      // Match Grok's credit_balance_from_config: an omitted percentage in a valid period is zero.
      used = 0;
    }
  }
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const reset = period?.end ?? config.billingPeriodEnd;
  const timestamp = typeof reset === "string" ? Date.parse(reset) : NaN;
  return { [window]: { usedPercent: used, resetsAt: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null } };
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

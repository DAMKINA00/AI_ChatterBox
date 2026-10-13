// Which usage window to show per provider: weekly remaining by default; the 5-hour window
// only when it is nearly used up (≤ 10% left), or when no weekly value is known.

export interface UsageWindow {
  /** 0–100 */
  usedPercent: number;
  /** Unix seconds (or ms) when the window resets. */
  resetsAt?: number | null;
}

export interface ProviderUsage {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

export interface UsageDisplay {
  window: "주간" | "5시간";
  /** 0–100, remaining */
  remaining: number;
  resetsAt?: number | null;
  /** 5-hour window shown because it is nearly exhausted. */
  warn: boolean;
  /** Shown when weekly data is missing. */
  note?: string;
}

export const FIVE_HOUR_SWITCH_AT = 10;

const remainingOf = (w: UsageWindow) => Math.max(0, Math.min(100, 100 - w.usedPercent));

export function pickUsage(u: ProviderUsage | undefined): UsageDisplay | null {
  if (!u) return null;
  const five = u.fiveHour ? remainingOf(u.fiveHour) : undefined;
  if (u.fiveHour && five !== undefined && five <= FIVE_HOUR_SWITCH_AT)
    return { window: "5시간", remaining: five, resetsAt: u.fiveHour.resetsAt, warn: true };
  if (u.weekly) return { window: "주간", remaining: remainingOf(u.weekly), resetsAt: u.weekly.resetsAt, warn: false };
  if (u.fiveHour) return { window: "5시간", remaining: five!, resetsAt: u.fiveHour.resetsAt, warn: false, note: "주간 정보 없음" };
  return null;
}

/** Codex reports windows as primary/secondary with a duration; sort them into 5h / weekly. */
export function classifyWindow(durationMins: number | null | undefined): "fiveHour" | "weekly" | null {
  if (!durationMins) return null;
  if (durationMins <= 6 * 60) return "fiveHour";
  if (durationMins >= 6 * 24 * 60) return "weekly";
  return null;
}

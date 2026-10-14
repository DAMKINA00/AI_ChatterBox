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
  updatedAt?: number;
  error?: string;
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

/**
 * Claude Code's local "/usage" command output (no API call), e.g.
 *   Current session: 8% used · resets Oct 13, 2:20pm (Asia/Seoul)
 *   Current week (all models): 2% used · resets Oct 20, 5am (Asia/Seoul)
 */
export function parseClaudeUsageText(text: string, now = new Date()): ProviderUsage | null {
  const line = (re: RegExp) => {
    const m = re.exec(text);
    if (!m) return undefined;
    return { usedPercent: Number(m[1]), resetsAt: parseResetTime(m[2] ?? "", now) };
  };
  const fiveHour = line(/Current session:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^(\n]+))?/i);
  const weekly = line(/Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^(\n]+))?/i);
  return fiveHour || weekly ? { fiveHour, weekly } : null;
}

/** "Oct 13, 2:20pm" / "Oct 20, 5am" (local time) → unix seconds. */
export function parseResetTime(s: string, now = new Date()): number | null {
  const m = /([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(s.trim());
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const d = new Date(now.getFullYear(), month, Number(m[2]), hour, Number(m[4] ?? 0));
  // A reset in January seen in December belongs to next year.
  if (d.getTime() < now.getTime() - 86_400_000 * 30) d.setFullYear(d.getFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

/** Codex reports windows as primary/secondary with a duration; sort them into 5h / weekly. */
export function classifyWindow(durationMins: number | null | undefined): "fiveHour" | "weekly" | null {
  if (!durationMins) return null;
  if (durationMins <= 6 * 60) return "fiveHour";
  if (durationMins >= 6 * 24 * 60) return "weekly";
  return null;
}

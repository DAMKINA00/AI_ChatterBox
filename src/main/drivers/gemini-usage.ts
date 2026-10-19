import { execFile } from "node:child_process";
import type { ProviderUsage } from "../../shared/usage";

const MAX_BUFFER = 1024 * 1024;
const GEMINI_USAGE_ERROR = "Gemini 사용량을 가져오지 못했습니다. 네트워크 상태와 Antigravity CLI를 확인해 주세요.";

/** Parse the JSON returned by `agy -p /usage --output-format json`. */
export function parseGeminiUsage(text: string): ProviderUsage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value) || value.status !== "SUCCESS" || !isRecord(value.command) || value.command.name !== "usage") return null;
  if (value.conversation_id || (value.num_turns !== undefined && value.num_turns !== 0)
    || (isRecord(value.usage) && value.usage.total_tokens !== undefined && value.usage.total_tokens !== 0)) return null;
  const data = value.command.data;
  if (!isRecord(data) || !Array.isArray(data.groups)) return null;

  const usage: ProviderUsage = {};
  for (const group of data.groups) {
    if (!isRecord(group) || group.name !== "Gemini Models" || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const window = bucket.window === "weekly" ? "weekly" : bucket.window === "5h" ? "fiveHour" : null;
      if (!window || typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction) || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1) continue;
      if (usage[window]) continue;
      usage[window] = { usedPercent: (1 - bucket.remaining_fraction) * 100, resetsAt: parseResetTime(bucket.reset_time) };
    }
  }

  return usage.weekly || usage.fiveHour ? usage : null;
}

/** Read the local Antigravity CLI usage snapshot without exposing its output on failure. */
export function readGeminiUsage(exe: string, cwd: string): Promise<ProviderUsage> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(GEMINI_USAGE_ERROR));
    try {
      const child = execFile(exe, ["-p", "/usage", "--output-format", "json"], { cwd, windowsHide: true, timeout: 45_000, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        const usage = parseGeminiUsage(stdout);
        // A complete read-only snapshot remains valid if process teardown subsequently times out.
        if (usage) return resolve(usage);
        if (/not logged|sign in|log.?in|authenticate|unauthorized|401/i.test(stdout + stderr))
          return reject(new Error("Antigravity 로그인이 필요합니다. agy에서 로그인한 뒤 다시 조회하세요."));
        if (error?.killed) return reject(new Error("Antigravity 사용량 응답 시간이 초과되었습니다. 잠시 후 다시 조회하세요."));
        if (!error) return reject(new Error("Antigravity 사용량 응답 형식을 확인하지 못했습니다. CLI 버전을 확인하세요."));
        fail();
      });
      child.stdin?.end();
    } catch {
      fail();
    }
  });
}

function parseResetTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

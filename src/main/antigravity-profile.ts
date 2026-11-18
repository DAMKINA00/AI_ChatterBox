import { existsSync } from "node:fs";
import { join } from "node:path";

export const ANTIGRAVITY_TOKEN_FILES = ["antigravity-oauth-token", "jetski-standalone-oauth-token"] as const;
export const antigravityProfileDir = (home: string) => join(home, ".gemini", "antigravity-cli");

/**
 * Every agy process the app starts by itself (usage, models, workers, logout). agy's auto-updater
 * otherwise spawns a separate background update process of its own, outside the app's hidden-window
 * options. The interactive login console the user opens is not covered.
 */
export const AGY_BACKGROUND_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } as const;

/** Added profiles use agy's native SSH/file credential mode, never the shared OS keyring. */
export function requireAntigravityLogin(env: Record<string, string>) {
  if (env.USERPROFILE && !ANTIGRAVITY_TOKEN_FILES.some(name => existsSync(join(antigravityProfileDir(env.USERPROFILE), name))))
    throw new Error("Antigravity 로그인이 필요합니다. CLI 계정 관리에서 이 계정에 로그인한 뒤 다시 조회하세요.");
}

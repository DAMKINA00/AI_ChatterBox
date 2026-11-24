// Claude Code permission rules that hide the app's bridge tools. A deny rule in any settings file wins
// over the app's --allowedTools, so the app can only detect it and tell the user where it is.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const BRIDGE_TOOL_PREFIX = "mcp__chatterbox_bridge";

export interface BridgeDenyRule { file: string; rules: string[] }

/** True when a permission rule blocks the bridge server or one of its tools. */
export function blocksBridge(rule: string): boolean {
  const r = rule.trim();
  return r === BRIDGE_TOOL_PREFIX || r.startsWith(`${BRIDGE_TOOL_PREFIX}__`);
}

function denyRulesIn(file: string): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  try {
    const deny = JSON.parse(text.replace(/^﻿/, ""))?.permissions?.deny;
    return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string" && blocksBridge(r)) : [];
  } catch { return []; }
}

/**
 * Bridge deny rules in the Claude settings a session started in `cwd` may read: the user's settings and
 * the .claude settings of the folder and each folder above it.
 */
export function findBridgeDenyRules(cwd: string, home = homedir()): BridgeDenyRule[] {
  // The folder's own settings come first: that is where Claude Code reads project rules.
  const files: string[] = [join(resolve(cwd), ".claude", "settings.local.json"), join(resolve(cwd), ".claude", "settings.json"), join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json")];
  for (let dir = dirname(resolve(cwd)); ; dir = dirname(dir)) {
    files.push(join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json"));
    if (dirname(dir) === dir) break;
  }
  const seen = new Set<string>();
  return files.flatMap((file) => {
    const key = file.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const rules = denyRulesIn(file);
    return rules.length ? [{ file, rules }] : [];
  });
}

/** Expected bridge tools missing from the tool list a Claude session reported at start. */
export function missingBridgeTools(sessionTools: unknown, expected: readonly string[]): string[] {
  if (!Array.isArray(sessionTools) || !expected.length) return [];
  const have = new Set(sessionTools.filter((t): t is string => typeof t === "string"));
  return expected.filter((t) => !have.has(t));
}

/** True when the session's own report says the bridge server connected (only then can tools be "missing"). */
export function bridgeConnected(mcpServers: unknown): boolean {
  return Array.isArray(mcpServers) && mcpServers.some((s) => s && typeof s === "object" && (s as any).name === "chatterbox_bridge" && (s as any).status === "connected");
}

/**
 * User-facing warning when bridge tools are actually missing; the deny rules found are only the likely
 * cause (the folder's own .claude settings first, then the user's and the folders above).
 */
export function bridgeDenyNotice(missing: readonly string[], rules: readonly BridgeDenyRule[]): string | undefined {
  if (!missing.length) return undefined;
  const short = (names: readonly string[]) => names.map((n) => n.replace(`${BRIDGE_TOOL_PREFIX}__`, "")).join(", ");
  return [
    `이 Claude 세션에 앱 협업 도구가 빠져 있습니다: ${short(missing)}.`,
    ...(rules.length ? ["원인으로 보이는 Claude 설정의 permissions.deny:", ...rules.map((r) => `- ${r.file}: ${short(r.rules)}`)] : ["Claude 설정(permissions.deny 등)에서 이 도구가 막혔는지 확인하세요."]),
    "deny 규칙은 앱의 허용 설정보다 우선하므로, 해당 항목을 지워야 병렬 배정·메시지 도구를 쓸 수 있습니다. (토큰 절약 플러그인이 쓰지 않는 도구로 보고 추가했을 수 있습니다.)",
  ].join("\n");
}

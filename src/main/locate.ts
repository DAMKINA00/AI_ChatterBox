// Locating the CLIs. Explicit settings win; Codex compares installed versions, others use path order.
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

export function findGemini(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const local = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", exe("agy"));
  return onPath("agy") ?? (existsSync(local) ? local : null);
}

export function findGrok(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const local = join(process.env.GROK_HOME || join(homedir(), ".grok"), "bin", exe("grok"));
  return onPath("grok") ?? (existsSync(local) ? local : null);
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir.trim()) continue;
    const f = join(dir.trim(), exe(name));
    if (existsSync(f)) return f;
  }
  return undefined;
}

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}

/**
 * Standalone Claude Code only. The desktop app's private copy under
 * %APPDATA%\Claude\claude-code\<ver>\<hash> is never used: it moves with app updates
 * and is not logged in outside the desktop app.
 */
export function findClaude(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const p = onPath("claude");
  if (p) return p;
  const local = join(homedir(), ".local", "bin", exe("claude"));
  return existsSync(local) ? local : null;
}

type CodexVersion = { core: number[]; pre: string[] };
const codexVersions = new Map<string, { stamp: string; version?: CodexVersion }>();

function codexVersion(path: string): CodexVersion | undefined {
  try {
    const stat = statSync(path);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = codexVersions.get(path);
    if (cached?.stamp === stamp) return cached.version;
    let version: CodexVersion | undefined;
    try {
      const output = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?\s*$/m.exec(output.trim());
      if (match) version = { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] };
    } catch { /* A CLI that cannot report its version is a fallback, not a reason to hide installed CLIs. */ }
    codexVersions.set(path, { stamp, version });
    return version;
  } catch { return undefined; }
}

function compareCodexVersions(a: CodexVersion, b: CodexVersion): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Use the newest installed CLI for both model discovery and execution; explicit overrides win. */
export function findCodex(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const standalone = join(localAppData, "Programs", "OpenAI", "Codex", "bin", exe("codex"));
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const candidates = [...new Set([
    ...(process.platform === "win32" ? [standalone] : []),
    ...subdirs(join(localAppData, "OpenAI", "Codex", "bin")).map(d => join(d, exe("codex"))),
    ...(process.env.PATH ?? "").split(delimiter).filter(dir => dir.trim()).map(dir => join(dir.trim(), exe("codex"))),
    ...subdirs(join(codexHome, "packages", "standalone", "releases")).map(d => join(d, "bin", exe("codex"))),
  ])].filter(existsSync);
  let best = candidates[0] ?? null;
  let version: CodexVersion | undefined;
  for (const path of candidates) {
    const candidate = codexVersion(path);
    if (candidate && (!version || compareCodexVersions(candidate, version) > 0)) {
      best = path;
      version = candidate;
    }
  }
  return best;
}

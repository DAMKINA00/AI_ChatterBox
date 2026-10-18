// Locating the CLIs. Order: settings override → PATH → well-known install folders.
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

export function findGrok(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const local = join(process.env.GROK_HOME || join(homedir(), ".grok"), "bin", exe("grok"));
  return onPath("grok") ?? (existsSync(local) ? local : null);
}

export function findGemini(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const found = onPath("agy");
  if (found) return found;
  const paths = process.platform === "win32"
    ? [process.env.LOCALAPPDATA, join(homedir(), "AppData", "Local")]
      .filter((dir): dir is string => !!dir?.trim())
      .map((dir) => join(dir, "agy", "bin", "agy.exe"))
    : [join(homedir(), ".local", "bin", "agy")];
  // An inherited LOCALAPPDATA may be stale; still check the current user's install.
  return paths.find(existsSync) ?? null;
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

function newest(files: string[]): string | undefined {
  return files.filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
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

/** Same order as AIUsageMonitor Core/CodexAppServer.cs FindExecutable. */
export function findCodex(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const store = newest(subdirs(join(localAppData, "OpenAI", "Codex", "bin")).map((d) => join(d, exe("codex"))));
  if (store) return store;
  const p = onPath("codex");
  if (p) return p;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return (
    newest(subdirs(join(codexHome, "packages", "standalone", "releases")).map((d) => join(d, "bin", exe("codex")))) ??
    null
  );
}

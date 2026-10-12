// Shared helpers for the M0 spike: executable discovery, JSONL reading, process-tree kill.
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, delimiter, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const SCRATCH_DIR = join(SPIKE_DIR, ".scratch");

export function scratch(name: string): string {
  const d = join(SCRATCH_DIR, name);
  mkdirSync(d, { recursive: true });
  return d;
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function newestIn(dirs: string[]): string | undefined {
  return dirs
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir.trim()) continue;
    const f = join(dir.trim(), exe(name));
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** Same search order as AIUsageMonitor Core/CodexAppServer.cs FindExecutable. */
export function findCodex(): string {
  if (process.env.CODEX_EXE && existsSync(process.env.CODEX_EXE)) return process.env.CODEX_EXE;
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  // Store-app CLI: %LOCALAPPDATA%\OpenAI\Codex\bin\<ver>\codex.exe (matches the desktop app version)
  const store = newestIn(subdirs(join(local, "OpenAI", "Codex", "bin")).map((d) => join(d, exe("codex"))));
  if (store) return store;
  const path = onPath("codex");
  if (path) return path;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const standalone = newestIn(
    subdirs(join(codexHome, "packages", "standalone", "releases")).map((d) => join(d, "bin", exe("codex"))),
  );
  if (standalone) return standalone;
  throw new Error("codex executable not found");
}

/** claude on PATH, else the copy the Claude desktop app keeps in %APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe. */
export function findClaude(): string {
  if (process.env.CLAUDE_EXE && existsSync(process.env.CLAUDE_EXE)) return process.env.CLAUDE_EXE;
  const path = onPath("claude") ?? join(homedir(), ".local", "bin", exe("claude"));
  if (existsSync(path)) return path;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const desktop = newestIn(
    subdirs(join(appData, "Claude", "claude-code"))
      .flatMap(subdirs)
      .map((d) => join(d, exe("claude"))),
  );
  if (desktop) return desktop;
  throw new Error("claude executable not found");
}

export function version(file: string): string {
  return spawnSync(file, ["--version"], { encoding: "utf8" }).stdout.trim();
}

/** Calls onLine for every stdout line; stdout is decoded as UTF-8 regardless of the console code page. */
export function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  child.stdout!.setEncoding("utf8");
  createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", onLine);
}

/** child.kill() on Windows only kills the direct child; take the whole tree down (MCP servers, shells). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

export function waitExit(child: ChildProcess, ms = 15000): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => {
      killTree(child);
      resolve(null);
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

export const log = (tag: string, ...args: unknown[]) => console.log(`[${tag}]`, ...args);

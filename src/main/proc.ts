// Child-process helpers: UTF-8 line reading and Windows-safe shutdown.
import { spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Calls onLine for every stdout line, decoded as UTF-8 regardless of the console code page. */
export function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  child.stdout!.setEncoding("utf8");
  createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", onLine);
}

/** child.kill() only kills the direct child on Windows; the CLIs spawn MCP servers and shells. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/** Close stdin and wait for a clean exit; fall back to killing the tree. */
export function shutdown(child: ChildProcess, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      killTree(child);
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
  });
}

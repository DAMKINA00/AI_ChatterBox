// Child-process helpers: UTF-8 line reading and Windows-safe shutdown.
import { execFile, spawnSync, type ChildProcess } from "node:child_process";
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

/** True while a process with this id exists (signal 0 only probes; EPERM still means it exists). */
export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Force-kills the whole tree (taskkill /T /F on Windows) and reports whether the request itself failed. */
export function killTreeChecked(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: timeoutMs },
        error => error ? reject(new Error(`taskkill 실패: ${error.message}`)) : resolve());
    } else if (child.kill("SIGKILL")) resolve();
    else reject(new Error("프로세스 강제 종료 요청에 실패했습니다."));
  });
}

export interface ConfirmedCloseOptions {
  /** Deadline for the exit event and for the pid to disappear after the kill. */
  timeoutMs?: number;
  kill?: (child: ChildProcess, timeoutMs: number) => Promise<void>;
  alive?: (pid: number | undefined) => boolean;
}

/**
 * Ends a process tree and resolves only when the exit is confirmed: the process's own exit event and
 * its pid gone. A live process is tree-killed at once while its children can still be found from it
 * (taskkill /T /F); a failed kill request counts only if the process is really gone. Rejects when the
 * exit is not confirmed within the deadline. Only used where another CLI account continues the same
 * work; the ordinary shutdown above is unchanged.
 */
export async function closeConfirmed(child: ChildProcess, { timeoutMs = 5000, kill = killTreeChecked, alive = pidAlive }: ConfirmedCloseOptions = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (child.pid === undefined && !exited(child)) throw new Error("프로세스 ID를 확인할 수 없어 종료를 확인하지 못했습니다.");
  let onExit!: () => void;
  const exit = new Promise<void>(resolve => { onExit = resolve; });
  child.once("exit", onExit);
  try {
    if (!exited(child)) {
      let killError: unknown;
      try { await kill(child, timeoutMs); } catch (error) { killError = error; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
      if (!exited(child)) throw new Error(killError ? `강제 종료 실패 후 프로세스가 남아 있습니다: ${killError instanceof Error ? killError.message : String(killError)}` : "강제 종료 후에도 프로세스 종료 응답이 없습니다.");
    }
    // The exit event is reported before Windows releases the process object; wait for the pid to go.
    while (alive(child.pid)) {
      if (Date.now() >= deadline) throw new Error(`프로세스(PID ${child.pid})가 아직 남아 있습니다.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { child.removeListener("exit", onExit); }
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

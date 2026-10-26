import { execFile } from "node:child_process";
import type { CliInfo } from "../shared/types";

export function claudeAuthStatus(output: string): CliInfo["authStatus"] {
  return claudeAuthDetail(output).status;
}

/** `claude auth status --json` → login state and, when signed in, the account email. */
export function claudeAuthDetail(output: string): { status: CliInfo["authStatus"]; email?: string } {
  try {
    const status = JSON.parse(output);
    const email = typeof status?.email === "string" && status.email ? status.email : undefined;
    return status?.loggedIn === true ? { status: "authenticated", ...(email ? { email } : {}) } : { status: status?.loggedIn === false ? "required" : "unknown" };
  } catch { return { status: "unknown" }; }
}

export function readClaudeAuthDetail(exe: string, cwd: string, env: Record<string, string> = {}): Promise<{ status: CliInfo["authStatus"]; email?: string }> {
  return new Promise(resolve => {
    execFile(exe, ["auth", "status", "--json"], { cwd, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, env: { ...process.env, ...env } }, (_error, stdout) => {
      // A logged-out CLI can exit nonzero with a valid status document.
      resolve(claudeAuthDetail(stdout));
    });
  });
}

export async function readClaudeAuth(exe: string, cwd: string, env: Record<string, string> = {}): Promise<CliInfo["authStatus"]> {
  return (await readClaudeAuthDetail(exe, cwd, env)).status;
}

import { execFile } from "node:child_process";
import type { CliInfo } from "../shared/types";

export function claudeAuthStatus(output: string): CliInfo["authStatus"] {
  try {
    const status = JSON.parse(output);
    return status?.loggedIn === true ? "authenticated" : status?.loggedIn === false ? "required" : "unknown";
  } catch { return "unknown"; }
}

export function readClaudeAuth(exe: string, cwd: string): Promise<CliInfo["authStatus"]> {
  return new Promise(resolve => {
    execFile(exe, ["auth", "status", "--json"], { cwd, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 }, (_error, stdout) => {
      // A logged-out CLI can exit nonzero with a valid status document.
      resolve(claudeAuthStatus(stdout));
    });
  });
}

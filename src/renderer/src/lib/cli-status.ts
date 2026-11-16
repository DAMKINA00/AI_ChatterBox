import type { CliInfo } from "../../../shared/types";

/** Installation-only refreshes must not erase verified login states of unchanged CLIs. */
export function mergeCliInfo(previous: CliInfo[], updates: CliInfo[]): CliInfo[] {
  const merged = new Map(previous.map(info => [info.agent, info]));
  for (const info of updates) {
    const old = merged.get(info.agent);
    merged.set(info.agent, info.path && old?.path === info.path && info.authStatus === undefined
      ? { ...info, authStatus: old.authStatus }
      : info);
  }
  return [...merged.values()];
}

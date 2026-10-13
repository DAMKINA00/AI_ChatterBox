// Builds FileDiffs for Claude's file tools so edits can be previewed (approval cards, tool cards).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { FileDiff } from "../shared/types";

function read(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function patch(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, "", "", { context: 3 })
    .split("\n")
    .slice(2) // drop the "=====" header and Index line noise
    .join("\n");
}

export function claudeToolDiffs(tool: string, input: any, cwd: string): FileDiff[] | undefined {
  if (!input || typeof input !== "object" || typeof input.file_path !== "string") return undefined;
  const path = isAbsolute(input.file_path) ? input.file_path : resolve(cwd, input.file_path);
  const current = read(path);
  switch (tool) {
    case "Write":
      return [{ path, kind: current === null ? "add" : "update", diff: patch(path, current ?? "", String(input.content ?? "")) }];
    case "Edit": {
      const before = current ?? "";
      const after = input.replace_all
        ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, () => input.new_string);
      return [{ path, kind: "update", diff: patch(path, current === null ? input.old_string : before, current === null ? input.new_string : after) }];
    }
    case "MultiEdit": {
      let text = current ?? "";
      for (const e of input.edits ?? [])
        text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
      return [{ path, kind: "update", diff: patch(path, current ?? "", text) }];
    }
    default:
      return undefined;
  }
}

/** Paths a Claude tool call touches (for risk checks). */
export function claudeToolPaths(input: any): string[] {
  if (!input || typeof input !== "object") return [];
  return ["file_path", "path", "notebook_path"].map((k) => input[k]).filter((v): v is string => typeof v === "string");
}

/** "+3 −1" for a unified diff. */
export function diffStatsText(diff: string): string {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return `+${add} −${del}`;
}

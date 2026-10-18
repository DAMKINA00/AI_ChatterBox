import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DriverHost } from "./types";

/** Antigravity's official PostToolUse only reports the artifact directory, not tool output. */
export function imageFileSnapshot(directory: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (typeof directory !== "string" || !isAbsolute(directory)) return result;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true }).slice(0, 512)) {
      if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      const path = join(directory, entry.name), stat = statSync(path);
      result.set(path, `${stat.mtimeMs}:${stat.size}`);
    }
  } catch { /* Missing or unreadable output is not a generated result. */ }
  return result;
}

/** Read only image outputs reported by a successful generation tool, never its input references. */
export function publishGeneratedImages(result: unknown, id: string, host: DriverHost): number {
  if (!host.image) return 0;
  const candidates = new Set<string>();
  function visit(value: unknown, depth = 0) {
    if (depth > 12) return;
    if (typeof value === "string") {
      if (/^data:image\/(png|jpeg|webp);base64,/.test(value)) candidates.add(value);
      if (isAbsolute(value) && /\.(png|jpe?g|webp)$/i.test(value)) candidates.add(value);
      for (const match of value.matchAll(/(?:[a-z]:[\\/]|\/)[^\r\n"<>|]*?\.(?:png|jpe?g|webp)(?=[\s)\]"<>]|$)/gi)) candidates.add(match[0]);
    } else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.type === "image" && typeof object.data === "string") candidates.add(`data:image/png;base64,${object.data}`);
      else Object.values(object).forEach(v => visit(v, depth + 1));
    }
  }
  visit(result);
  let count = 0;
  for (const value of candidates) {
    if (!value.startsWith("data:") && !existsSync(value)) continue;
    const imageId = `${id}-${count}`;
    try {
      const attachment = host.image({ id: imageId, ...(value.startsWith("data:") ? { base64: value } : { path: value }) });
      host.emit({ type: "image_generation", id: imageId, status: "done", attachment });
      count++;
    } catch { /* A reported path must still contain a valid image to be published. */ }
  }
  return count;
}

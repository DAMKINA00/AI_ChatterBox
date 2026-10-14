import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { AttachmentRef } from "../shared/types";
import type { Store } from "./db";
import type { AttachmentStore } from "./attachments";
import { resolveLink } from "./file-links";

/** Snapshot local raster output so historical previews survive moving the original file. */
export function previewImage(store: Store, attachments: AttachmentStore, chatId: number, href: string): AttachmentRef | null {
  const chat = store.chat(chatId), project = chat && store.project(chat.projectId);
  if (!project) return null;
  try {
    const link = resolveLink(href, project.folder);
    if (!("path" in link) || /^\\\\/.test(link.path) || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(extname(link.path))) return null;
    const key = `image-preview:${chatId}:${createHash("sha256").update(link.path.toLowerCase()).digest("hex")}`;
    const saved = JSON.parse(store.getSetting(key) ?? "null");
    const previous = saved && store.attachment(saved.id);
    const fallback = previous && existsSync(previous.path) ? previous : null;
    if (!existsSync(link.path)) return fallback;
    const stat = statSync(link.path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
    if (fallback && saved.size === stat.size && saved.mtime === stat.mtimeMs) return fallback;
    const bytes = readFileSync(link.path);
    const valid = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      || /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
      || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
      || bytes.toString("ascii", 0, 2) === "BM";
    if (!valid) return null;
    const image = attachments.fromPath(chatId, link.path);
    store.setSetting(key, JSON.stringify({ id: image.id, size: stat.size, mtime: stat.mtimeMs }));
    return image;
  } catch { return null; }
}

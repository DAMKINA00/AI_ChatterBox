// Attachment files are copied into %APPDATA%\AI_ChatterBox\attachments\<chat id>\ so the CLIs
// (and later turns) can always read them, whatever happens to the original.
import { copyFileSync, mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AttachmentRef } from "../shared/types";
import type { Store } from "./db";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

export class AttachmentStore {
  constructor(
    private root: string,
    private store: Store,
  ) {}

  private target(chatId: number, name: string): string {
    const dir = join(this.root, String(chatId));
    mkdirSync(dir, { recursive: true });
    const ext = extname(name);
    const stem = basename(name, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "file";
    let p = join(dir, stem + ext);
    for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
    return p;
  }

  fromPath(chatId: number, src: string): AttachmentRef {
    const name = basename(src);
    const dest = this.target(chatId, name);
    copyFileSync(src, dest);
    return this.store.addAttachment(chatId, name, dest, mimeOf(name), statSync(dest).size);
  }

  fromBytes(chatId: number, name: string, mime: string, bytes: Uint8Array): AttachmentRef {
    const fixed = extname(name) ? name : name + (EXT[mime] ?? "");
    const dest = this.target(chatId, fixed);
    writeFileSync(dest, bytes);
    return this.store.addAttachment(chatId, fixed, dest, mime || mimeOf(fixed), bytes.byteLength);
  }
}

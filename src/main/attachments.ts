// Attachment files are copied into %APPDATA%\AI_ChatterBox\attachments\<chat id>\ so the CLIs
// (and later turns) can always read them, whatever happens to the original.
import { copyFileSync, mkdirSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
    if (!statSync(src).isFile()) throw new Error("폴더는 첨부할 수 없습니다. 파일을 선택해 주세요.");
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

  generatedImage(chatId: number, image: { id: string; path?: string; base64?: string }): AttachmentRef {
    const limit = 32 * 1024 * 1024;
    if (image.path && statSync(image.path).size > limit) throw new Error("이미지 결과가 32MB를 초과합니다.");
    const encoded = (image.base64 ?? "").replace(/^data:image\/[^;]+;base64,/, "");
    if (!image.path && encoded.length > limit * 1.4) throw new Error("이미지 결과가 32MB를 초과합니다.");
    const bytes = image.path ? readFileSync(image.path) : Buffer.from(encoded, "base64");
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
    if (!mime || bytes.length > limit) throw new Error("유효한 PNG/JPEG/WebP 이미지 결과가 없습니다.");
    return this.fromBytes(chatId, `generated-${image.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}`, mime, bytes);
  }
}

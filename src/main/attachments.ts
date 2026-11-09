// Attachment files are copied into %APPDATA%\AI_ChatterBox\attachments\<chat id>\ so the CLIs
// (and later turns) can always read them, whatever happens to the original.
import { constants as fsConstants, copyFileSync, mkdirSync, statSync, writeFileSync, existsSync, readFileSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, statfsSync, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { REMOTE_ATTACHMENT_TYPES } from "../shared/remote-web";
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

/** An unreferenced remote-upload file younger than this is kept (it may be an upload still being recorded). */
export const REMOTE_UPLOAD_GRACE_MS = 10 * 60 * 1000;
/** File names the app gives remote uploads: a random UUID and an allowed extension. Nothing else is collected. */
const isRemoteUploadName = (name: string) => {
  const m = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)$/.exec(name);
  return !!m && Object.hasOwn(REMOTE_ATTACHMENT_TYPES, m[1]);
};
/** Full path as the file system compares it (Windows: case-insensitive). */
const pathKey = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** `released`: files whose record the caller just dropped (no grace). `now`/`remove` are for tests. */
interface GcOptions { now?: number; graceMs?: number; released?: string[]; remove?: (path: string) => void }

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

  /** An independent copy under the branched chat: deleting the source or its file leaves this one. */
  copyForFork(chatId: number, source: AttachmentRef): AttachmentRef {
    if (!lstatSync(source.path).isFile()) throw new Error("일반 파일이 아닙니다.");
    const dest = this.target(chatId, source.name);
    try {
      copyFileSync(source.path, dest, fsConstants.COPYFILE_EXCL);
      return this.store.addAttachment(chatId, source.name, dest, source.mime, statSync(dest).size);
    } catch (error) {
      rmSync(dest, { force: true });
      throw error;
    }
  }

  /** Only what this attempt wrote. A reused chat id can hold older kept files, so the folder goes only if empty. */
  discardForkCopies(paths: string[]) {
    for (const path of paths) {
      try { rmSync(path, { force: true }); rmdirSync(dirname(path)); }
      catch { /* a non-empty folder stays; a locked file is unreferenced and harmless */ }
    }
  }

  // ---- remote web uploads
  // Stored as <root>/remote-pending/<random UUID><ext> for good, sent or not: sending only links the
  // record, nothing moves. The UUID is also kept in the record (it never changes or gets reused, unlike
  // the id). A file lives as long as some record references it: removing the upload or deleting its chat
  // drops the record, and gcRemoteUploads() then deletes the file. Nothing tracks uploads in memory.

  get remoteDir() { return join(this.root, "remote-pending"); }

  /** Directly inside the pending folder (path.relative compares case-insensitively on Windows). */
  isRemoteUpload(path: string): boolean {
    const rel = relative(this.remoteDir, path);
    return !!rel && !isAbsolute(rel) && !rel.includes(sep) && rel !== "..";
  }

  /** Free bytes on the disk that holds remote-pending (overridden in tests). */
  diskFree(): number {
    mkdirSync(this.remoteDir, { recursive: true });
    const s = statfsSync(this.remoteDir);
    return Number(s.bavail) * Number(s.bsize);
  }

  /** Write and record in one synchronous step; if the record fails (chat deleted), the file goes too. */
  fromRemoteBytes(chatId: number, name: string, mime: string, bytes: Uint8Array): AttachmentRef & { uuid: string } {
    const ext = extname(name).toLowerCase();
    if (!Object.hasOwn(REMOTE_ATTACHMENT_TYPES, ext)) throw new Error("첨부할 수 없는 파일 형식입니다.");
    mkdirSync(this.remoteDir, { recursive: true });
    const uuid = randomUUID(), path = join(this.remoteDir, uuid + ext);
    writeFileSync(path, bytes, { flag: "wx" });
    try { return { ...this.store.addAttachment(chatId, name, path, mime, bytes.byteLength, uuid), uuid }; }
    catch (error) {
      rmSync(path, { force: true }); // and if that fails, a later collection removes the unreferenced file
      throw error;
    }
  }

  /**
   * Garbage collection of remote uploads, idempotent and safe to run any time (synchronous, so no send
   * or upload interleaves; never throws). Only files directly in remote-pending named like the app names
   * them (UUID + allowed extension) are considered, and one is deleted only when no attachment record
   * (any chat, sent or not) has its normalized full path, and it is older than `graceMs` (an upload in
   * progress) unless it is in `released` (its record was just dropped by the caller). Everything else
   * is kept: other names, links/junctions/folders, a file whose real path is not directly in the real
   * folder, a file that cannot be examined (left for the next run), or all of it when the folder itself
   * is a link. Records are never deleted here.
   */
  gcRemoteUploads({ now = Date.now(), graceMs = REMOTE_UPLOAD_GRACE_MS, released = [], remove = (path: string) => rmSync(path) }: GcOptions = {}) {
    const result = { removed: 0, kept: 0, skipped: 0 };
    let dirReal: string, entries: Dirent[], refs: Set<string>;
    try {
      if (lstatSync(this.remoteDir).isSymbolicLink()) return result;
      dirReal = realpathSync(this.remoteDir);
      entries = readdirSync(this.remoteDir, { withFileTypes: true });
      refs = new Set(this.store.attachmentPaths().map(pathKey));
    } catch { return result; }
    const freed = new Set(released.map(pathKey));
    for (const entry of entries) {
      if (!entry.isFile() || !isRemoteUploadName(entry.name)) { result.skipped++; continue; }
      const path = join(this.remoteDir, entry.name);
      let bornMs: number;
      try {
        const st = lstatSync(path);
        if (!st.isFile() || relative(join(dirReal, entry.name), realpathSync(path)) !== "") { result.skipped++; continue; }
        bornMs = Math.max(st.mtimeMs, st.birthtimeMs);
      } catch { result.skipped++; continue; }
      if (refs.has(pathKey(path)) || (!freed.has(pathKey(path)) && now - bornMs < graceMs)) { result.kept++; continue; }
      try { remove(path); result.removed++; } catch { result.skipped++; } // retried next run
    }
    return result;
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

// Pure checks the core runs for remote web changes, in the same synchronous step as the save
// (src/main/core.ts "remote:*" channels). Errors carry "HTTP<status>:" so the remote server can answer.
import { lstatSync } from "node:fs";
import type { ApprovalMode, Chat, ProjectSettings } from "../shared/types";
import { REMOTE_PROJECT_SETTING_KEYS, REMOTE_UPLOAD_STORAGE, clampUploadStorageGb, type RemoteUploadKey } from "../shared/remote-web";
import type { AttachmentStore } from "./attachments";
import type { Store } from "./db";

export const remoteError = (status: number, message: string) => new Error(`HTTP${status}:${message}`);

const AUTONOMY: Record<ApprovalMode, number> = { user: 0, orchestrator: 1, "orchestrator-all": 2 };
export const effectiveMode = (s: Pick<ProjectSettings, "approvalMode" | "delegateHighRisk">): ApprovalMode =>
  s.approvalMode === "orchestrator" && s.delegateHighRisk ? "orchestrator-all" : s.approvalMode;
const RAISE = "승인 방식을 더 자율적으로 바꾸려면 확인이 필요합니다.";

/** D3 for a chat: compares against the chat and project as they are now. Returns "before → after" when it changes. */
export function chatApprovalChange(chat: Pick<Chat, "approvalModeOverride">, project: ProjectSettings, patch: Record<string, unknown>, confirm: boolean): string | undefined {
  if (patch.approvalModeOverride === undefined) return undefined;
  const base = effectiveMode(project);
  const before = chat.approvalModeOverride ?? base, after = (patch.approvalModeOverride as ApprovalMode | null) ?? base;
  if (AUTONOMY[after] > AUTONOMY[before] && !confirm) throw remoteError(428, RAISE);
  return after !== before ? `${before} → ${after}` : undefined;
}

/**
 * D3/D5 for a project: only remote-editable keys are merged into the settings as they are now, so
 * desktop-only fields (accountPolicy) and desktop changes made meanwhile are kept.
 */
export function mergeProjectSettings(current: ProjectSettings, changes: Record<string, unknown>, confirm: boolean): { settings: ProjectSettings; approvalChange?: string } {
  const allowed = Object.fromEntries(Object.entries(changes).filter(([k]) => (REMOTE_PROJECT_SETTING_KEYS as readonly string[]).includes(k)));
  const settings = { ...current, ...allowed } as ProjectSettings;
  const before = effectiveMode(current), after = effectiveMode(settings);
  if (AUTONOMY[after] > AUTONOMY[before] && !confirm) throw remoteError(428, RAISE);
  return { settings, approvalChange: after !== before ? `${before} → ${after}` : undefined };
}

export const BUSY_STATUSES = ["working", "approval", "pausing", "paused"];

// ---- remote uploads (D4). No tracking state: the database and the remote-pending folder are the truth,
// and AttachmentStore.gcRemoteUploads() is the only file cleanup. An upload is named by its id and its
// UUID together (RemoteUploadKey): SQLite reuses ids, UUIDs are never reused.
type UploadDb = Pick<Store, "unsentAttachments" | "deleteAttachment">;
type UploadFiles = Pick<AttachmentStore, "isRemoteUpload" | "gcRemoteUploads">;
const STALE = "보내려던 첨부가 이미 없거나 다른 첨부로 바뀌었습니다. 첨부 목록을 새로 고친 뒤 다시 보내세요.";

/** The unsent remote upload of this chat with this id, as stored now. */
const pendingUpload = (db: Pick<UploadDb, "unsentAttachments">, files: Pick<UploadFiles, "isRemoteUpload">, chatId: number, id: number) =>
  db.unsentAttachments(chatId).find(a => a.id === id && !!a.uuid && files.isRemoteUpload(a.path));
const fileState = (path: string): "file" | "missing" | "unknown" => {
  try { return lstatSync(path).isFile() ? "file" : "unknown"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
};

/**
 * remote:att-bytes. Synchronous up to and including the write, so parallel uploads cannot pass together:
 * all remote uploads (sent or not) plus this one must fit `storageBytes` (the desktop setting, clamped to
 * the allowed range), and the disk must keep REMOTE_UPLOAD_STORAGE.minFreeBytes free afterwards; else 507.
 */
export function saveRemoteUpload(db: Pick<Store, "remoteUploadBytes">, files: Pick<AttachmentStore, "diskFree" | "fromRemoteBytes">,
  chatId: number, name: string, mime: string, bytes: Uint8Array, storageBytes: number) {
  const gb = clampUploadStorageGb(storageBytes / 1024 ** 3), cap = Math.round(gb * 1024 ** 3);
  if (db.remoteUploadBytes() + bytes.byteLength > cap)
    throw remoteError(507, `원격 첨부 저장 공간(${gb}GB)이 가득 찼습니다. 원격 첨부가 있는 오래된 채팅을 삭제하거나, 데스크톱 원격 웹 설정에서 한도를 늘리세요.`);
  let free: number;
  try { free = files.diskFree(); } catch { throw remoteError(507, "PC 디스크 여유 공간을 확인할 수 없어 첨부를 저장하지 않았습니다."); }
  if (free - bytes.byteLength < REMOTE_UPLOAD_STORAGE.minFreeBytes)
    throw remoteError(507, `PC 디스크 여유 공간이 ${REMOTE_UPLOAD_STORAGE.minFreeBytes / 1024 ** 3}GB 미만이라 첨부를 저장하지 않았습니다.`);
  return files.fromRemoteBytes(chatId, name, mime, bytes);
}

/** remote:uploads: unsent remote uploads (all chats, or one) as stored now, without local paths; ones whose file is gone are left out. */
export function listRemoteUploads(db: Pick<UploadDb, "unsentAttachments">, files: Pick<UploadFiles, "isRemoteUpload">, chatId?: number) {
  return db.unsentAttachments(chatId)
    .filter(a => !!a.uuid && files.isRemoteUpload(a.path) && fileState(a.path) !== "missing")
    .map(({ id, uuid, chatId, name, mime, size }) => ({ id, uuid: uuid!, chatId, name, mime, size }));
}

/**
 * remote:attachment-remove. false: no such upload; 409: the id now names another upload (stale list).
 * The record goes first, then collection deletes its file (or a later run does, if it is locked now).
 */
export function removeRemoteUpload(db: UploadDb, files: UploadFiles, chatId: number, key: RemoteUploadKey): boolean {
  const row = pendingUpload(db, files, chatId, key.id);
  if (!row) return false;
  if (row.uuid !== key.uuid) throw remoteError(409, "첨부 목록이 바뀌었습니다. 새로 고친 뒤 다시 시도하세요.");
  db.deleteAttachment(row.id);
  files.gcRemoteUploads({ released: [row.path] });
  return true;
}

/**
 * remote:send, checked in the same synchronous step as chats.send (which links before its first await),
 * so no removal or collection runs in between: every key must name an unsent upload of this chat with
 * that UUID whose file is there, else 409 and the web refreshes its list. Sending only links the records;
 * no file moves. Returns the ids for chats.send.
 */
export function checkRemoteSend(db: Pick<UploadDb, "unsentAttachments">, files: Pick<UploadFiles, "isRemoteUpload">, chatId: number, keys: RemoteUploadKey[]): number[] {
  for (const key of keys) {
    const row = pendingUpload(db, files, chatId, key.id);
    if (!row || row.uuid !== key.uuid || fileState(row.path) !== "file") throw remoteError(409, STALE);
  }
  return keys.map(k => k.id);
}

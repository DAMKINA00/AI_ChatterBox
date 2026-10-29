import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AttachmentStore, REMOTE_UPLOAD_GRACE_MS } from "./attachments";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { checkRemoteSend, listRemoteUploads, removeRemoteUpload, saveRemoteUpload } from "./remote-core";
import { REMOTE_UPLOAD_STORAGE } from "../shared/remote-web";
import { DEFAULT_SETTINGS, type AgentInput } from "../shared/types";

const LATER = () => Date.now() + REMOTE_UPLOAD_GRACE_MS + 60_000;

/** Files whose deletion fails, like a file held open by another program. */
class Files extends AttachmentStore {
  locked = new Set<string>();
  /** Free disk space as the core sees it (the real statfs is checked separately). */
  free: number | (() => number) = 100 * 1024 ** 3;
  diskFree() { return typeof this.free === "function" ? this.free() : this.free; }
  gcRemoteUploads(o: Parameters<AttachmentStore["gcRemoteUploads"]>[0] = {}) {
    return super.gcRemoteUploads({ ...o, remove: p => { if (this.locked.has(p)) throw new Error("EBUSY"); rmSync(p); } });
  }
}

/** A real SQLite store, a real ChatManager (only the CLI turn is stubbed) and real files. `restart` reopens both. */
async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-att-"));
  const db = join(dir, "t.db"), root = join(dir, "attachments");
  const s = {} as { store: Store; files: Files; chats: ChatManager; turns: AgentInput[] };
  const open = () => {
    s.store = new Store(db);
    s.files = new Files(root, s.store);
    s.chats = new ChatManager(s.store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, dir, "unused");
    s.turns = [];
    s.chats.sendHandler = async (_chat, input) => { s.turns.push(input); };
  };
  const close = async () => { await s.chats.dispose(); s.store.close(); };
  open();
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const project = s.store.createProject("p", dir, DEFAULT_SETTINGS);
  return Object.assign(s, {
    dir, root,
    chat: () => s.store.createChat(project.id, "c").id,
    up: (chatId: number, name = "a.txt", body = "x") => s.files.fromRemoteBytes(chatId, name, "text/plain", new Uint8Array(Buffer.from(body))),
    key: (a: { id: number; uuid: string }) => ({ id: a.id, uuid: a.uuid }),
    // What core.ts "remote:send" does (ipcMain.handle turns a synchronous throw into a rejection too).
    send: async (chatId: number, keys: { id: number; uuid: string }[]) => s.chats.send(chatId, "보기", checkRemoteSend(s.store, s.files, chatId, keys)),
    listed: (chatId?: number) => listRemoteUploads(s.store, s.files, chatId).map(a => a.id),
    /** The app quits (or crashes) and starts again: new store and stores, and the startup collection. */
    restart: async () => { await close(); open(); return s.files.gcRemoteUploads({ now: LATER() }); },
  });
}

test("uploads are UUID files in remote-pending with the UUID recorded; sending only links them, nothing moves", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const a = s.up(c, "Report.TXT", "hi");
  assert.equal(dirname(a.path), s.files.remoteDir);
  assert.equal(basename(a.path), `${a.uuid}.txt`);
  assert.match(a.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(s.store.unsentAttachments(c)[0].uuid, a.uuid);
  assert.deepEqual(listRemoteUploads(s.store, s.files, c), [{ id: a.id, uuid: a.uuid, chatId: c, name: "Report.TXT", mime: "text/plain", size: 2 }]);
  await s.send(c, [s.key(a)]);
  assert.equal(s.store.attachment(a.id)!.path, a.path, "the record still points at remote-pending");
  assert.equal(readFileSync(a.path, "utf8"), "hi");
  assert.equal(s.turns[0].attachments![0].path, a.path);
  assert.deepEqual(s.listed(c), []);
  assert.equal(s.files.gcRemoteUploads({ now: LATER() }).kept, 1, "a sent upload is referenced, so kept");
  assert.throws(() => s.files.fromRemoteBytes(c, "x.exe", "application/octet-stream", new Uint8Array([1])), /형식/);
});

test("id reuse: a stale {id, uuid} is refused with 409 for remove and send; the new upload is untouched", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const a = s.up(c, "a.txt", "old");
  assert.equal(removeRemoteUpload(s.store, s.files, c, s.key(a)), true);
  const b = s.up(c, "b.txt", "new");
  assert.equal(b.id, a.id, "SQLite handed out the same id again");
  assert.notEqual(b.uuid, a.uuid);
  assert.throws(() => removeRemoteUpload(s.store, s.files, c, s.key(a)), /HTTP409/);
  await assert.rejects(s.send(c, [s.key(a)]), /HTTP409/);
  assert.equal(s.turns.length, 0);
  assert.equal(readFileSync(b.path, "utf8"), "new");
  assert.deepEqual(s.listed(c), [b.id]);
  assert.equal(removeRemoteUpload(s.store, s.files, s.chat(), s.key(b)), false, "another chat: no such upload");
  await s.send(c, [s.key(b)]);
  assert.equal(s.turns[0].attachments![0].name, "b.txt");
});

test("a removal whose file is locked drops the record now; a later collection deletes the file", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const a = s.up(c);
  s.files.locked.add(a.path);
  assert.equal(removeRemoteUpload(s.store, s.files, c, s.key(a)), true);
  assert.ok(!s.store.attachment(a.id) && existsSync(a.path));
  assert.deepEqual(s.listed(c), []);
  await assert.rejects(s.send(c, [s.key(a)]), /HTTP409/);
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 0, kept: 0, skipped: 1 }, "still locked: retried");
  s.files.locked.clear();
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 1, kept: 0, skipped: 0 });
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 0, kept: 0, skipped: 0 }, "idempotent");
});

test("a crash at any step of a send or an upload leaves files and records consistent after restart", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  // 1. The send fails before linking (here: waiting for a pause to be confirmed).
  const a = s.up(c, "a.txt", "a");
  s.store.updateChat(c, { status: "pausing" });
  await assert.rejects(s.send(c, [s.key(a)]), /중지 확인/);
  s.store.updateChat(c, { status: "idle" });
  // 2. The process dies after the message was recorded but before the attachment was linked.
  const b = s.up(c, "b.txt", "b");
  const link = s.store.linkAttachments.bind(s.store);
  s.store.linkAttachments = () => { throw new Error("crash"); };
  await assert.rejects(s.send(c, [s.key(b)]), /crash/);
  s.store.linkAttachments = link;
  assert.equal(s.store.events(c).filter(e => e.event.type === "user").length, 0, "message and link are one transaction: neither was kept");
  // 3. The process dies right after linking.
  const d = s.up(c, "d.txt", "d");
  await s.send(c, [s.key(d)]);
  // 4. The process dies after writing an upload's file but before recording it.
  const orphan = join(s.files.remoteDir, "0b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt");
  writeFileSync(orphan, "half");
  assert.equal(s.files.gcRemoteUploads().kept, 4, "an unrecorded file within the grace period is kept (upload in progress)");
  const after = await s.restart();
  assert.deepEqual(after, { removed: 1, kept: 3, skipped: 0 }, "only the unrecorded file goes");
  assert.ok(!existsSync(orphan));
  for (const x of [a, b, d]) assert.ok(existsSync(x.path) && s.store.attachment(x.id)?.path === x.path, x.name);
  assert.deepEqual(s.listed(c), [a.id, b.id], "unsent ones are still listed and sendable");
  await s.send(c, [s.key(a), s.key(b)]);
  assert.deepEqual(s.listed(c), []);
});

test("collection only touches files the app named (UUID + allowed extension) directly in remote-pending", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  s.up(c); // creates the folder; referenced, so kept
  const dir = s.files.remoteDir;
  const keepNames = ["notes.txt", "0B9D2D4E-61A4-4C41-9D0E-3F6F61F3B0A1.txt", "0b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.exe", "0b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1", "0b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt.bak"];
  for (const n of keepNames) writeFileSync(join(dir, n), "user file");
  const orphan = join(dir, "1b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.png");
  writeFileSync(orphan, "orphan");
  const outside = join(s.dir, "victim");
  mkdirSync(outside);
  writeFileSync(join(outside, "2b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt"), "keep");
  symlinkSync(outside, join(dir, "3b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt"), "junction");
  mkdirSync(join(dir, "4b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.md"));
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 1, kept: 1, skipped: keepNames.length + 2 });
  assert.ok(!existsSync(orphan));
  for (const n of keepNames) assert.ok(existsSync(join(dir, n)), n);
  assert.ok(existsSync(join(outside, "2b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt")));
  // The folder itself replaced by a junction: nothing is collected through it.
  const fake = join(s.dir, "fake-pending");
  mkdirSync(fake);
  writeFileSync(join(fake, "5b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt"), "keep");
  rmSync(join(dir, "3b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt"));
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(fake, dir, "junction");
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 0, kept: 0, skipped: 0 });
  assert.ok(existsSync(join(fake, "5b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt")));
});

test("references are full normalized paths: a same-named file in another folder neither keeps nor loses anything", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const name = "6b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.png";
  // A desktop attachment whose file happens to have the same name, in the chat folder.
  const deskDir = join(s.root, String(c));
  mkdirSync(deskDir, { recursive: true });
  writeFileSync(join(deskDir, name), "desktop");
  const desk = s.store.addAttachment(c, name, join(deskDir, name), "image/png", 7);
  // An unreferenced pending file with that name, and a referenced one whose record spells the path in upper case.
  mkdirSync(s.files.remoteDir, { recursive: true });
  writeFileSync(join(s.files.remoteDir, name), "orphan");
  const other = "7b9d2d4e-61a4-4c41-9d0e-3f6f61f3b0a1.txt";
  writeFileSync(join(s.files.remoteDir, other), "kept");
  s.store.addAttachment(c, other, join(s.files.remoteDir, other).toUpperCase(), "text/plain", 4, other.slice(0, 36));
  assert.deepEqual(s.files.gcRemoteUploads({ now: LATER() }), { removed: 1, kept: 1, skipped: 0 });
  assert.ok(!existsSync(join(s.files.remoteDir, name)), "the pending orphan goes");
  assert.equal(readFileSync(join(deskDir, name), "utf8"), "desktop", "the desktop file stays");
  assert.ok(s.store.attachment(desk.id), "and so does its record (collection never deletes records)");
  assert.ok(existsSync(join(s.files.remoteDir, other)), "a reference in another spelling of the same path keeps the file");
});

test("deleting a chat collects its remote uploads, sent or not; desktop attachments and other chats' uploads stay", async (t) => {
  const s = await setup(t);
  const c = s.chat(), other = s.chat();
  const desktop = s.files.fromBytes(c, "desk.txt", "text/plain", new Uint8Array(Buffer.from("d")));
  const sent = s.up(c, "s.txt");
  await s.send(c, [s.key(sent)]);
  const unsent = s.up(c, "u.txt");
  const others = s.up(other, "o.txt");
  // What core.ts does: the chat's remote-upload paths, then the delete, then collection without grace for them.
  const released = s.store.attachmentPaths(c).filter(p => s.files.isRemoteUpload(p));
  assert.deepEqual(released.sort(), [sent.path, unsent.path].sort());
  await s.chats.deleteChat(c);
  assert.deepEqual(s.files.gcRemoteUploads({ released }), { removed: 2, kept: 1, skipped: 0 });
  assert.ok(!existsSync(sent.path) && !existsSync(unsent.path), "both remote uploads of the deleted chat are gone");
  assert.ok(existsSync(desktop.path), "the desktop attachment stays, as on the desktop");
  assert.ok(existsSync(others.path) && s.listed(other).includes(others.id), "another chat's upload stays");
});

test("an upload whose file vanished is left out of the list and answers 409 when sent", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const a = s.up(c, "a.txt"), b = s.up(c, "b.txt");
  rmSync(a.path);
  assert.deepEqual(s.listed(c), [b.id]);
  await assert.rejects(s.send(c, [s.key(b), s.key(a)]), /HTTP409/);
  assert.equal(s.turns.length, 0);
  assert.equal(s.store.events(c).length, 0);
  assert.deepEqual(s.listed(c), [b.id], "the good one stays pending");
});

test("an upload whose record cannot be stored (chat deleted meanwhile) leaves no file behind", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  s.store.deleteChat(c);
  assert.throws(() => s.up(c), /FOREIGN KEY/);
  assert.equal(s.files.gcRemoteUploads({ now: LATER() }).removed, 0, "nothing left to collect");
});

test("an older database gains the uuid column; desktop records have none and are never remote uploads", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  s.files.fromBytes(c, "desk.txt", "text/plain", new Uint8Array(Buffer.from("d")));
  s.store.db.exec("ALTER TABLE attachments DROP COLUMN uuid");
  await s.restart();
  const [row] = s.store.unsentAttachments(c);
  assert.equal(row.uuid, null);
  assert.deepEqual(s.listed(c), []);
  const a = s.up(c);
  assert.equal(s.store.unsentAttachments(c).find(r => r.id === a.id)!.uuid, a.uuid);
});

test("the cap counts all remote uploads, sent or not: repeating upload → send cannot fill the disk (507)", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const cap = REMOTE_UPLOAD_STORAGE.minGb * 1024 ** 3; // 0.1 GB, the smallest setting
  const ten = new Uint8Array(10 * 1024 * 1024);
  const save = (chatId: number, name: string) => saveRemoteUpload(s.store, s.files, chatId, name, "text/plain", ten, cap);
  const chats = [c];
  for (let i = 0; i < 10; i++) {
    const chat = i ? s.chat() : c; // the cap is for all chats together (a chat stays busy right after a send)
    if (i) chats.push(chat);
    const a = save(chat, `f${i}.txt`);
    await s.send(chat, [s.key(a)]); // sent: no longer counted by the unsent limits, still on disk
  }
  assert.deepEqual(s.listed(), [], "nothing unsent, so the unsent limits never applied");
  assert.equal(s.store.remoteUploadBytes(), 10 * ten.byteLength);
  const files = () => readdirSync(s.files.remoteDir).length;
  assert.throws(() => save(c, "f10.txt"), /HTTP507:원격 첨부 저장 공간\(0\.1GB\)/);
  assert.equal(files(), 10, "nothing written for the refused upload");
  assert.throws(() => saveRemoteUpload(s.store, s.files, c, "x.txt", "text/plain", ten, 1), /HTTP507/, "a setting below the range is clamped up to 0.1 GB, not to zero");
  // Deleting the chats drops their uploads (sent too) and frees the space.
  const released = chats.flatMap(id => s.store.attachmentPaths(id)).filter(p => s.files.isRemoteUpload(p));
  for (const id of chats) await s.chats.deleteChat(id);
  s.files.gcRemoteUploads({ released });
  assert.equal(s.store.remoteUploadBytes(), 0);
  assert.equal(files(), 0);
  assert.ok(save(s.chat(), "again.txt").uuid);
});

test("an upload that would leave less than 5 GB free on the disk is refused (507); so is an unknown free space", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const bytes = new Uint8Array(1024);
  const save = () => saveRemoteUpload(s.store, s.files, c, "a.txt", "text/plain", bytes, 2 * 1024 ** 3);
  s.files.free = REMOTE_UPLOAD_STORAGE.minFreeBytes + 1023;
  assert.throws(save, /HTTP507:PC 디스크 여유 공간이 5GB 미만/);
  s.files.free = () => { throw new Error("EPERM"); };
  assert.throws(save, /HTTP507:PC 디스크 여유 공간을 확인할 수 없어/);
  assert.equal(s.store.remoteUploadBytes(), 0);
  s.files.free = REMOTE_UPLOAD_STORAGE.minFreeBytes + 1024;
  assert.ok(save().uuid, "exactly the floor left is fine");
  // The real check reads the disk (statfs).
  const real = new AttachmentStore(s.root, s.store).diskFree();
  assert.ok(Number.isFinite(real) && real > 0, String(real));
});

test("desktop sends keep working with the message and link in one transaction", async (t) => {
  const s = await setup(t);
  const c = s.chat();
  const desk = s.files.fromBytes(c, "desk.txt", "text/plain", new Uint8Array(Buffer.from("d")));
  await s.chats.send(c, "데스크톱", [desk.id]);
  const [ev] = s.store.events(c).filter(e => e.event.type === "user");
  assert.equal((ev.event as any).attachments[0].id, desk.id);
  assert.deepEqual(s.store.unsentAttachments(c), [], "linked");
  assert.equal(s.turns[0].attachments![0].path, desk.path);
  // A failing link inside an outer transaction rolls back only its own part (savepoint).
  s.store.db.exec("BEGIN");
  const other = s.files.fromBytes(c, "o.txt", "text/plain", new Uint8Array(Buffer.from("o")));
  const link = s.store.linkAttachments.bind(s.store);
  s.store.linkAttachments = () => { throw new Error("fail"); };
  assert.throws(() => s.store.addUserEvent(c, { type: "user", text: "x", attachments: [] }, [other.id]), /fail/);
  s.store.linkAttachments = link;
  s.store.db.exec("COMMIT");
  assert.ok(s.store.attachment(other.id), "the outer transaction's own change stays");
  assert.equal(s.store.events(c).filter(e => e.event.type === "user").length, 1);
});

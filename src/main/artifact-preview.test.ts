import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../shared/types";
import { AttachmentStore } from "./attachments";
import { previewImage } from "./artifact-preview";
import { Store } from "./db";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XkAAAAASUVORK5CYII=", "base64");
const changedPngBytes = Buffer.from(pngBytes);
changedPngBytes[changedPngBytes.length - 1] ^= 1;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-artifact-preview-"));
  const dbPath = join(root, "app.sqlite");
  const store = new Store(dbPath);
  const project = store.createProject("artifact preview", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "artifact preview");
  const attachments = new AttachmentStore(join(root, "attachments"), store);
  return { root, dbPath, chatId: chat.id, store, attachments };
}

test("snapshots a raster image, reuses the cache, restores it after restart, and refreshes after a source change", () => {
  const f = fixture();
  let store: Store | undefined = f.store;
  try {
    const source = join(f.root, "결과 이미지.png");
    const href = encodeURIComponent("결과 이미지.png");
    writeFileSync(source, pngBytes);

    const first = previewImage(store, f.attachments, f.chatId, href);
    assert.ok(first);
    assert.equal(first.mime, "image/png");
    assert.deepEqual(readFileSync(first.path), pngBytes);
    assert.notEqual(first.path, source);

    const cached = previewImage(store, f.attachments, f.chatId, href);
    assert.deepEqual(cached, first);

    store.close();
    store = undefined;
    rmSync(source);
    store = new Store(f.dbPath);
    const reloadedAttachments = new AttachmentStore(join(f.root, "attachments"), store);
    const restored = previewImage(store, reloadedAttachments, f.chatId, href);
    assert.deepEqual(restored, first);
    assert.ok(restored && existsSync(restored.path));
    assert.deepEqual(readFileSync(restored!.path), pngBytes);

    writeFileSync(source, changedPngBytes);
    const newer = new Date(Date.now() + 2_000);
    utimesSync(source, newer, newer);

    const refreshed = previewImage(store, reloadedAttachments, f.chatId, href);
    assert.ok(refreshed);
    assert.notEqual(refreshed.id, first.id);
    assert.notEqual(refreshed.path, first.path);
    assert.deepEqual(readFileSync(refreshed.path), changedPngBytes);
    assert.deepEqual(previewImage(store, reloadedAttachments, f.chatId, href), refreshed);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects remote, UNC, unsupported, fake, missing, and unknown-chat image sources", () => {
  const f = fixture();
  try {
    const valid = join(f.root, "valid.png");
    const svg = join(f.root, "vector.svg");
    const fake = join(f.root, "fake.png");
    writeFileSync(valid, pngBytes);
    writeFileSync(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    writeFileSync(fake, "not an image");

    assert.equal(previewImage(f.store, f.attachments, f.chatId, "https://example.com/valid.png"), null);
    assert.equal(previewImage(f.store, f.attachments, f.chatId, "\\\\server\\share\\valid.png"), null);
    assert.equal(previewImage(f.store, f.attachments, f.chatId, "vector.svg"), null);
    assert.equal(previewImage(f.store, f.attachments, f.chatId, "fake.png"), null);
    assert.equal(previewImage(f.store, f.attachments, f.chatId, "missing.png"), null);
    assert.equal(previewImage(f.store, f.attachments, 999_999, "valid.png"), null);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as { count: number }).count, 0);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

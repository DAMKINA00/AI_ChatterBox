import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { AttachmentStore } from "./attachments";
import { DEFAULT_SETTINGS } from "../shared/types";
import { Store } from "./db";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3XkAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-attachments-"));
  const dbPath = join(root, "app.sqlite");
  const store = new Store(dbPath);
  const project = store.createProject("test", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "test");
  const attachments = new AttachmentStore(join(root, "attachments"), store);
  return { root, dbPath, store, chatId: chat.id, attachments };
}

test("generated images are copied from base64, data URIs, and source paths", () => {
  const f = fixture();
  try {
    const source = join(f.root, "source.png");
    writeFileSync(source, pngBytes);
    const refs = [
      f.attachments.generatedImage(f.chatId, { id: "base64", base64: pngBase64 }),
      f.attachments.generatedImage(f.chatId, { id: "data-uri", base64: `data:image/png;base64,${pngBase64}` }),
      f.attachments.generatedImage(f.chatId, { id: "path", path: source }),
    ];

    for (const ref of refs) {
      assert.equal(ref.mime, "image/png");
      assert.equal(extname(ref.path), ".png");
      assert.deepEqual(readFileSync(ref.path), pngBytes);
      assert.equal(f.store.attachment(ref.id)?.path, ref.path);
    }
    assert.notEqual(refs[2].path, source);
    assert.deepEqual(readFileSync(source), pngBytes);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("generated images reject invalid and oversized content", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.attachments.generatedImage(f.chatId, { id: "invalid", base64: Buffer.from("not an image").toString("base64") }),
      /유효한 PNG\/JPEG\/WebP/,
    );

    const oversizedPath = join(f.root, "oversized.png");
    writeFileSync(oversizedPath, Buffer.alloc(0));
    truncateSync(oversizedPath, 32 * 1024 * 1024 + 1);
    assert.throws(() => f.attachments.generatedImage(f.chatId, { id: "large-path", path: oversizedPath }), /32MB/);

    const oversizedBase64 = "A".repeat(Math.ceil(32 * 1024 * 1024 * 1.4) + 1);
    assert.throws(() => f.attachments.generatedImage(f.chatId, { id: "large-data", base64: oversizedBase64 }), /32MB/);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("generated attachment metadata and file contents survive store reload", () => {
  const f = fixture();
  let store: Store | undefined = f.store;
  try {
    const ref = f.attachments.generatedImage(f.chatId, { id: "persisted", base64: pngBase64 });
    const savedBytes = readFileSync(ref.path);
    store.close();
    store = undefined;
    store = new Store(f.dbPath);

    assert.deepEqual(store.attachment(ref.id), ref);
    assert.deepEqual(readFileSync(ref.path), savedBytes);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fromPath copies non-image Korean and spaced filenames without changing source bytes", () => {
  const f = fixture();
  try {
    const source = join(f.root, "회의 자료 01.txt");
    const sourceBytes = Buffer.from("원본 문서\0bytes", "utf8");
    writeFileSync(source, sourceBytes);

    const ref = f.attachments.fromPath(f.chatId, source);

    assert.equal(ref.name, "회의 자료 01.txt");
    assert.equal(ref.mime, "text/plain");
    assert.equal(ref.size, sourceBytes.byteLength);
    assert.notEqual(ref.path, source);
    assert.deepEqual(readFileSync(ref.path), sourceBytes);
    assert.deepEqual(readFileSync(source), sourceBytes);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fromPath stores duplicate filenames at separate paths", () => {
  const f = fixture();
  try {
    const firstDir = mkdtempSync(join(f.root, "first-"));
    const secondDir = mkdtempSync(join(f.root, "second-"));
    const first = join(firstDir, "중복 자료.txt");
    const second = join(secondDir, "중복 자료.txt");
    writeFileSync(first, "first");
    writeFileSync(second, "second");

    const refs = [f.attachments.fromPath(f.chatId, first), f.attachments.fromPath(f.chatId, second)];

    assert.notEqual(refs[0].path, refs[1].path);
    assert.deepEqual(readFileSync(refs[0].path, "utf8"), "first");
    assert.deepEqual(readFileSync(refs[1].path, "utf8"), "second");
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE chat_id = ?").get(f.chatId) as { count: number }).count, 2);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fromPath rejects directories before creating a database attachment", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.attachments.fromPath(f.chatId, f.root),
      /폴더는 첨부할 수 없습니다\. 파일을 선택해 주세요\./,
    );
    assert.equal((f.store.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE chat_id = ?").get(f.chatId) as { count: number }).count, 0);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

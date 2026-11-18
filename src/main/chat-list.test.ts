import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { listedChats } from "../shared/chat-list";
import { DEFAULT_SETTINGS, type Chat } from "../shared/types";

function fixture(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-chat-list-"));
  const file = join(dir, "test.db");
  const state = { store: new Store(file) };
  t.after(() => { state.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = state.store.createProject("A", dir, DEFAULT_SETTINGS);
  const other = state.store.createProject("B", dir, DEFAULT_SETTINGS);
  return Object.assign(state, {
    dir, file, project, other,
    reopen() { state.store.close(); state.store = new Store(file); },
    order: () => listedChats(state.store.listChats()).filter(c => c.projectId === project.id).map(c => c.id),
  });
}

test("project order moves in both directions, survives activity, archive and restart", t => {
  const f = fixture(t), s = f.store;
  const a = s.createChat(f.project.id, "A"), b = s.createChat(f.project.id, "B"), c = s.createChat(f.project.id, "C");
  const other = s.createChat(f.other.id, "other");
  assert.deepEqual(f.order(), [c.id, b.id, a.id]);
  s.reorderChat(a.id, c.id, "before");
  assert.deepEqual(f.order(), [a.id, c.id, b.id]);
  s.reorderChat(a.id, b.id, "after");
  assert.deepEqual(f.order(), [c.id, b.id, a.id]);
  s.updateChat(a.id, { touch: true, status: "working" });
  s.updateChat(b.id, { archived: true });
  f.reopen();
  assert.deepEqual(f.order(), [c.id, b.id, a.id]);
  assert.equal(f.store.chat(other.id)!.sidebarOrder, other.sidebarOrder);
  f.store.deleteChat(b.id);
  const next = f.store.createChat(f.project.id, "new");
  assert.deepEqual(f.order(), [next.id, c.id, a.id]);
});

test("cross-project, draft, deleted and invalid drops leave every chat unchanged", t => {
  const f = fixture(t), s = f.store;
  const a = s.createChat(f.project.id, "A"), b = s.createChat(f.other.id, "B"), d = s.createDraftChat(f.project.id);
  const before = s.listChats();
  assert.throws(() => s.reorderChat(a.id, b.id, "before"), /같은 프로젝트/);
  assert.throws(() => s.reorderChat(d.id, a.id, "after"), /등록된 채팅/);
  assert.throws(() => s.reorderChat(a.id, d.id, "after"), /등록된 채팅/);
  assert.throws(() => s.reorderChat(a.id, 99999, "after"), /등록된 채팅/);
  assert.throws(() => s.reorderChat(a.id, a.id, "outside" as "after"), /위치/);
  assert.throws(() => s.reorderChat(String(a.id) as unknown as number, a.id, "after"), /ID/);
  s.reorderChat(a.id, a.id, "before");
  assert.deepEqual(s.listChats(), before);
});

test("old chat activity order migrates once and old empty chats stay visible", t => {
  const f = fixture(t), s = f.store;
  const a = s.createChat(f.project.id, "old A"), b = s.createChat(f.project.id, "old B");
  s.db.prepare("UPDATE chats SET last_active_at = ? WHERE id = ?").run(900, a.id);
  s.db.prepare("UPDATE chats SET last_active_at = ? WHERE id = ?").run(800, b.id);
  s.db.exec("ALTER TABLE chats DROP COLUMN sidebar_order; ALTER TABLE chats DROP COLUMN draft; DELETE FROM settings WHERE key = 'migratedSidebarOrder'");
  f.reopen();
  assert.deepEqual(f.order(), [a.id, b.id]);
  f.store.reorderChat(a.id, b.id, "after");
  f.reopen();
  assert.deepEqual(f.order(), [b.id, a.id]);
});

test("draft stays hidden through settings, attachments and restart; first message publishes at top", t => {
  const f = fixture(t), s = f.store;
  const old = s.createChat(f.project.id, "old"), d = s.createDraftChat(f.project.id);
  assert.equal(s.createDraftChat(f.project.id).id, d.id, "repeated New does not accumulate empty records");
  s.updateChat(d.id, { codexModelOverride: "example-model", title: "draft title" });
  const attachment = s.addAttachment(d.id, "a.png", join(f.dir, "a.png"), "image/png", 1);
  s.addEvent(d.id, "orch", "orch", { type: "notice", text: "settings only" });
  assert.deepEqual(f.order(), [old.id]);
  const newer = s.createChat(f.project.id, "newer");
  f.reopen();
  assert.equal(f.store.createDraftChat(f.project.id).id, d.id);
  const event = f.store.addUserEvent(d.id, { type: "user", text: "", attachments: [attachment] }, [attachment.id]);
  assert.deepEqual(f.order(), [d.id, newer.id, old.id]);
  assert.equal(f.store.chat(d.id)!.codexModelOverride, "example-model");
  assert.equal(f.store.unsentAttachments(d.id).length, 0);
  assert.equal(f.store.events(d.id).some(e => e.id === event.id), true);
  assert.notEqual(f.store.createDraftChat(f.project.id).id, d.id);
  f.reopen();
  assert.deepEqual(f.order(), [d.id, newer.id, old.id]);
});

test("a failed first-message transaction never publishes the draft or links attachments", t => {
  const f = fixture(t), s = f.store;
  const d = s.createDraftChat(f.project.id);
  const a = s.addAttachment(d.id, "a.txt", join(f.dir, "a.txt"), "text/plain", 1);
  s.db.exec("CREATE TRIGGER fail_publish BEFORE UPDATE OF draft ON chats BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END;");
  assert.throws(() => s.addUserEvent(d.id, { type: "user", text: "hello", attachments: [a] }, [a.id]), /fixture write failed/);
  assert.equal(s.hasUserEvent(d.id), false);
  assert.equal(s.chat(d.id)!.draft, true);
  assert.deepEqual(s.unsentAttachments(d.id).map(a => a.id), [a.id]);
});

test("first send broadcasts a titled conversation once, and a model failure keeps the user's message", async t => {
  const f = fixture(t), updated: Chat[] = [];
  const chats = new ChatManager(f.store, { agents() {}, chat(c) { updated.push(c); }, consult() {}, usage() {}, event() {} }, f.dir, "unused");
  try {
    const draft = f.store.createDraftChat(f.project.id);
    await assert.rejects(chats.send(draft.id, "  ", []), /메시지/);
    assert.equal(f.store.chat(draft.id)!.draft, true);
    chats.sendHandler = async () => { throw new Error("synthetic provider failure"); };
    await chats.send(draft.id, "첫 메시지", []);
    assert.equal(updated[0].draft, false);
    assert.equal(updated[0].title, "첫 메시지");
    assert.deepEqual(f.order(), [draft.id]);
    assert.equal(f.store.chat(draft.id)!.status, "error");
    assert.equal(f.store.events(draft.id).filter(e => e.event.type === "user").length, 1);
    const commandDraft = f.store.createDraftChat(f.project.id);
    await chats.startTurn(commandDraft.id, "/plan 작업 계획", [], async () => {});
    assert.equal(f.store.chat(commandDraft.id)!.draft, false, "work-starting commands also publish");
  } finally { await chats.dispose(); }
});

test("forks are visible immediately without waiting for another user message", t => {
  const f = fixture(t), s = f.store;
  const source = s.createChat(f.project.id, "source");
  const event = s.addUserEvent(source.id, { type: "user", text: "history", attachments: [] }, []);
  const fork = s.createForkChat(source, "fork", { sourceChatId: source.id, sourceEventId: event.id, sourceTitle: source.title, range: "through", includeAttachments: false }, () => ({ type: "fork_context", text: "history", attachments: [] }));
  assert.deepEqual(f.order(), [fork.id, source.id]);
  assert.equal(fork.draft, false);
});

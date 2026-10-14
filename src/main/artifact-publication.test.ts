import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { relative, resolve, join } from "node:path";
import { DEFAULT_SETTINGS, type AgentEvent } from "../shared/types";
import { Orchestrator } from "./orchestrator";
import { Store } from "./db";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-artifact-publication-"));
  const dbPath = join(root, "app.sqlite");
  const store = new Store(dbPath);
  const project = store.createProject("artifact publication", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "artifact publication");
  return { root, dbPath, store, chatId: chat.id };
}

function emitToStore(store: Store, emitted: AgentEvent[]) {
  return (_chatId: number, _node: string, _role: string, event: AgentEvent) => {
    emitted.push(event);
    store.addEvent(_chatId, _node as "orch", _role as "orch", event);
  };
}

function artifacts(store: Store, chatId: number) {
  return store.events(chatId).filter((entry) => entry.event.type === "artifacts").map((entry) => entry.event);
}

test("publishes only current existing outputs, deduplicates them, and persists the result across restart", async () => {
  const f = fixture();
  let store: Store | undefined = f.store;
  let engine: any;
  try {
    const previousOutput = join(f.root, "previous output.txt");
    const consultOutput = join(f.root, "결과 폴더", "consult output.txt");
    const changedOutput = join(f.root, "결과 폴더", "changed output.png");
    const movedSource = join(f.root, "결과 폴더", "old result.tmp");
    const movedOutput = join(f.root, "결과 폴더", "moved 결과.txt");
    const imageOutput = join(f.root, "첨부 이미지.png");
    const deletedOutput = join(f.root, "deleted.txt");
    const failedOutput = join(f.root, "failed.txt");
    const missingOutput = join(f.root, "missing.txt");
    const missingImage = join(f.root, "missing-image.png");
    mkdirSync(join(f.root, "결과 폴더"), { recursive: true });
    for (const path of [previousOutput, consultOutput, changedOutput, movedOutput, imageOutput, deletedOutput, failedOutput]) writeFileSync(path, path);

    const previousUser = store.addEvent(f.chatId, "orch", null, { type: "user", text: "previous", attachments: [] });
    const previousInstructionId = previousUser.id;
    const previousChange = relative(f.root, previousOutput);
    store.addEvent(f.chatId, "orch", "orch", {
      type: "file_change",
      id: "previous-change",
      ok: true,
      files: [{ path: previousChange, kind: "add", diff: "" }],
    });
    const currentUser = store.addEvent(f.chatId, "orch", null, { type: "user", text: "current", attachments: [] });
    const currentInstructionId = currentUser.id;

    const previousConsult = store.createConsult(f.chatId, "orch", "w1", "implement", "previous", [], previousInstructionId);
    store.finishConsult(previousConsult.id, "done", "previous complete", [previousChange]);
    const currentConsult = store.createConsult(f.chatId, "orch", "w1", "implement", "current", [], currentInstructionId);
    store.finishConsult(currentConsult.id, "done", "current complete", [relative(f.root, consultOutput), relative(f.root, consultOutput)]);
    const failedConsult = store.createConsult(f.chatId, "orch", "w1", "implement", "failed", [], currentInstructionId);
    store.finishConsult(failedConsult.id, "error", "failed", [relative(f.root, failedOutput)]);

    const changed = relative(f.root, changedOutput);
    const moved = relative(f.root, movedOutput);
    const deleted = relative(f.root, deletedOutput);
    const missing = relative(f.root, missingOutput);
    store.addEvent(f.chatId, "orch", "orch", {
      type: "file_change",
      id: "current-change",
      ok: true,
      files: [
        { path: relative(f.root, consultOutput), kind: "update", diff: "" },
        { path: changed, kind: "add", diff: "" },
        { path: relative(f.root, movedSource), movePath: moved, kind: "update", diff: "" },
        { path: deleted, kind: "delete", diff: "" },
        { path: missing, kind: "add", diff: "" },
      ],
    });
    store.addEvent(f.chatId, "orch", "w1", {
      type: "file_change",
      id: "failed-change",
      ok: false,
      files: [{ path: relative(f.root, failedOutput), kind: "add", diff: "" }],
    });
    store.addEvent(f.chatId, "orch", "w1", {
      type: "image_generation",
      id: "current-image",
      status: "done",
      attachment: { id: 1, name: "첨부 이미지.png", mime: "image/png", size: 1, path: imageOutput },
    });
    store.addEvent(f.chatId, "orch", "w1", {
      type: "image_generation",
      id: "missing-image",
      status: "done",
      attachment: { id: 2, name: "missing-image.png", mime: "image/png", size: 1, path: missingImage },
    });

    const emitted: AgentEvent[] = [];
    const chats: any = { store, emit: emitToStore(store, emitted) };
    engine = new Orchestrator(chats) as any;
    engine.instructions.set(f.chatId, { id: currentInstructionId, text: "current", asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    engine.publishArtifacts(f.chatId);

    assert.equal(emitted.length, 1);
    const first = artifacts(store, f.chatId);
    assert.equal(first.length, 1);
    const published = new Set(first[0].paths);
    assert.deepEqual(published, new Set([consultOutput, changedOutput, movedOutput, imageOutput].map((path) => resolve(path))));
    for (const excluded of [previousOutput, deletedOutput, failedOutput, missingOutput, missingImage]) assert.equal(published.has(resolve(excluded)), false, excluded);

    engine.publishArtifacts(f.chatId);
    assert.equal(artifacts(store, f.chatId).length, 1);
    await engine.judge.dispose();
    store.close();
    store = new Store(f.dbPath);

    const restartedEmitted: AgentEvent[] = [];
    const restarted: any = new Orchestrator({ store, emit: emitToStore(store, restartedEmitted) } as any);
    restarted.instructions.set(f.chatId, { id: currentInstructionId, text: "current", asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] });
    assert.equal(artifacts(store, f.chatId).length, 1);
    restarted.publishArtifacts(f.chatId);
    assert.equal(restartedEmitted.length, 0);
    assert.equal(artifacts(store, f.chatId).length, 1);
    await restarted.judge.dispose();
  } finally {
    await engine?.judge?.dispose?.();
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

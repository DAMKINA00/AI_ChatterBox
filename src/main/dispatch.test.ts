import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionIssue } from "./dispatch";
import { DEFAULT_SETTINGS, type Consult } from "../shared/types";
import { Store } from "./db";

function consult(id: number, patch: Partial<Consult> = {}): Consult {
  return {
    id,
    chatId: 1,
    seq: id,
    fromRole: "orch",
    toRole: "w1",
    scope: [],
    kind: "opinion",
    request: "request",
    responseSummary: "completed",
    filesChanged: [],
    status: "done",
    startedAt: 1,
    endedAt: 2,
    ...patch,
  };
}

test("dispatch completion requires a recorded route and exempts direct work", () => {
  assert.match(completionIssue(1, undefined, [], false) ?? "", /처리 방식이 기록되지 않았습니다/);
  assert.equal(completionIssue(1, "direct", [], true), null);
  assert.match(completionIssue(1, "delegated", [], false) ?? "", /실제로 배정된 작업이 없습니다/);
});

test("only consults for the current instruction can satisfy delegated completion", () => {
  const previous = consult(10, { instructionId: 1 });
  const current = consult(11, { instructionId: 2 });
  assert.match(completionIssue(2, "delegated", [previous], false) ?? "", /실제로 배정된 작업이 없습니다/);
  assert.equal(completionIssue(1, "delegated", [previous, current], false), null);
});

test("running work and missing or empty responses block completion", () => {
  const running = consult(20, { instructionId: 3, status: "running", responseSummary: null, endedAt: null });
  assert.match(completionIssue(3, "delegated", [running], false) ?? "", /아직 응답이 돌아오지 않은 작업/);

  const missing = consult(21, { instructionId: 3, responseSummary: null });
  const empty = consult(22, { instructionId: 3, responseSummary: "  " });
  const failed = consult(23, { instructionId: 3, status: "error", responseSummary: "provider error" });
  const issue = completionIssue(3, "delegated", [missing, empty, failed], false) ?? "";
  for (const id of [21, 22, 23]) assert.match(issue, new RegExp(String(id)));
});

test("a successful superseding consult closes its failed predecessor chain", () => {
  const original = consult(30, { instructionId: 4, status: "error", responseSummary: null });
  const retry = consult(31, { instructionId: 4, status: "stopped", supersedes: 30, responseSummary: null });
  const replacement = consult(32, { instructionId: 4, supersedes: 31, responseSummary: "The work is complete." });
  assert.equal(completionIssue(4, "delegated", [original, retry, replacement], false), null);
});

test("an unrelated completed consult does not mask an unresolved failure", () => {
  const failed = consult(40, { instructionId: 5, status: "error", responseSummary: null });
  const unrelated = consult(41, { instructionId: 5, responseSummary: "A separate task completed." });
  const issue = completionIssue(5, "delegated", [failed, unrelated], false) ?? "";
  assert.match(issue, /미완료 협의 40/);
});

test("code changes require a later review by a different worker in the same instruction", () => {
  const implementation = consult(50, { instructionId: 6, seq: 1, kind: "implement", toRole: "w1", filesChanged: ["src/parser.ts"] });
  const sameWorker = consult(51, { instructionId: 6, seq: 2, kind: "review", toRole: "w1" });
  const otherInstruction = consult(52, { instructionId: 7, seq: 3, kind: "review", toRole: "w2" });
  const otherWorker = consult(53, { instructionId: 6, seq: 3, kind: "review", toRole: "w2" });

  assert.match(completionIssue(6, "delegated", [implementation, sameWorker], true) ?? "", /교차 리뷰 결과가 필요/);
  assert.match(completionIssue(6, "delegated", [implementation, otherInstruction], true) ?? "", /교차 리뷰 결과가 필요/);
  assert.equal(completionIssue(6, "delegated", [implementation, otherWorker], true), null);
});

test("instruction, reason, and supersedes metadata migrate and survive database reload", () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-dispatch-"));
  const file = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE consults (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      request TEXT NOT NULL,
      response_summary TEXT,
      files_changed_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  legacy.close();

  let store: Store | undefined;
  try {
    store = new Store(file);
    const project = store.createProject("test", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "test");
    const failed = store.createConsult(chat.id, "orch", "w1", "implement", "first", ["src/**"], 7, "initial assignment");
    store.finishConsult(failed.id, "error", "worker failed", []);
    const replacement = store.createConsult(chat.id, "orch", "w2", "implement", "retry", ["src/**"], 7, "replacement assignment", failed.id);
    store.finishConsult(replacement.id, "done", "work completed", ["src/parser.ts"]);
    store.close();
    store = undefined;

    store = new Store(file);
    const consults = store.listConsults(chat.id);
    assert.deepEqual(
      consults.map((c) => [c.instructionId, c.reason, c.supersedes]),
      [
        [7, "initial assignment", undefined],
        [7, "replacement assignment", failed.id],
      ],
    );
    assert.deepEqual(consults.map((c) => c.filesChanged), [[], ["src/parser.ts"]]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

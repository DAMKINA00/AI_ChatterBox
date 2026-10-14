import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionIssue, dualInvestigationIssue } from "./dispatch";
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

test("critical investigations require actual independent reports from both families for this instruction", () => {
  const agents = [{ key: "w1", kind: "claude" }, { key: "w2", kind: "gpt" }, { key: "w3", kind: "claude" }] as const;
  const team = [...agents];
  const first = consult(1, { instructionId: 8, toRole: "w1" });
  const second = consult(2, { instructionId: 8, toRole: "w2" });
  assert.match(dualInvestigationIssue(8, [], team)!, /클로드·지피티/);
  assert.match(dualInvestigationIssue(8, [first, { ...second, toRole: "w3" }], team)!, /지피티/);
  for (const patch of [
    { instructionId: 7 }, { status: "running" }, { status: "error" }, { responseSummary: " " },
    { kind: "implement" }, { kind: "review" }, { fromRole: "w1" }, { toRole: "w99" },
  ] as Partial<Consult>[]) assert.match(dualInvestigationIssue(8, [first, { ...second, ...patch }], team)!, /지피티/);
  assert.equal(dualInvestigationIssue(8, [first, second], team), null);
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

test("untouched worker preferences adopt Claude-first defaults while custom preferences survive reload", () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-preferences-"));
  const file = join(root, "db.sqlite");
  let store: Store | undefined;
  try {
    store = new Store(file);
    const project = store.createProject("test", root, {
      ...DEFAULT_SETTINGS,
      claudeStrengths: "소스 구조·동작 흐름 분석, 원인 조사. 구현·테스트·문서 작성은 맥락에 따라 배정.",
      gptStrengths: "이미지 생성·편집, 시각 자료 제작. 구현·테스트·문서 작성은 맥락에 따라 배정.",
      gptCautions: "프로젝트 사용자 지정 기준",
    });
    store.close();
    store = new Store(file);
    const settings = store.project(project.id)!.settings;
    assert.equal(settings.claudeStrengths, DEFAULT_SETTINGS.claudeStrengths);
    assert.equal(settings.gptStrengths, DEFAULT_SETTINGS.gptStrengths);
    assert.equal(settings.gptCautions, "프로젝트 사용자 지정 기준");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("old Gemini helper defaults migrate to prose-only while custom prose preferences remain", () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-prose-"));
  const file = join(root, "db.sqlite");
  let store = new Store(file);
  try {
    const old = store.createProject("old", root, {
      ...DEFAULT_SETTINGS,
      claudeStrengths: "일반 업무의 기본 담당. 소스 분석·원인 조사·구현·테스트·문서 작성과 모션그래픽·애니메이션 제작을 우선 배정합니다.",
      geminiStrengths: "사용자 지정 제미나이 작업, 문서 요약·자료 비교와 추가 관점의 검토. 클로드가 바쁘거나 사용 한도에 도달했을 때 보조 담당.",
      geminiCautions: "Google AI Pro 계정에서 실제 제공되는 Gemini 모델만 사용합니다. Ultra 전용 모델·API 결제로 전환하지 않습니다. 일반 업무는 클로드 우선, 이미지 생성은 지피티, 중요한 오류는 기존 클로드·지피티 양쪽 조사 규칙을 유지합니다.",
    });
    const custom = store.createProject("custom", root, { ...DEFAULT_SETTINGS, geminiStrengths: "차분한 박사 말투의 대사", geminiCautions: "설정한 세계관을 유지" });
    store.close(); store = new Store(file);
    const migrated = store.project(old.id)!.settings;
    assert.equal(migrated.claudeStrengths, DEFAULT_SETTINGS.claudeStrengths);
    assert.equal(migrated.geminiStrengths, DEFAULT_SETTINGS.geminiStrengths);
    assert.equal(migrated.geminiCautions, DEFAULT_SETTINGS.geminiCautions);
    assert.equal(store.project(custom.id)!.settings.geminiStrengths, "차분한 박사 말투의 대사");
    assert.equal(store.project(custom.id)!.settings.geminiCautions, "설정한 세계관을 유지");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("released workers reuse their identity and session in number order without replacing history", () => {
  const root = mkdtempSync(join(tmpdir(), "aichatterbox-reuse-"));
  const file = join(root, "db.sqlite");
  let store = new Store(file);
  try {
    const project = store.createProject("test", root, DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "test");
    const first = store.createAgent(chat.id, "claude", "first job");
    const second = store.createAgent(chat.id, "claude", "second job");
    const gpt = store.createAgent(chat.id, "gpt", "image");
    store.updateAgent(second.id, { status: "released" });
    store.updateAgent(first.id, { status: "released", sessionId: "existing-claude-session" });
    store.updateAgent(gpt.id, { status: "released" });
    store.addEvent(chat.id, first.key, first.key, { type: "text", text: "first worker history" });
    store.close();
    store = new Store(file);
    const reused = store.createAgent(chat.id, "claude", "new job");
    assert.equal(reused.id, first.id);
    assert.equal(reused.key, first.key);
    assert.equal(reused.number, 1);
    assert.equal(reused.sessionId, "existing-claude-session");
    assert.equal(reused.status, "active");
    assert.equal(reused.job, "new job");
    assert.equal(store.createAgent(chat.id, "claude", "parallel job").id, second.id);
    assert.equal(store.createAgent(chat.id, "claude", "extra concurrent job").number, 3);
    assert.equal(store.createAgent(chat.id, "gpt", "new image").id, gpt.id);
    assert.equal(store.events(chat.id)[0].role, first.key);
    const otherChat = store.createChat(project.id, "other");
    assert.notEqual(store.createAgent(otherChat.id, "claude", "separate").id, first.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

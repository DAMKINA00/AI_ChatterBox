import assert from "node:assert/strict";
import { test } from "node:test";
import { type Consult } from "../shared/types";
import { consultResultText, consultStatusText, masterResultText } from "./consult-context";

test("review excerpts retain adverse verdicts, high findings and failed/unrun test counts", () => {
  const c: Consult = { id: 1, chatId: 1, seq: 1, fromRole: "orch", toRole: "w1", kind: "review", scope: [], request: "review", responseSummary: "log ".repeat(800), filesChanged: [], status: "done", startedAt: 1, endedAt: 2,
    review: { verdict: "changes_requested", revision: "abc", summary: "Must fix unsafe recovery", findings: [{ severity: "high", message: "unsafe recovery" }], tests: [{ name: "recovery", status: "failed" }, { name: "live", status: "not_run" }] } };
  const before = JSON.stringify(c);
  const text = consultResultText(c);
  for (const required of ["changes_requested", "high 1", "테스트 실패 1건", "미실행 1건", "Must fix unsafe recovery", "detail=true"]) assert.ok(text.includes(required), required);
  assert.equal(JSON.stringify(c), before);
  assert.match(consultResultText({ ...c, review: undefined }), /통과로 간주하지 마세요/);
  assert.match(consultResultText({ ...c, status: "error" }), /상태=error/);
  assert.match(consultResultText({ ...c, status: "stopped" }), /상태=stopped/);
});

test("master receipts contain no report text and the final decision brief stays small", () => {
  const c: Consult = { id: 2, chatId: 1, seq: 2, fromRole: "orch", toRole: "w1", kind: "opinion", scope: [], request: "[작업자 결과 취합]", responseSummary: "[CLI 지정 계정=claude-1 · 실제 실행 계정=claude-1]\nRESULT\n" + "verbose evidence\n".repeat(1000) + "BLOCKER: needs decision", filesChanged: ["output/report.pdf"], status: "done", startedAt: 1, endedAt: 2 };
  const receipt = consultStatusText(c);
  assert.ok(receipt.length < 100);
  assert.doesNotMatch(receipt, /RESULT|verbose evidence|BLOCKER/);
  assert.match(receipt, /취합/);
  const brief = masterResultText(c);
  assert.ok(brief.length < 550);
  assert.doesNotMatch(brief, /지정 계정/);
  assert.match(brief, /RESULT/);
  assert.match(brief, /BLOCKER: needs decision/);
  assert.match(brief, /output\/report.pdf/);
});

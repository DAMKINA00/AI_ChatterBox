import test from "node:test";
import assert from "node:assert/strict";
import { validateReviewResult } from "./review-result";

const valid = { verdict: "changes_requested", revision: " abc123 ", summary: " 수정 필요 ", findings: [{ severity: "high", message: "버그", path: "src/a.ts", line: 3 }, { severity: "low", message: "표기" }], tests: [{ name: "unit", status: "failed", detail: "1 fail" }, { name: "ui", status: "not_run" }] };

test("a complete report is normalized", () => {
  const r = validateReviewResult(valid);
  assert.equal(r.revision, "abc123");
  assert.equal(r.summary, "수정 필요");
  assert.deepEqual(r.findings[1], { severity: "low", message: "표기" });
  assert.deepEqual(r.tests[1], { name: "ui", status: "not_run" });
});

test("unknown input fields are not stored", () => {
  const r = validateReviewResult({ ...valid, consultId: 99, findings: [{ severity: "low", message: "x", patch: "rm -rf" }], tests: [] }) as any;
  assert.equal(r.consultId, undefined);
  assert.equal(r.findings[0].patch, undefined);
});

test("a malformed report is rejected, never stored as a partial verdict", () => {
  for (const bad of [
    null, {}, { ...valid, verdict: "ok" }, { ...valid, revision: " " }, { ...valid, summary: "" }, { ...valid, findings: "none" }, { ...valid, tests: undefined },
    { ...valid, findings: [{ severity: "critical", message: "x" }] }, { ...valid, findings: [{ severity: "low" }] }, { ...valid, findings: [{ severity: "low", message: "x", line: 0 }] },
    { ...valid, tests: [{ name: "x", status: "skipped" }] }, { ...valid, tests: [{ status: "passed" }] },
    { ...valid, findings: Array.from({ length: 101 }, () => ({ severity: "low", message: "x" })) },
  ]) assert.throws(() => validateReviewResult(bad));
});

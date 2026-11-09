import type { ReviewResult } from "./types";

const VERDICTS: ReviewResult["verdict"][] = ["pass", "changes_requested", "inconclusive"];
const SEVERITIES: ReviewResult["findings"][number]["severity"][] = ["high", "medium", "low"];
const TEST_STATUSES: ReviewResult["tests"][number]["status"][] = ["passed", "failed", "not_run"];
const MAX_ITEMS = 100;
const MAX_TEXT = 4000;
const MAX_LABEL = 500;

/** Strict: a malformed report must fail back to its author rather than be stored as a partial verdict. */
export function validateReviewResult(raw: unknown): ReviewResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!VERDICTS.includes(r.verdict as ReviewResult["verdict"])) throw new Error("verdict는 pass, changes_requested, inconclusive 중 하나여야 합니다.");
  const revision = required(r.revision, "revision", MAX_LABEL);
  const summary = required(r.summary, "summary", MAX_TEXT);
  if (!Array.isArray(r.findings) || r.findings.length > MAX_ITEMS) throw new Error(`findings는 최대 ${MAX_ITEMS}개의 배열이어야 합니다.`);
  if (!Array.isArray(r.tests) || r.tests.length > MAX_ITEMS) throw new Error(`tests는 최대 ${MAX_ITEMS}개의 배열이어야 합니다.`);
  const findings = r.findings.map((item, i): ReviewResult["findings"][number] => {
    const f = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (!SEVERITIES.includes(f.severity as ReviewResult["findings"][number]["severity"])) throw new Error(`findings[${i}].severity는 high, medium, low 중 하나여야 합니다.`);
    const path = optional(f.path, `findings[${i}].path`, MAX_LABEL);
    if (f.line !== undefined && f.line !== null && (!Number.isSafeInteger(f.line) || (f.line as number) < 1)) throw new Error(`findings[${i}].line은 1 이상의 정수여야 합니다.`);
    return { severity: f.severity as ReviewResult["findings"][number]["severity"], message: required(f.message, `findings[${i}].message`, MAX_TEXT), ...(path ? { path } : {}), ...(typeof f.line === "number" ? { line: f.line } : {}) };
  });
  const tests = r.tests.map((item, i): ReviewResult["tests"][number] => {
    const t = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (!TEST_STATUSES.includes(t.status as ReviewResult["tests"][number]["status"])) throw new Error(`tests[${i}].status는 passed, failed, not_run 중 하나여야 합니다.`);
    const detail = optional(t.detail, `tests[${i}].detail`, MAX_TEXT);
    return { name: required(t.name, `tests[${i}].name`, MAX_LABEL), status: t.status as ReviewResult["tests"][number]["status"], ...(detail ? { detail } : {}) };
  });
  return { verdict: r.verdict as ReviewResult["verdict"], revision, summary, findings, tests };
}

function required(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}을(를) 입력하세요.`);
  if (value.length > max) throw new Error(`${field}은(는) ${max}자 이하여야 합니다.`);
  return value.trim();
}

function optional(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return value === "" ? undefined : required(value, field, max);
}

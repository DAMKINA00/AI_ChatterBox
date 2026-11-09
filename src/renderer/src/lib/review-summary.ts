// Structured review results (report_review) for consult cards and the team total. Pure: shared by desktop and remote UI.
import type { Consult, ReviewResult, TimelineEvent } from "../../../shared/types";

export const VERDICT_LABEL: Record<ReviewResult["verdict"], string> = { pass: "통과", changes_requested: "수정 요청", inconclusive: "판단 보류" };
export const SEVERITY_LABEL: Record<ReviewResult["findings"][number]["severity"], string> = { high: "높음", medium: "중간", low: "낮음" };
export const TEST_STATUS_LABEL: Record<ReviewResult["tests"][number]["status"], string> = { passed: "통과", failed: "실패", not_run: "미실행" };
export const NO_STRUCTURED_REVIEW = "구조화 결과 없음";

/** Latest review_result per consult in the event history (a later report replaces an earlier one). */
export function reviewsFromEvents(events: readonly TimelineEvent[] | undefined): Map<number, ReviewResult> {
  const reviews = new Map<number, ReviewResult>();
  for (const e of events ?? []) if (e.event.type === "review_result") reviews.set(e.event.consultId, e.event.review);
  return reviews;
}

/**
 * The latest review_result event wins: events are append-only and arrive in order, while a held consult
 * record may be older than a re-submitted report. The record covers histories without the event.
 */
export const reviewOf = (consultId: number, consult: Consult | undefined, fromEvents: ReadonlyMap<number, ReviewResult>) =>
  fromEvents.get(consultId) ?? consult?.review;

/**
 * Run state a consult card shows everywhere (header, icon, data-status, progress, review block): the record
 * once loaded, because the timeline's copy can be stale — e.g. a restart marks a running consult stopped
 * without writing consult_end, so the timeline item would still say running.
 */
export const consultCardStatus = (item: { status: Consult["status"] }, consult: Consult | undefined): Consult["status"] =>
  consult?.status ?? item.status;

/**
 * What a review card shows, desktop and remote alike: the report folded from events (latest first), else
 * the record; the run state is the same one the card header uses.
 */
export function consultCardReview(item: { review?: ReviewResult; status: Consult["status"] }, consult: Consult | undefined): { review?: ReviewResult; status: Consult["status"] } {
  return { review: item.review ?? consult?.review, status: consultCardStatus(item, consult) };
}

/** Run outcome and verdict are separate: a pass reported before an error/stop is not a finished pass. */
export function reviewRunNote(status: Consult["status"]): string | null {
  if (status === "running") return "리뷰 진행 중 · 판정은 아직 확정되지 않았습니다";
  if (status === "error") return "리뷰 실행 오류 · 판정은 최종 결과로 집계하지 않습니다";
  if (status === "stopped") return "리뷰 실행 중지 · 판정은 최종 결과로 집계하지 않습니다";
  if (status === "limited") return "리뷰 실행 한도 도달 · 판정은 최종 결과로 집계하지 않습니다";
  return null;
}

export interface ReviewTotals {
  /** Review consults in the chat. */
  total: number;
  pass: number;
  changesRequested: number;
  inconclusive: number;
  /** Finished without a structured report — never counted as a pass. */
  missing: number;
  /** Still running (with or without a report so far). */
  running: number;
  /** Ended in error/stop/limit — not counted under any verdict even if a report was submitted. */
  incomplete: number;
  findings: { high: number; medium: number; low: number };
  tests: { passed: number; failed: number; notRun: number };
}

/** Verdict/finding/test counts come only from reviews that finished (status done). */
export function summarizeReviews(consults: readonly Consult[] | undefined, fromEvents: ReadonlyMap<number, ReviewResult> = new Map()): ReviewTotals {
  const totals: ReviewTotals = { total: 0, pass: 0, changesRequested: 0, inconclusive: 0, missing: 0, running: 0, incomplete: 0, findings: { high: 0, medium: 0, low: 0 }, tests: { passed: 0, failed: 0, notRun: 0 } };
  for (const consult of consults ?? []) {
    if (consult.kind !== "review") continue;
    totals.total++;
    if (consult.status === "running") { totals.running++; continue; }
    if (consult.status !== "done") { totals.incomplete++; continue; }
    const review = reviewOf(consult.id, consult, fromEvents);
    if (!review) { totals.missing++; continue; }
    if (review.verdict === "pass") totals.pass++;
    else if (review.verdict === "changes_requested") totals.changesRequested++;
    else totals.inconclusive++;
    for (const f of review.findings) if (f.severity in totals.findings) totals.findings[f.severity]++;
    for (const t of review.tests) {
      if (t.status === "passed") totals.tests.passed++;
      else if (t.status === "failed") totals.tests.failed++;
      else totals.tests.notRun++;
    }
  }
  return totals;
}

/** One line for the team total, e.g. "리뷰 3건 · 통과 1 · 수정 요청 1 · 구조화 결과 없음 1". */
export function reviewTotalsText(t: ReviewTotals): string {
  const parts = [`리뷰 ${t.total}건`];
  if (t.pass) parts.push(`통과 ${t.pass}`);
  if (t.changesRequested) parts.push(`수정 요청 ${t.changesRequested}`);
  if (t.inconclusive) parts.push(`판단 보류 ${t.inconclusive}`);
  if (t.running) parts.push(`진행 중 ${t.running}`);
  if (t.incomplete) parts.push(`실행 미완료 ${t.incomplete}`);
  if (t.missing) parts.push(`${NO_STRUCTURED_REVIEW} ${t.missing}`);
  return parts.join(" · ");
}

/** "file.ts:12" style location of a finding. */
export const findingLocation = (f: ReviewResult["findings"][number]) => (f.path ? (f.line ? `${f.path}:${f.line}` : f.path) : "");

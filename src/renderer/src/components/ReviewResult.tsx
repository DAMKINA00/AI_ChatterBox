import { useMemo } from "react";
import { ClipboardCheck } from "lucide-react";
import type { Consult, ReviewResult } from "../../../shared/types";
import { cn } from "../lib/utils";
import { findingLocation, NO_STRUCTURED_REVIEW, reviewCountsText, reviewDigest, reviewRunNote, reviewsFromEvents, reviewTotalsText, SEVERITY_LABEL, summarizeReviews, TEST_STATUS_LABEL, VERDICT_LABEL } from "../lib/review-summary";
import { useStore } from "../store";
import { Badge } from "./ui";

const VERDICT_TONE: Record<ReviewResult["verdict"], string> = {
  pass: "border-success/40 text-success",
  changes_requested: "border-destructive/40 text-destructive",
  inconclusive: "border-warning/50 text-warning",
};
const SEVERITY_TONE = { high: "border-destructive/40 text-destructive", medium: "border-warning/50 text-warning", low: "text-muted-foreground" } as const;
const TEST_TONE = { passed: "text-success", failed: "text-destructive", not_run: "text-muted-foreground" } as const;

/**
 * Structured review inside a review consult card; the free-text summary stays shown separately.
 * compact (main chat view): verdict, counts and only high findings / failed tests in one line each.
 */
export function ReviewResultView({ review, status, compact = false }: { review?: ReviewResult; status: Consult["status"]; compact?: boolean }) {
  const note = reviewRunNote(status);
  if (!review) {
    return (
      <div className="border-t px-3 py-1.5 text-[11.5px] text-muted-foreground" data-testid="consult-review" data-verdict="none" data-run={status}>
        리뷰 판정 · {status === "running" ? "보고 대기" : `${NO_STRUCTURED_REVIEW} (통과로 간주하지 않음)`}
      </div>
    );
  }
  const header = (
    <>
      {note && <div className={cn("text-[11.5px]", status === "running" ? "text-muted-foreground" : "text-warning")} data-testid="review-run-note">{note}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">리뷰 판정</span>
        <Badge className={VERDICT_TONE[review.verdict]} data-testid="review-verdict">{VERDICT_LABEL[review.verdict]}</Badge>
        {review.revision && <span className="font-mono text-[11px] text-muted-foreground" title="리뷰 대상 기준">기준 <span data-chat-search-text>{review.revision}</span></span>}
      </div>
    </>
  );
  if (compact) {
    const digest = reviewDigest(review);
    return (
      <div className="space-y-1 border-t px-3 py-2 text-[12px]" data-testid="consult-review" data-verdict={review.verdict} data-run={status} data-compact="true">
        {header}
        <div className="text-[11.5px] text-muted-foreground" data-testid="review-counts">{reviewCountsText(digest)}</div>
        {(digest.high.length > 0 || digest.failed.length > 0) && (
          <ul className="space-y-0.5 text-[11.5px]" aria-label="조치가 필요한 항목" data-testid="review-digest">
            {digest.high.map((f, i) => (
              <li key={`f${i}`} className="truncate text-destructive" title={f.message}>
                높음 · {f.location && <span className="font-mono">{f.location} </span>}<span data-chat-search-text>{f.message}</span>
              </li>
            ))}
            {digest.failed.map((name, i) => (
              <li key={`t${i}`} className="truncate text-destructive" title={name}>테스트 실패 · <span className="font-mono" data-chat-search-text>{name}</span></li>
            ))}
            {digest.more > 0 && <li className="text-muted-foreground">외 {digest.more}건은 결과 보고에서 확인</li>}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 border-t px-3 py-2 text-[12px]" data-testid="consult-review" data-verdict={review.verdict} data-run={status}>
      {header}
      {review.summary && <div className="select-text" data-chat-search-text>{review.summary}</div>}
      {review.findings.length > 0 && (
        <ul className="space-y-1" aria-label="지적 사항" data-testid="review-findings">
          {review.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-1.5" data-severity={f.severity}>
              <Badge className={cn("h-5 shrink-0 px-1.5 text-[10.5px]", SEVERITY_TONE[f.severity])}>{SEVERITY_LABEL[f.severity]}</Badge>
              <span className="min-w-0 break-words select-text">
                {findingLocation(f) && <span className="mr-1 font-mono text-[11px] text-muted-foreground" data-chat-search-text>{findingLocation(f)}</span>}
                <span data-chat-search-text>{f.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {review.tests.length > 0 && (
        <ul className="space-y-0.5" aria-label="테스트" data-testid="review-tests">
          {review.tests.map((t, i) => (
            <li key={i} className="flex items-start gap-1.5" data-status={t.status}>
              <span className={cn("shrink-0 font-medium", TEST_TONE[t.status])}>{TEST_STATUS_LABEL[t.status]}</span>
              <span className="min-w-0 break-words select-text"><span className="font-mono" data-chat-search-text>{t.name}</span>{t.detail && <span className="text-muted-foreground"> · <span data-chat-search-text>{t.detail}</span></span>}</span>
            </li>
          ))}
        </ul>
      )}
      {!review.findings.length && !review.tests.length && <div className="text-[11.5px] text-muted-foreground">지적 사항·테스트 기록 없음</div>}
    </div>
  );
}

/** Team total of review consults in this chat (structured reports only; missing reports listed apart). */
export function ReviewTotalsBar({ chatId }: { chatId: number }) {
  const consults = useStore((s) => s.consults[chatId]);
  const events = useStore((s) => s.events[chatId]);
  const fromEvents = useMemo(() => reviewsFromEvents(events), [events]);
  const totals = useMemo(() => summarizeReviews(consults, fromEvents), [consults, fromEvents]);
  if (!totals.total) return null;
  const { findings, tests } = totals;
  return (
    <div className="mx-auto mt-3 flex w-[min(860px,calc(100%-32px))] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-3.5 py-2 text-[12px]" data-testid="review-totals"
      data-pass={totals.pass} data-changes={totals.changesRequested} data-missing={totals.missing}>
      <ClipboardCheck className="size-4 shrink-0 text-orch" />
      <span className="font-medium">{reviewTotalsText(totals)}</span>
      {(findings.high || findings.medium || findings.low) > 0 && (
        <span className="text-muted-foreground">지적 <span className="text-destructive">높음 {findings.high}</span> · <span className="text-warning">중간 {findings.medium}</span> · 낮음 {findings.low}</span>
      )}
      {(tests.passed || tests.failed || tests.notRun) > 0 && (
        <span className="text-muted-foreground">테스트 통과 {tests.passed} · <span className={cn(tests.failed && "text-destructive")}>실패 {tests.failed}</span> · 미실행 {tests.notRun}</span>
      )}
    </div>
  );
}

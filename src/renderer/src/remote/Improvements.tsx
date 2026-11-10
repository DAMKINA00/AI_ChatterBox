// Remote web counterparts of the desktop fork / structured review / run statistics / checklist views.
// Same pure helpers as the desktop (lib/fork, lib/review-summary, lib/run-stats-view, lib/plan-view).
import { useEffect, useMemo, useState } from "react";
import { Ban, Circle, CircleCheck, CircleDot, LoaderCircle, Split } from "lucide-react";
import type { RemoteChatResponse } from "../../../shared/remote-web";
import type { RunStats } from "../../../shared/run-stats";
import type { Chat, ChatAgent, ChatForkOptions, Consult, ConsultStatus, ReviewResult, TimelineEvent } from "../../../shared/types";
import { FORK_NOT_COPIED, FORK_NOTE, FORK_RANGE_LABEL, forkOriginText, forkPreview } from "../lib/fork";
import { consultCardIds, openPlanSteps, PLAN_STATE_LABEL, planBlockerName, planConsultLinks, planCounts, planCountsText, planEndedEarly, planStepName, planStepViews } from "../lib/plan-view";
import type { PlanHistoryEntry } from "../lib/plan-history";
import { findingLocation, NO_STRUCTURED_REVIEW, reviewRunNote, reviewsFromEvents, reviewTotalsText, SEVERITY_LABEL, summarizeReviews, TEST_STATUS_LABEL, VERDICT_LABEL } from "../lib/review-summary";
import { formatDuration, PENDING_TOOL_LABEL, RUN_STATS_NOTE, runStatsFlags, runStatsRows, type RunStatsRow } from "../lib/run-stats-view";
import { cn } from "../lib/utils";
import { normalizePlanStepTitle, type Item, type planOf } from "../timeline";
import { AuthError, request, url } from "./api";
import { Btn, Card, errorText, Md, Modal } from "./ui";

const CONSULT_STATUS_LABEL: Record<ConsultStatus, string> = { running: "진행 중", done: "완료", error: "오류", stopped: "중지", limited: "한도 도달" };

// ---------- fork

export function ForkAction({ chat, eventId, preview, onForked, onError }: { chat: Chat; eventId: number; preview: string; onForked: (chat: Chat) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="이 메시지에서 대화 분기" title="이 메시지에서 대화 분기"
        className="inline-flex min-h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none">
        <Split className="size-3.5" /> 분기
      </button>
      {open && <ForkModal chat={chat} eventId={eventId} preview={preview} onClose={() => setOpen(false)} onForked={c => { setOpen(false); onForked(c); }} onError={onError} />}
    </>
  );
}

function ForkModal({ chat, eventId, preview, onClose, onForked, onError }: { chat: Chat; eventId: number; preview: string; onClose: () => void; onForked: (chat: Chat) => void; onError: (e: unknown) => void }) {
  const [range, setRange] = useState<ChatForkOptions["range"]>("through");
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      const body: ChatForkOptions = { eventId, range, includeAttachments };
      const r = await request<RemoteChatResponse>(url("/api/chats/:id/fork", chat.id), body);
      onForked(r.chat);
    } catch (e) {
      if (e instanceof AuthError) onError(e);
      else setError(errorText(e));
    } finally { setPending(false); }
  };
  return (
    <Modal title="대화 분기" onClose={() => { if (!pending) onClose(); }}>
      <div className="grid gap-3 text-[13.5px]">
        <p className="font-medium">{FORK_NOTE}</p>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-[12.5px]">
          <div className="text-[11px] text-muted-foreground">기준 메시지 #{eventId}</div>
          <div className="line-clamp-3 break-words whitespace-pre-wrap">{preview || "(첨부만 있는 메시지)"}</div>
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 font-medium">가져올 범위</legend>
          {(["through", "from"] as const).map(value => (
            <label key={value} className="flex min-h-9 items-center gap-2"><input type="radio" name="remote-fork-range" checked={range === value} onChange={() => setRange(value)} /> {FORK_RANGE_LABEL[value]}</label>
          ))}
        </fieldset>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={includeAttachments} onChange={e => setIncludeAttachments(e.target.checked)} />
          <span>첨부 파일 포함<span className="block text-[12px] text-muted-foreground">포함하면 새 채팅에 독립 사본으로 복사합니다. 제외하면 첨부 내용은 새 대화에 전달되지 않습니다.</span></span>
        </label>
        <p className="text-[12px] text-muted-foreground">{FORK_NOT_COPIED}</p>
        {error && <div role="alert" className="text-[12.5px] text-destructive">{error}</div>}
        <div className="flex justify-end gap-2">
          <Btn variant="outline" disabled={pending} onClick={onClose}>취소</Btn>
          <Btn disabled={pending} onClick={() => void submit()}>{pending ? <LoaderCircle className="animate-spin" /> : <Split />} 새 채팅으로 분기</Btn>
        </div>
      </div>
    </Modal>
  );
}

export function ForkOriginBar({ chat, exists, onOpen }: { chat: Chat; exists: boolean; onOpen: (id: number) => void }) {
  if (!chat.fork) return null;
  const fork = chat.fork;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-dashed px-3 py-2 text-[12.5px] md:px-6">
      <Split className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words">{forkOriginText(fork)} · 작업 폴더는 원본과 공유</span>
      {exists ? <Btn variant="ghost" onClick={() => onOpen(fork.sourceChatId)}>원본 열기</Btn> : <span className="text-[12px] text-muted-foreground">원본 없음(삭제됨)</span>}
    </div>
  );
}

export function ForkContext({ item }: { item: Extract<Item, { kind: "fork" }> }) {
  return (
    <details className="rounded-lg border border-dashed bg-card px-3 py-2 text-[12.5px]">
      <summary className="cursor-pointer"><span className="font-medium">분기 원문</span> <span className="text-muted-foreground">· 읽기 전용{item.attachments.length ? ` · 첨부 ${item.attachments.length}개` : ""} · {forkPreview(item.text, 80)}</span></summary>
      <div className="mt-2 max-h-[60dvh] overflow-y-auto"><Md text={item.text} /></div>
      {item.attachments.length > 0 && <ul className="mt-1.5 text-[12px] text-muted-foreground">{item.attachments.map(a => <li key={a.id} className="break-all">첨부 · {a.name}</li>)}</ul>}
    </details>
  );
}

// ---------- structured review

export function ReviewBlock({ review, status }: { review?: ReviewResult; status: ConsultStatus }) {
  const note = reviewRunNote(status);
  if (!review) return <div className="mt-2 border-t pt-2 text-[12px] text-muted-foreground">리뷰 판정 · {status === "running" ? "보고 대기" : `${NO_STRUCTURED_REVIEW} (통과로 간주하지 않음)`}</div>;
  return (
    <div className="mt-2 grid gap-1.5 border-t pt-2 text-[12.5px]">
      {note && <div className={cn("text-[12px]", status === "running" ? "text-muted-foreground" : "text-warning")}>{note}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">리뷰 판정</span>
        <span className={cn("rounded border px-1.5 text-[11.5px] font-medium", review.verdict === "pass" ? "border-success/50 text-success" : review.verdict === "changes_requested" ? "border-destructive/50 text-destructive" : "border-warning/60 text-warning")}>{VERDICT_LABEL[review.verdict]}</span>
        {review.revision && <span className="font-mono text-[11.5px] text-muted-foreground">기준 {review.revision}</span>}
      </div>
      {review.summary && <div className="break-words">{review.summary}</div>}
      {review.findings.length > 0 && <ul className="grid gap-1" aria-label="지적 사항">
        {review.findings.map((f, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className={cn("shrink-0 rounded border px-1 text-[11px]", f.severity === "high" ? "border-destructive/50 text-destructive" : f.severity === "medium" ? "border-warning/60 text-warning" : "text-muted-foreground")}>{SEVERITY_LABEL[f.severity]}</span>
            <span className="min-w-0 break-words">{findingLocation(f) && <span className="mr-1 font-mono text-[11.5px] text-muted-foreground">{findingLocation(f)}</span>}{f.message}</span>
          </li>
        ))}
      </ul>}
      {review.tests.length > 0 && <ul className="grid gap-0.5" aria-label="테스트">
        {review.tests.map((t, i) => (
          <li key={i} className="break-words"><span className={cn("font-medium", t.status === "passed" ? "text-success" : t.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{TEST_STATUS_LABEL[t.status]}</span> <span className="font-mono">{t.name}</span>{t.detail && <span className="text-muted-foreground"> · {t.detail}</span>}</li>
        ))}
      </ul>}
    </div>
  );
}

export function ReviewTotalsLine({ consults, events }: { consults: Consult[]; events: TimelineEvent[] }) {
  const fromEvents = useMemo(() => reviewsFromEvents(events), [events]);
  const totals = useMemo(() => summarizeReviews(consults, fromEvents), [consults, fromEvents]);
  if (!totals.total) return null;
  const { findings, tests } = totals;
  return (
    <div className="text-[12.5px]">
      <span className="font-medium">{reviewTotalsText(totals)}</span>
      {findings.high + findings.medium + findings.low > 0 && <span className="text-muted-foreground"> · 지적 높음 {findings.high} · 중간 {findings.medium} · 낮음 {findings.low}</span>}
      {tests.passed + tests.failed + tests.notRun > 0 && <span className="text-muted-foreground"> · 테스트 통과 {tests.passed} · 실패 {tests.failed} · 미실행 {tests.notRun}</span>}
    </div>
  );
}

// ---------- checklist

export const consultCardDomId = (consultId: number) => `consult-card-${consultId}`;

/** Moves to a consult card on this page, opening any collapsed section it sits in. */
function revealConsultCard(consultId: number) {
  const card = document.getElementById(consultCardDomId(consultId));
  if (!card) return;
  for (let parent = card.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  card.scrollIntoView({ block: "center" });
  card.focus({ preventScroll: true });
}

/** Summary line content: plan state, counts (취소 never counted as 완료) and, for an ended plan, its reason. */
export function PlanSummary({ plan }: { plan: NonNullable<ReturnType<typeof planOf>> }) {
  const counts = planCounts(plan.steps);
  const ended = planEndedEarly(plan.state);
  return (
    <>
      <span className={cn(ended ? "text-warning" : plan.state === "done" ? "text-success" : undefined)} data-plan-state={plan.state}>· {plan.state === "live" ? "체크리스트" : "계획"} {PLAN_STATE_LABEL[plan.state]} · {planCountsText(counts)}</span>
      {(ended || plan.reason) && <span className="basis-full pl-6 text-[12px] font-normal text-warning">{PLAN_STATE_LABEL[plan.state]} 사유: {plan.reason?.trim() || "사유가 기록되지 않았습니다."}</span>}
    </>
  );
}

const HISTORY_STEP_STATUS = { pending: "미진행", inProgress: "진행 중이었음", completed: "완료", cancelled: "취소됨" } as const;

/** Ended plans no longer on the panel: read-only, collapsed, no run/cancel buttons. */
export function PlanHistoryList({ history }: { history: readonly PlanHistoryEntry[] }) {
  if (!history.length) return null;
  return (
    <details className="rounded border px-2 py-1 text-[12px]" aria-label="이전 계획">
      <summary className="cursor-pointer text-muted-foreground">이전 계획 {history.length}개</summary>
      <ul className="mt-1 grid gap-1">
        {history.map((h) => (
          <li key={h.key} data-plan-history={h.state}>
            <details>
              <summary className="cursor-pointer">
                <span className={planEndedEarly(h.state) ? "text-warning" : "text-success"}>{PLAN_STATE_LABEL[h.state]}</span> · {planCountsText(planCounts(h.steps))}
                {(planEndedEarly(h.state) || h.reason) && <> · 사유: {h.reason?.trim() || "사유가 기록되지 않았습니다."}</>}
              </summary>
              <ol className="mt-0.5 grid gap-0.5 pl-3">
                {h.steps.map((s, i) => (
                  <li key={`${i}:${s.id ?? ""}`}>
                    <span className={cn((s.status === "completed" || s.status === "cancelled") && "text-muted-foreground line-through")}>{normalizePlanStepTitle(planStepName(s))}</span>
                    <span className="text-muted-foreground"> · {HISTORY_STEP_STATUS[s.status]}{s.status === "cancelled" ? ` · 취소 사유: ${s.cancelReason?.trim() || "사유가 기록되지 않았습니다."}` : ""}</span>
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PlanSteps({ plan, consults, items }: { plan: NonNullable<ReturnType<typeof planOf>>; consults: Consult[]; items: Item[] }) {
  const views = useMemo(() => planStepViews(plan.steps), [plan.steps]);
  const cards = useMemo(() => consultCardIds(items), [items]);
  const open = planEndedEarly(plan.state) ? openPlanSteps(plan.steps) : [];
  return (
    <>
    {open.length > 0 && (
      <div className="rounded border border-warning/40 px-2 py-1 text-[12px]" aria-label="진행되지 않은 단계">
        <span className="font-medium text-warning">진행되지 않은 단계 {open.length}개:</span> {open.map((s) => normalizePlanStepTitle(planStepName(s))).join(", ")}
      </div>
    )}
    <ol className="grid gap-1" aria-label="체크리스트">
      {views.map(({ step: s, key, blockers, ready }) => (
        <li key={key} className="flex items-start gap-1.5">
          {s.status === "completed" ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : s.status === "cancelled" ? <Ban className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="취소됨" /> : s.status === "inProgress" ? <CircleDot className="mt-0.5 size-3.5 shrink-0 text-primary" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <span className={cn((s.status === "completed" || s.status === "cancelled") && "text-muted-foreground line-through")}>{s.owner && <span className="mr-1 font-medium text-orch">[{s.owner}]</span>}{normalizePlanStepTitle(s.title)}</span>
            {s.status === "cancelled" && <span className="ml-1 rounded border border-warning/50 px-1 text-[11px] text-warning">취소됨</span>}
            {s.status === "cancelled" && <div className="text-[11.5px] text-muted-foreground">취소 사유: {s.cancelReason?.trim() || "사유가 기록되지 않았습니다."}</div>}
            {(blockers.length > 0 || ready || !!s.consultIds?.length) && (
              <div className="flex flex-wrap gap-x-2 text-[11.5px]">
                {blockers.length > 0 && <span className="text-warning">대기 · 선행 미완료: {blockers.map(planBlockerName).join(", ")}</span>}
                {ready && <span className="text-success">시작 가능</span>}
                {planConsultLinks(s, consults).map(({ consultId, consult }) => (
                  <button key={consultId} type="button" disabled={!cards.has(consultId)} aria-label={`협의 ${consult?.seq ?? consultId} 카드로 이동`} onClick={() => revealConsultCard(consultId)}
                    className={cn("rounded px-1 py-0.5 underline decoration-dotted underline-offset-2 disabled:cursor-default disabled:no-underline", consult && consult.status !== "done" && consult.status !== "running" ? "text-destructive" : "text-muted-foreground")}>
                    협의 {consult?.seq ?? `#${consultId}`}{consult ? ` · ${CONSULT_STATUS_LABEL[consult.status]}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
    </>
  );
}

// ---------- run statistics

export function RunStatsSheet({ chat, events, agents, consults, onClose }: { chat: Chat; events: TimelineEvent[]; agents: ChatAgent[]; consults: Consult[]; onClose: () => void }) {
  const live = chat.status === "working" || chat.status === "approval" || chat.status === "pausing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const rows = useMemo(() => runStatsRows(events, agents, consults, live ? now : undefined), [events, agents, consults, live, now]);
  return (
    <Modal title="실행 통계" onClose={onClose} wide>
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">{RUN_STATS_NOTE}</p>
      {rows.total.eventCount === 0 ? <div className="text-[13px] text-muted-foreground">기록 없음</div> : (
        <div className="grid gap-3">
          <StatsList caption="채팅 전체" rows={[{ key: "total", label: "전체", stats: rows.total }]} />
          <StatsList caption="역할별" rows={rows.roles} />
          <StatsList caption="협의별" rows={rows.consults} />
        </div>
      )}
    </Modal>
  );
}

function StatsList({ caption, rows }: { caption: string; rows: RunStatsRow[] }) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-1 text-[12px] font-medium text-muted-foreground">{caption}</h3>
      <div className="grid gap-1.5">{rows.map(r => <StatsCard key={r.key} label={r.label} stats={r.stats} />)}</div>
    </section>
  );
}

function StatsCard({ label, stats: s }: { label: string; stats: RunStats }) {
  const flags = runStatsFlags(s);
  return (
    <Card className="p-2.5 text-[12.5px] tabular-nums">
      <div className="mb-0.5 truncate font-medium">{label}</div>
      <div className="flex flex-wrap gap-x-3 text-muted-foreground">
        <span>기록 구간 {formatDuration(s.elapsedMs)}</span>
        <span>도구 실행 {formatDuration(s.toolMs)}{s.pendingTools ? ` +${PENDING_TOOL_LABEL}` : ""}</span>
        <span>승인 대기 {formatDuration(s.approvalMs)}{s.pendingApprovals ? " +대기 중" : ""}</span>
        <span>기록 {s.eventCount}개</span>
      </div>
      {flags.length > 0 && <div className="mt-0.5 flex flex-wrap gap-x-2">{flags.map(f => <span key={f} className={/실패/.test(f) ? "text-destructive" : "text-warning"}>{f}</span>)}</div>}
    </Card>
  );
}

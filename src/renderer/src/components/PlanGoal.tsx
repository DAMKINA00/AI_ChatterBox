import { useMemo, useState } from "react";
import { Ban, Check, ChevronDown, Circle, Flag, ListChecks, MessageCircleQuestion, Play, Pencil, X } from "lucide-react";
import type { Chat } from "../../../shared/types";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { normalizePlanStepTitle, type planOf } from "../timeline";
import type { PlanHistoryEntry } from "../lib/plan-history";
import { openPlanSteps, PLAN_STATE_LABEL, planActionsAvailable, planBlockerName, planConsultLinks, planCounts, planCountsText, planEndedEarly, isPlanChangedError, PLAN_CHANGED_TEXT, planGroups, planReviewTarget, planRunArg, planStepName, planStepTags, planStepViews } from "../lib/plan-view";
import { Badge, Button } from "./ui";
import { WorkingIndicator } from "./WorkingIndicator";
import { useMobile } from "../lib/remote-mode";

type Plan = NonNullable<ReturnType<typeof planOf>>;

/** Pinned checklist from the orchestrator's native plan tool, with the /plan approval buttons. */
/** Opens the folded work log around the master's question card and brings it into view. */
export function revealAskCard(askId: string) {
  const card = [...document.querySelectorAll<HTMLElement>("[data-ask-id]")].find((el) => el.dataset.askId === askId);
  if (!card) return false;
  for (let parent = card.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.focus({ preventScroll: true });
  return true;
}

/** "마스터 질문 답변 대기" chip: jumps to the unanswered ask_user card. */
export function AskWaitBadge({ askId }: { askId: string }) {
  const toast = useStore((s) => s.toast);
  return (
    <button type="button" data-testid="plan-ask-wait"
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={(e) => { e.stopPropagation(); if (!revealAskCard(askId)) toast("질문 카드가 아직 불러와지지 않았습니다. 대화를 위로 스크롤해 확인하세요."); }}>
      <MessageCircleQuestion className="size-3.5" /> 마스터 질문 답변 대기
    </button>
  );
}

/** Plan mode is on and the master asks something before any proposal exists. */
export function PlanAskNotice({ askId }: { askId: string }) {
  return (
    <div className="mx-auto mt-3 flex w-[min(860px,calc(100%-32px))] items-center gap-2 rounded-xl border border-primary/40 bg-primary/6 px-3.5 py-2 text-[12.5px]" data-testid="plan-ask-notice">
      <ListChecks className="size-4 shrink-0 text-orch" />
      <span className="min-w-0 flex-1">마스터가 계획을 세우기 전에 확인할 것이 있습니다.</span>
      <AskWaitBadge askId={askId} />
    </div>
  );
}

export function PlanPanel({ chat, plan, onRevise, askId, version }: { chat: Chat; plan: Plan; onRevise: () => void; askId?: string; version: number }) {
  // Phones (remote web): a live checklist starts folded so the conversation keeps the screen; a proposal
  // waiting for run/cancel stays open.
  const mobile = useMobile();
  const [expanded, setExpanded] = useState(() => !mobile || plan.state !== "live");
  const toast = useStore((s) => s.toast);
  const agents = useStore(s => s.agents[chat.id]);
  const consults = useStore(s => s.consults[chat.id]);
  const select = useStore(s => s.select);
  const views = useMemo(() => planStepViews(plan.steps), [plan.steps]);
  const groups = useMemo(() => planGroups(views), [views]);
  const counts = useMemo(() => planCounts(plan.steps), [plan.steps]);
  const open = useMemo(() => openPlanSteps(plan.steps), [plan.steps]);
  const ended = planEndedEarly(plan.state);
  const run = (name: string) => api.command(chat.id, name, "").catch((e) => toast(errorMessage(e)));
  // Approval carries the version on screen: a proposal replaced meanwhile (another window, the remote
  // page) is refused by the main process instead of running a plan the user has not seen.
  const approve = () => api.command(chat.id, "plan-run", planRunArg(plan.planId, version)).catch((e) => toast(isPlanChangedError(e) ? `${PLAN_CHANGED_TEXT} (${errorMessage(e)})` : errorMessage(e)));
  return (
    <div className={cn("mx-auto mt-3 w-[min(860px,calc(100%-32px))] overflow-hidden rounded-xl border bg-card shadow-sm", ended && "border-warning/50")} data-testid="plan-panel" data-state={plan.state}>
      <button className={cn("flex w-full items-center gap-2 px-3.5 py-2 text-left", mobile && "min-h-11 flex-wrap")} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ListChecks className="size-4 text-orch" />
        <span className="text-[13px] font-semibold">{plan.state === "live" ? "체크리스트" : "계획"}</span>
        {plan.state !== "live" && <Badge className="text-muted-foreground" data-testid="plan-version">v{version}</Badge>}
        <Badge className={cn(plan.state === "done" ? "border-success/40 text-success" : ended && "border-warning/50 text-warning")} data-testid="plan-state">{PLAN_STATE_LABEL[plan.state]}</Badge>
        <Badge className={cn(counts.open === 0 && counts.cancelled === 0 && counts.total > 0 && "border-success/40 text-success")} data-testid="plan-progress">
          {planCountsText(counts)}
        </Badge>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${counts.total ? (counts.completed / counts.total) * 100 : 0}%` }} />
        </div>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
      </button>
      {askId && (
        <div className="flex items-center gap-2 border-t px-3.5 py-1.5 text-[12px] text-muted-foreground">
          <AskWaitBadge askId={askId} /> 답하면 마스터가 계획을 이어 갑니다.
        </div>
      )}
      {/* The reason an ended plan stopped short stays visible even when the card is collapsed. */}
      {(ended || plan.reason) && (
        <div className={cn("border-t px-3.5 py-1.5 text-[12px]", ended ? "text-warning" : "text-muted-foreground")} data-testid="plan-reason">
          {PLAN_STATE_LABEL[plan.state]} · {plan.reason?.trim() || "사유가 기록되지 않았습니다."}
          {ended && open.length > 0 && <span className="text-muted-foreground"> · 미진행 {open.length}개</span>}
        </div>
      )}
      {expanded && (
        <div className="space-y-2 border-t px-3.5 py-2.5">
          {plan.explanation && <div className="text-[12.5px] text-muted-foreground">{plan.explanation}</div>}
          {ended && open.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-[12px]" data-testid="plan-open-steps">
              <div className="font-medium text-warning">진행되지 않은 단계 {open.length}개</div>
              <ul className="mt-0.5 list-disc pl-4">{open.map((s, i) => <li key={`${i}:${s.id ?? ""}`}>{normalizePlanStepTitle(planStepName(s))}{s.status === "inProgress" ? " (진행 중이었음)" : ""}</li>)}</ul>
            </div>
          )}
          {(groups ?? [{ group: 0, steps: views }]).map(({ group, steps: list, undetermined }) => (
          <div key={undetermined ? "undetermined" : group} className={cn(groups && "rounded-lg border border-dashed px-2.5 py-1.5", undetermined && "border-warning/50")} data-testid={groups ? "plan-group" : undefined} data-group={groups ? (undetermined ? "undetermined" : group) : undefined}>
          {groups && (
            <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
              {undetermined ? <span className="text-warning">순서 미확정 · 선행 단계가 없거나 서로 순환합니다</span> : <>
                <span className="text-orch">{group}단계</span>
                {list.length > 1 ? <span>· 동시 진행 {list.length}개</span> : <span>· 단독</span>}
              </>}
            </div>
          )}
          <ol className="space-y-1">
            {list.map(({ step: s, key, blockers, ready, groupWait }) => {
              const title = normalizePlanStepTitle(s.title);
              const ownerRole = agents?.find(a => (s.owner ? a.nickname === s.owner : title.startsWith(`[${a.nickname}]`)))?.key;
              const links = planConsultLinks(s, consults);
              const tags = planStepTags(s);
              return (
                <li key={key} className="flex items-start gap-2 text-[13px]" data-testid="plan-step" data-status={s.status} data-blocked={blockers.length > 0} data-ready={ready}>
                  {s.status === "completed" ? (
                    <Check className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : s.status === "cancelled" ? (
                    <Ban className="mt-0.5 size-4 shrink-0 text-warning" aria-label="취소됨" />
                  ) : s.status === "inProgress" && (plan.state === "running" || plan.state === "live") ? (
                    <WorkingIndicator chatId={chat.id} role={ownerRole} className="mt-0.5 size-4" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      {s.owner && <span className="shrink-0 text-[11.5px] font-medium text-orch" data-testid="plan-step-owner">[{s.owner}]</span>}
                      <span className={cn("break-words", s.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40", s.status === "cancelled" && "text-muted-foreground line-through decoration-warning/60")}>{title}</span>
                      {tags.kind && <Badge className="shrink-0" data-testid="plan-step-kind">{tags.kind}</Badge>}
                      {tags.agentKind && <Badge className="shrink-0 text-muted-foreground" data-testid="plan-step-agent-kind">{tags.agentKind}</Badge>}
                      {s.status === "cancelled" && <span className="shrink-0 rounded border border-warning/50 px-1 text-[11px] text-warning" data-testid="plan-step-cancelled">취소됨</span>}
                    </div>
                    {(!!s.scope?.length || !!s.done?.trim() || !!s.dependsOn?.length || !!s.reviewOf) && (
                      <div className="mt-0.5 space-y-0.5 text-[11.5px] text-muted-foreground">
                        {!!s.scope?.length && <div className="break-all" data-testid="plan-step-scope">범위: <span className="font-mono">{s.scope.join(", ")}</span></div>}
                        {!!s.done?.trim() && <div data-testid="plan-step-done">완료 기준: {s.done.trim()}</div>}
                        {!!s.dependsOn?.length && <div data-testid="plan-step-depends">선행: {s.dependsOn.map((id) => { const d = plan.steps.find((x) => x.id === id); return d ? normalizePlanStepTitle(planStepName(d)) : id; }).join(", ")}</div>}
                        {s.reviewOf && <div data-testid="plan-step-review-of">리뷰 대상: {planReviewTarget(s, plan.steps)}</div>}
                      </div>
                    )}
                    {s.status === "cancelled" && <div className="mt-0.5 text-[11.5px] text-muted-foreground" data-testid="plan-step-cancel-reason">취소 사유: {s.cancelReason?.trim() || "사유가 기록되지 않았습니다."}</div>}
                    {(blockers.length > 0 || ready || groupWait || links.length > 0) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]">
                        {blockers.length > 0 && <span className="text-warning" data-testid="plan-step-blockers">대기 · 선행 미완료: {blockers.map(planBlockerName).join(", ")}</span>}
                        {groupWait && <span className="text-muted-foreground" data-testid="plan-step-group-wait">대기 · 앞 단계 묶음이 끝나면 시작</span>}
                        {ready && <span className="text-success" data-testid="plan-step-ready">시작 가능</span>}
                        {links.map(({ consultId, consult }) => (
                          <button key={consultId} type="button" data-testid="plan-step-consult"
                            className={cn("rounded border px-1.5 py-px hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", consult && consult.status !== "done" && consult.status !== "running" ? "border-destructive/40 text-destructive" : "text-muted-foreground")}
                            aria-label={`협의 ${consult?.seq ?? consultId} 기록 열기`}
                            onClick={() => void select({ chatId: chat.id, node: `consult:${consultId}` })}>
                            협의 {consult?.seq ?? `#${consultId}`}{consult ? ` · ${CONSULT_STATUS[consult.status]}` : ""}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          </div>
          ))}
          {planActionsAvailable(plan.state, chat.status) ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={() => void approve()} data-testid="plan-run" data-version={version}>
                <Play /> 승인하고 실행
              </Button>
              <Button size="sm" variant="secondary" onClick={onRevise}>
                <Pencil /> 수정 요청
              </Button>
              <Button size="sm" variant="outline" onClick={() => void run("plan-cancel")} data-testid="plan-cancel">
                <X /> 취소
              </Button>
            </div>
          ) : plan.state === "proposed" && (
            <div className="pt-1 text-[12px] text-muted-foreground" data-testid="plan-actions-wait">작업이 끝나면 이 계획을 실행하거나 취소할 수 있습니다.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ended plans the pinned panel no longer shows: read-only, collapsed, never with run/cancel buttons. */
export function PlanHistory({ history }: { history: readonly PlanHistoryEntry[] }) {
  if (!history.length) return null;
  return (
    <details className="mx-auto mt-2 w-[min(860px,calc(100%-32px))] rounded-xl border bg-card/60 px-3.5 py-1.5 text-[12.5px]" data-testid="plan-history">
      <summary className="cursor-pointer text-muted-foreground">이전 계획 {history.length}개</summary>
      <ul className="mt-1.5 space-y-1.5">
        {history.map((h) => {
          const counts = planCounts(h.steps);
          const ended = planEndedEarly(h.state);
          return (
            <li key={h.key} data-testid="plan-history-entry" data-state={h.state}>
              <details className="rounded-lg border px-2.5 py-1.5">
                <summary className="cursor-pointer">
                  <span className={cn("font-medium", ended ? "text-warning" : "text-success")}>{PLAN_STATE_LABEL[h.state]}</span>
                  <span className="text-muted-foreground"> · {planCountsText(counts)}</span>
                  {(ended || h.reason) && <span className="text-muted-foreground"> · 사유: {h.reason?.trim() || "사유가 기록되지 않았습니다."}</span>}
                </summary>
                {h.explanation && <div className="mt-1 text-muted-foreground">{h.explanation}</div>}
                <ol className="mt-1 space-y-0.5">
                  {h.steps.map((s, i) => (
                    <li key={`${i}:${s.id ?? ""}`} data-status={s.status}>
                      <span className={cn((s.status === "completed" || s.status === "cancelled") && "text-muted-foreground line-through")}>{s.owner ? `[${s.owner}] ` : ""}{normalizePlanStepTitle(planStepName(s))}</span>
                      <span className="text-[11.5px] text-muted-foreground"> · {STEP_STATUS[s.status]}</span>
                      {s.status === "cancelled" && <span className="text-[11.5px] text-muted-foreground"> · 취소 사유: {s.cancelReason?.trim() || "사유가 기록되지 않았습니다."}</span>}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

const STEP_STATUS = { pending: "미진행", inProgress: "진행 중이었음", completed: "완료", cancelled: "취소됨" } as const;

const CONSULT_STATUS = { running: "진행 중", done: "완료", error: "오류", stopped: "중지됨", limited: "한도 도달" } as const;

const GOAL_LABEL = { active: "진행 중", complete: "완료", blocked: "막힘", paused: "멈춤" } as const;

/** Pinned /goal bar. */
export function GoalBar({ chat }: { chat: Chat }) {
  const toast = useStore((s) => s.toast);
  const g = chat.goal;
  if (!g) return null;
  return (
    <div
      className={cn(
        "mx-auto mt-3 flex w-[min(860px,calc(100%-32px))] items-start gap-2.5 rounded-xl border px-3.5 py-2.5",
        g.status === "complete" ? "border-success/40 bg-success/8" : g.status === "active" ? "border-primary/40 bg-primary/6" : "border-warning/40 bg-warning/8",
      )}
      data-testid="goal-bar"
      data-status={g.status}
    >
      <Flag className={cn("mt-0.5 size-4 shrink-0", g.status === "complete" ? "text-success" : "text-primary")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold">목표</span>
          <Badge>{GOAL_LABEL[g.status]}</Badge>
          {g.status === "active" && <WorkingIndicator chatId={chat.id} />}
          <span className="text-[11.5px] text-muted-foreground">{g.turns}번째 진행</span>
        </div>
        <div className="mt-0.5 text-[13px] select-text">{g.objective}</div>
        {g.progress && <div className="mt-1 text-[12px] text-muted-foreground select-text" data-testid="goal-progress">{g.progress}</div>}
      </div>
      <Button
        size="xs"
        variant="ghost"
        aria-label="목표 지우기"
        onClick={() => void api.command(chat.id, "goal", "clear").catch((e) => toast(errorMessage(e)))}
      >
        <X /> 지우기
      </Button>
    </div>
  );
}

import { useState } from "react";
import { Check, ChevronDown, Circle, Flag, ListChecks, Loader2, Play, Pencil, X } from "lucide-react";
import type { Chat } from "../../../shared/types";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import type { planOf } from "../timeline";
import { Badge, Button } from "./ui";

type Plan = NonNullable<ReturnType<typeof planOf>>;

/** Pinned checklist from the orchestrator's native plan tool, with the /plan approval buttons. */
export function PlanPanel({ chat, plan, onRevise }: { chat: Chat; plan: Plan; onRevise: () => void }) {
  const [open, setOpen] = useState(true);
  const toast = useStore((s) => s.toast);
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const total = plan.steps.length;
  const run = (name: string) => api.command(chat.id, name, "").catch((e) => toast(errorMessage(e)));
  if (plan.state === "cancelled") return null;
  return (
    <div className="mx-auto mt-3 w-[min(860px,calc(100%-32px))] overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="plan-panel" data-state={plan.state}>
      <button className="flex w-full items-center gap-2 px-3.5 py-2 text-left" onClick={() => setOpen(!open)}>
        <ListChecks className="size-4 text-orch" />
        <span className="text-[13px] font-semibold">{plan.state === "proposed" ? "계획 (승인 대기)" : "계획"}</span>
        <Badge className={cn(done === total && "border-success/40 text-success")} data-testid="plan-progress">
          {done}/{total} 완료
        </Badge>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3.5 py-2.5">
          {plan.explanation && <div className="text-[12.5px] text-muted-foreground">{plan.explanation}</div>}
          <ol className="space-y-1">
            {plan.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]" data-testid="plan-step" data-status={s.status}>
                {s.status === "completed" ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-success" />
                ) : s.status === "inProgress" ? (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                )}
                <span className={cn(s.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>{s.title}</span>
              </li>
            ))}
          </ol>
          {plan.state === "proposed" && (
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => void run("plan-run")} data-testid="plan-run">
                <Play /> 실행
              </Button>
              <Button size="sm" variant="secondary" onClick={onRevise}>
                <Pencil /> 수정 요청
              </Button>
              <Button size="sm" variant="outline" onClick={() => void run("plan-cancel")}>
                <X /> 취소
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
          {g.status === "active" && <Loader2 className="size-3.5 animate-spin text-primary" />}
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

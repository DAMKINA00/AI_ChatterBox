import { useEffect, useMemo, useState } from "react";
import type { RunStats } from "../../../shared/run-stats";
import type { Chat } from "../../../shared/types";
import { formatDuration, PENDING_TOOL_LABEL, RUN_STATS_NOTE, runStatsFlags, runStatsRows, type RunStatsRow } from "../lib/run-stats-view";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { Dialog, DialogContent } from "./ui";

const running = (chat: Chat) => chat.status === "working" || chat.status === "approval" || chat.status === "pausing";

/** Recorded spans of tool runs and approval waits, per chat / role / consult. Opened from the chat header. */
export function RunStatsDialog({ chat, open, onOpenChange }: { chat: Chat; open: boolean; onOpenChange: (open: boolean) => void }) {
  const events = useStore((s) => s.events[chat.id]);
  const agents = useStore((s) => s.agents[chat.id]);
  const consults = useStore((s) => s.consults[chat.id]);
  const live = running(chat);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, live]);
  const rows = useMemo(() => (open && events ? runStatsRows(events, agents, consults, live ? now : undefined) : null), [open, events, agents, consults, live, now]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="실행 통계" description={live ? "진행 중인 항목은 현재 시각까지 계산합니다." : "마지막 기록까지 계산합니다."} className="w-[min(760px,calc(100vw-32px))]" data-testid="run-stats">
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="run-stats-note">{RUN_STATS_NOTE}</p>
        {!rows ? null : rows.total.eventCount === 0 ? (
          <div className="text-[13px] text-muted-foreground">기록 없음</div>
        ) : (
          <div className="space-y-3">
            <StatsTable caption="채팅 전체" rows={[{ key: "total", label: "전체", stats: rows.total }]} />
            <StatsTable caption="역할별" rows={rows.roles} />
            {rows.consults.length > 0 && <StatsTable caption="협의별" rows={rows.consults} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatsTable({ caption, rows }: { caption: string; rows: RunStatsRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-[12px] tabular-nums" data-testid="run-stats-table">
        <caption className="border-b px-2.5 py-1.5 text-left text-[11.5px] font-medium text-muted-foreground">{caption}</caption>
        <thead className="text-[11px] text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="px-2.5 py-1 text-left font-medium">대상</th>
            <th scope="col" className="px-2 py-1 text-right font-medium" title="첫 기록부터 마지막 기록(진행 중이면 현재)까지. 유휴 시간 포함">기록 구간</th>
            <th scope="col" className="px-2 py-1 text-right font-medium" title="도구 호출~결과 구간의 합집합">도구 실행</th>
            <th scope="col" className="px-2 py-1 text-right font-medium" title="승인 요청~결정 구간의 합집합. 도구 실행과 겹칠 수 있음">승인 대기</th>
            <th scope="col" className="px-2 py-1 text-left font-medium">상태</th>
            <th scope="col" className="px-2 py-1 text-right font-medium">기록 수</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <StatsRow key={r.key} row={r} />)}
        </tbody>
      </table>
    </div>
  );
}

function StatsRow({ row }: { row: RunStatsRow }) {
  const s: RunStats = row.stats;
  const flags = runStatsFlags(s);
  return (
    <tr className="border-b last:border-b-0" data-testid="run-stats-row" data-key={row.key} data-pending-tools={s.pendingTools} data-pending-approvals={s.pendingApprovals}>
      <th scope="row" className="max-w-56 truncate px-2.5 py-1 text-left font-normal" title={row.label}>{row.label}</th>
      <td className="px-2 py-1 text-right">{formatDuration(s.elapsedMs)}</td>
      <td className="px-2 py-1 text-right">{formatDuration(s.toolMs)}{s.pendingTools > 0 && <span className="text-warning"> +{PENDING_TOOL_LABEL}</span>}</td>
      <td className="px-2 py-1 text-right">{formatDuration(s.approvalMs)}{s.pendingApprovals > 0 && <span className="text-warning"> +대기 중</span>}</td>
      <td className="px-2 py-1">
        {flags.length ? flags.map((f) => <span key={f} className={cn("mr-1.5 whitespace-nowrap", /실패/.test(f) ? "text-destructive" : "text-warning")}>{f}</span>) : <span className="text-muted-foreground" aria-label="결과 미확인·승인 대기·실패 없음">—</span>}
      </td>
      <td className="px-2 py-1 text-right text-muted-foreground">{s.eventCount}</td>
    </tr>
  );
}

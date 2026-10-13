import { summarizeAgentMetrics } from "../../../shared/agent-metrics";
import type { Role, TimelineEvent } from "../../../shared/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui";

const numberFormat = new Intl.NumberFormat("ko-KR");

export function AgentUsage({ events, role, label }: { events: TimelineEvent[]; role: Role; label: string }) {
  const summary = summarizeAgentMetrics(events, role);
  const testId = `agent-usage-${role}`;
  if (!summary) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid={testId}>
        <span>{label}</span>
        <span>사용량 대기</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" data-testid={testId} aria-label={`${label} 사용량 상세`} className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
        <span>{label}</span>
        <span>{numberFormat.format(summary.outputTokens)} 출력</span>
        <span>{summary.outputTokensPerSecond === null ? "속도 대기" : `${summary.outputTokensPerSecond.toFixed(1)} tok/s`}</span>
        {summary.approximate && <span title="일부 수치가 근사치입니다">≈</span>}
      </button></DropdownMenuTrigger>
      <DropdownMenuContent className="grid min-w-52 gap-1 p-2 text-[11px]">
        <div className="font-medium">{label} 사용량 · {summary.turnCount}턴</div>
        <div>입력 {numberFormat.format(summary.inputTokens)} · 출력 {numberFormat.format(summary.outputTokens)}</div>
        <div>캐시 읽기 {numberFormat.format(summary.cachedInputTokens)} · 캐시 저장 {numberFormat.format(summary.cacheWriteInputTokens)}</div>
        <div>누적 경과 {formatElapsed(summary.elapsedMs)}</div>
        {summary.model && <div className="truncate text-muted-foreground">{summary.model}</div>}
        <div className="max-w-64 whitespace-normal text-muted-foreground">출력 tok/s는 마지막 턴의 출력 토큰을 턴 경과 시간으로 나눈 평균이며, 도구·승인 대기 시간도 포함합니다.</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

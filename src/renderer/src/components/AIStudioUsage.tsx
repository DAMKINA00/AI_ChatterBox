import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import type { AIStudioUsageRange, AIStudioUsageReport, AIStudioUsageStats } from "../../../shared/aistudio";
import { api, cn, errorMessage } from "../lib/utils";
import { Button } from "./ui";

const RANGE_OPTIONS: { value: AIStudioUsageRange; label: string }[] = [
  { value: "24h", label: "최근 24시간" },
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
];

type LoadState = "idle" | "loading" | "ready" | "empty" | "error";

function numberText(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("ko-KR") : "알 수 없음";
}

function timeText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ko-KR");
}

function hasRecords(stats: AIStudioUsageStats): boolean {
  return stats.requests > 0 || stats.succeeded > 0 || stats.failed > 0 || stats.canceled > 0 || stats.rateLimited > 0
    || stats.inputTokens > 0 || stats.cachedTokens > 0 || stats.reasoningTokens > 0 || stats.replyTokens > 0 || stats.totalTokens > 0;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5 rounded-md border bg-muted/20 px-2.5 py-2" data-testid="aistudio-usage-stat">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[14px] font-medium tabular-nums">{numberText(value)}</span>
    </div>
  );
}

function Totals({ stats }: { stats: AIStudioUsageStats }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="aistudio-usage-totals">
      <Stat label="전체 요청" value={stats.requests} />
      <Stat label="성공" value={stats.succeeded} />
      <Stat label="실패" value={stats.failed} />
      <Stat label="취소" value={stats.canceled} />
      <Stat label="429 제한" value={stats.rateLimited} />
      <Stat label="입력 토큰" value={stats.inputTokens} />
      <Stat label="캐시 토큰 (입력 포함)" value={stats.cachedTokens} />
      <Stat label="응답 토큰" value={stats.replyTokens} />
      <Stat label="추론 토큰" value={stats.reasoningTokens} />
      <Stat label="총 토큰" value={stats.totalTokens} />
    </div>
  );
}

export function AIStudioUsage({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  const [range, setRange] = useState<AIStudioUsageRange>("24h");
  const [report, setReport] = useState<AIStudioUsageReport>();
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string>();
  const [group, setGroup] = useState<"account" | "model" | "channel">("account");
  const requestId = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestId.current += 1;
    };
  }, []);

  const load = useCallback(async (requestedRange: AIStudioUsageRange) => {
    const id = ++requestId.current;
    if (alive.current) {
      setLoadState("loading");
      setError(undefined);
    }
    try {
      const next = await api.aiStudioUsage(requestedRange);
      if (!alive.current || id !== requestId.current) return;
      setReport(next);
      setLoadState(hasRecords(next.totals) ? "ready" : "empty");
      setError(undefined);
    } catch (e) {
      if (!alive.current || id !== requestId.current) return;
      setReport(undefined);
      setLoadState("error");
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setReport(undefined);
    void load(range);
    const timer = window.setInterval(() => void load(range), compact ? 60_000 : 30_000);
    return () => {
      window.clearInterval(timer);
      requestId.current += 1;
    };
  }, [compact, load, range]);

  const refresh = () => void load(range);
  const compactDetail = loadState === "loading"
    ? report ? "새로고침 중…" : "조회 중…"
    : loadState === "error" && !report
      ? "조회 실패"
      : loadState === "empty"
        ? "최근 24시간 기록 없음"
        : report
          ? `${numberText(report.totals.requests)} 요청 · ${numberText(report.totals.totalTokens)} 토큰`
          : "사용량 확인 전";

  if (compact) {
    return (
      <Button type="button" variant="ghost" size="sm" className="h-auto min-h-7 w-full justify-start py-1 text-left text-[11px]" onClick={onOpen} data-testid="aistudio-usage-summary" title={report ? `AI Studio 로컬 사용량 상세 보기 · 생성 ${timeText(report.generatedAt)}` : "AI Studio 로컬 사용량 상세 보기"}>
        <span className="min-w-0 flex-1 leading-tight"><span className="block font-medium">AI Studio · 최근 24시간</span><span className="block whitespace-normal">{compactDetail}</span></span>
        {loadState === "loading" && <Loader2 className="ml-auto size-3 shrink-0 animate-spin" />}
      </Button>
    );
  }

  const groups = report?.groups ?? { account: [], model: [], channel: [] };
  const rows = groups[group] ?? [];

  return (
    <section className="grid gap-3 rounded-lg border p-3.5" data-testid="aistudio-usage-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <div className="text-[12px] font-medium text-muted-foreground">AI Studio 사용량</div>
          <div className="text-[11.5px] text-muted-foreground">이 로컬 AIStudio2API를 통과한 사용 기록입니다. Gemini Web 사용량과 별개이며 Google 잔여 한도는 제공되지 않습니다. 429 제한은 실패 건수와 중복될 수 있으며, 캐시 토큰은 입력 토큰에 포함됩니다.</div>
        </div>
        <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={refresh} disabled={loadState === "loading"} aria-label="AI Studio 사용량 새로고침" data-testid="aistudio-usage-refresh">
          <RotateCw className={cn(loadState === "loading" && "animate-spin")} /> 새로고침
        </Button>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span>기간</span>
        <select value={range} onChange={(event) => setRange(event.target.value as AIStudioUsageRange)} aria-label="AI Studio 사용량 기간" data-testid="aistudio-usage-range" className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px]">
          {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {loadState === "loading" && <div className="flex items-center gap-2 text-[12px] text-muted-foreground" data-testid="aistudio-usage-loading"><Loader2 className="size-3.5 animate-spin" />사용량을 {report ? "다시 " : ""}조회하는 중입니다.</div>}
      {loadState === "error" && <div role="alert" className="text-[12px] text-destructive" data-testid="aistudio-usage-error">사용량을 조회하지 못했습니다: {error ?? "알 수 없는 오류"}</div>}
      {loadState === "empty" && report && <div className="text-[12px] text-muted-foreground" data-testid="aistudio-usage-empty">선택한 기간에 기록된 AI Studio 사용량이 없습니다.</div>}
      {report && (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="aistudio-usage-window">
            <span>조회 기간: {timeText(report.from)} ~ {timeText(report.to)}</span>
            <span>생성: {timeText(report.generatedAt)}</span>
          </div>
          {loadState === "ready" && <>
            <Totals stats={report.totals} />
          <p className="text-[11px] text-muted-foreground">토큰은 백엔드 집계값이며 추정값이나 미수신으로 인한 누락이 있을 수 있습니다.</p>
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-muted-foreground">세부 집계</span>
                <select value={group} onChange={(event) => setGroup(event.target.value as typeof group)} aria-label="AI Studio 세부 집계 기준" data-testid="aistudio-usage-group" className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px]">
                  <option value="account">계정</option>
                  <option value="model">모델</option>
                  <option value="channel">채널</option>
                </select>
              </div>
              <div className="max-h-48 overflow-x-auto overflow-y-auto rounded-md border">
                <table className="w-full min-w-[520px] text-left text-[11.5px]" data-testid="aistudio-usage-table">
                  <thead className="border-b bg-muted/30 text-muted-foreground"><tr><th className="px-2.5 py-2 font-medium">{group === "account" ? "계정" : group === "model" ? "모델" : "채널"}</th><th className="px-2.5 py-2 text-right font-medium">요청</th><th className="px-2.5 py-2 text-right font-medium">실패</th><th className="px-2.5 py-2 text-right font-medium">취소</th><th className="px-2.5 py-2 text-right font-medium">총 토큰</th></tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.key} className="border-b last:border-0"><td className="max-w-56 truncate px-2.5 py-2" title={row.key}>{row.key || "알 수 없음"}</td><td className="px-2.5 py-2 text-right tabular-nums">{numberText(row.requests)}</td><td className="px-2.5 py-2 text-right tabular-nums">{numberText(row.failed)}</td><td className="px-2.5 py-2 text-right tabular-nums">{numberText(row.canceled)}</td><td className="px-2.5 py-2 text-right tabular-nums">{numberText(row.totalTokens)}</td></tr>)}</tbody>
                </table>
                {!rows.length && <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">선택한 기간에 세부 기록이 없습니다.</div>}
              </div>
            </div>
          </>}
        </>
      )}
    </section>
  );
}

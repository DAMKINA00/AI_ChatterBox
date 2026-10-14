import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { pickUsage, type UsageDisplay } from "../../../shared/usage";
import type { GeminiWebUsage } from "../../../shared/types";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { Tooltip } from "./ui";

function resetText(ts?: number | null) {
  if (!ts) return "";
  const ms = (ts > 1e12 ? ts : ts * 1000) - Date.now();
  if (ms <= 0) return "곧 초기화";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 뒤 초기화` : `${h}시간 ${m}분 뒤 초기화`;
}

function Bar({ name, d, color, error, updatedAt }: { name: string; d: UsageDisplay | null; color: string; error?: string; updatedAt?: number }) {
  const tip = error ?? (d
    ? [`${name} ${d.window} 남은 사용량 ${Math.round(d.remaining)}%`, resetText(d.resetsAt), d.warn ? "5시간 한도가 거의 찼습니다" : d.note]
        .filter(Boolean)
        .join(" · ")
    : "사용량 정보를 확인하는 중입니다");
  return (
    <Tooltip content={updatedAt ? `${tip} · ${new Date(updatedAt).toLocaleString("ko-KR")} 조회` : tip}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="usage-bar">
        <span className="w-[86px] shrink-0 whitespace-nowrap">
          {name} <span className={cn(d?.warn && "font-semibold text-destructive")}>{error ? "조회 실패" : d ? d.window : "정보 없음"}</span>
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          {d && <div className={cn("h-full rounded-full", d.warn ? "bg-destructive" : color)} style={{ width: `${d.remaining}%` }} />}
        </div>
        <span className={cn("w-9 text-right tabular-nums", d?.warn && "text-destructive")}>{d ? `${Math.round(d.remaining)}%` : "–"}</span>
      </div>
    </Tooltip>
  );
}

interface GeminiWebQuotaWindow {
  usedPercent: number;
  resetText?: string;
}

type RendererGeminiWebUsage = GeminiWebUsage & {
  current?: GeminiWebQuotaWindow;
  weekly?: GeminiWebQuotaWindow;
};

function validUsedPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validQuotaWindow(value: unknown): value is GeminiWebQuotaWindow {
  return !!value && typeof value === "object" && validUsedPercent((value as { usedPercent?: unknown }).usedPercent);
}

function quotaWindows(usage: GeminiWebUsage): { current?: GeminiWebQuotaWindow; weekly?: GeminiWebQuotaWindow } {
  const value = usage as RendererGeminiWebUsage;
  return {
    current: validQuotaWindow(value.current) ? value.current : undefined,
    weekly: validQuotaWindow(value.weekly) ? value.weekly : undefined,
  };
}

function percentText(value: number): string {
  return String(Number(value.toFixed(2)));
}

function remainingPercent(window: GeminiWebQuotaWindow): number {
  return 100 - window.usedPercent;
}

function webUsageDisplay(usage: GeminiWebUsage): { window: "현재" | "주간"; remaining: number; warn: boolean } | undefined {
  if (usage.status === "error") return undefined;
  const { current, weekly } = quotaWindows(usage);
  if (current && remainingPercent(current) <= 10) return { window: "현재", remaining: remainingPercent(current), warn: true };
  if (weekly) return { window: "주간", remaining: remainingPercent(weekly), warn: false };
  if (current) return { window: "현재", remaining: remainingPercent(current), warn: false };
  return undefined;
}

function usageDate(ts: number): Date {
  return new Date(ts > 1e12 ? ts : ts * 1000);
}

function webUsageText(usage: GeminiWebUsage, error?: string): string {
  if (error) return "조회 실패";
  if (usage.detail.trim()) return usage.detail;
  if (usage.status === "error") return "조회 실패";
  if (usage.status === "limited") return "사용량 제한";
  if (usage.status === "available") return "사용 가능";
  return "정보 없음";
}

function webUsageTooltip(usage: GeminiWebUsage, error?: string): string {
  const { current, weekly } = quotaWindows(usage);
  const windowText = [
    current
      ? `현재 ${percentText(current.usedPercent)}% 사용 · ${percentText(remainingPercent(current))}% 남음${current.resetText?.trim() ? ` · 초기화: ${current.resetText.trim()}` : ""}`
      : "",
    weekly
      ? `주간 ${percentText(weekly.usedPercent)}% 사용 · ${percentText(remainingPercent(weekly))}% 남음${weekly.resetText?.trim() ? ` · 초기화: ${weekly.resetText.trim()}` : ""}`
      : "",
  ].filter(Boolean);
  return [
    error || usage.detail.trim() || "웹 사용량 정보 없음",
    ...windowText,
    usage.checkedAt ? `${usageDate(usage.checkedAt).toLocaleString("ko-KR")} 조회` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function GeminiWebBar({ usage }: { usage: GeminiWebUsage }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const display = error ? undefined : webUsageDisplay(usage);
  const text = webUsageText(usage, error);
  const tip = webUsageTooltip(usage, error);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(undefined);
    try {
      const status = await api.geminiWeb("refresh");
      useStore.setState((s) => ({ usage: { ...s.usage, geminiWeb: status.usage } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Tooltip content={tip}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="usage-bar" data-provider="gemini-web" title={tip}>
        <span className="w-[116px] shrink-0 whitespace-nowrap">
          Gemini 웹 · 계정 1 <span className={cn(display?.warn && "font-semibold text-destructive")}>{display?.window ?? "정보 없음"}</span>
        </span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          {display && <div className={cn("h-full rounded-full", display.warn ? "bg-destructive" : "bg-gemini")} style={{ width: `${display.remaining}%` }} />}
        </div>
        <span className={cn("w-16 truncate text-right tabular-nums", display?.warn && "text-destructive", !display && error && "text-destructive")}>
          {display ? `${percentText(display.remaining)}%` : text}
        </span>
        <button
          type="button"
          aria-label="Gemini 웹 사용량 새로 확인"
          title="Gemini 웹 사용량 새로 확인"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </div>
    </Tooltip>
  );
}

/** Remaining usage: weekly by default, the 5-hour window when it has ≤ 10% left. */
export function UsageBar() {
  const usage = useStore((s) => s.usage);
  useEffect(() => {
    const t = setInterval(() => void api.usage().then((u) => useStore.setState({ usage: u })), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">남은 사용량</div>
      <Bar name="Claude" d={pickUsage(usage.claude)} color="bg-claude" />
      <Bar name="GPT" d={pickUsage(usage.codex)} color="bg-gpt" />
      <Bar name="Gemini CLI" d={pickUsage(usage.gemini)} color="bg-gemini" error={usage.gemini?.error} updatedAt={usage.gemini?.updatedAt} />
      {usage.geminiWeb && <GeminiWebBar usage={usage.geminiWeb} />}
    </div>
  );
}

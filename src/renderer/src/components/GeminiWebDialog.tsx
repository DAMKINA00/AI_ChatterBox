import { useCallback, useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { GeminiWebStatus, GeminiWebUsage } from "../../../shared/types";
import { api, errorMessage } from "../lib/utils";
import { Button, Dialog, DialogContent, DialogFooter, Tooltip } from "./ui";

const STATE_LABEL: Record<GeminiWebStatus["state"], string> = {
  closed: "브라우저 닫힘",
  login_required: "로그인 필요",
  ready: "사용 가능",
  busy: "작업 중",
  error: "오류",
};

const STATE_CLASS: Record<GeminiWebStatus["state"], string> = {
  closed: "bg-muted-foreground/50",
  login_required: "bg-warning",
  ready: "bg-emerald-500",
  busy: "bg-primary animate-pulse",
  error: "bg-destructive",
};

const WEB_DESCRIPTION = "CLI와 별도로 저장된 로그인 세션을 사용하는 Gemini 웹 작업자입니다. 계정 1개와 웹 작업자 1명만 사용하며 글쓰기 작업에만 연결됩니다.";

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

function usageText(usage: GeminiWebUsage): string {
  const { current, weekly } = quotaWindows(usage);
  const exact = usage.status === "error"
    ? []
    : [
        current ? `현재 ${percentText(remainingPercent(current))}% 남음` : "",
        weekly ? `주간 ${percentText(remainingPercent(weekly))}% 남음` : "",
      ].filter(Boolean);
  if (exact.length) return exact.join(" · ");
  if (usage.detail.trim()) return usage.detail;
  if (usage.status === "error") return "조회 실패";
  if (usage.status === "limited") return "사용량 제한";
  if (usage.status === "available") return "사용 가능";
  return "정보 없음";
}

function usageTooltip(usage: GeminiWebUsage): string {
  const checkedAt = usage.checkedAt ? new Date(usage.checkedAt > 1e12 ? usage.checkedAt : usage.checkedAt * 1000) : undefined;
  const { current, weekly } = quotaWindows(usage);
  return [
    usage.detail.trim() || usageText(usage),
    current
      ? `현재 ${percentText(current.usedPercent)}% 사용 · ${percentText(remainingPercent(current))}% 남음${current.resetText?.trim() ? ` · 초기화: ${current.resetText.trim()}` : ""}`
      : "",
    weekly
      ? `주간 ${percentText(weekly.usedPercent)}% 사용 · ${percentText(remainingPercent(weekly))}% 남음${weekly.resetText?.trim() ? ` · 초기화: ${weekly.resetText.trim()}` : ""}`
      : "",
    checkedAt ? `${checkedAt.toLocaleString("ko-KR")} 조회` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function checkedText(ts: number | undefined): string {
  if (!ts) return "확인 시각 없음";
  const date = new Date(ts > 1e12 ? ts : ts * 1000);
  return `${date.toLocaleString("ko-KR")} 확인`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseModel: () => void;
}

export function GeminiWebDialog({ open, onOpenChange, onUseModel }: Props) {
  const [status, setStatus] = useState<GeminiWebStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const query = useCallback(async (action: "status" | "open" | "refresh") => {
    setLoading(true);
    setError(undefined);
    try {
      setStatus(await api.geminiWeb(action));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void query("status");
  }, [open, query]);

  const canUseArgon = !error && (status?.state === "ready" || status?.state === "busy");
  const state = status?.state;
  const stateLabel = state ? STATE_LABEL[state] : "상태 확인 중";
  const tip = status ? usageTooltip(status.usage) : "웹 사용량을 확인하는 중입니다";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Gemini 웹 계정 1" description={WEB_DESCRIPTION} className="w-[min(560px,calc(100vw-32px))]">
        <div className="grid gap-3">
          <div className="rounded-lg border bg-muted/20 p-3 text-[12px] leading-relaxed text-muted-foreground">
            웹 로그인 세션은 CLI 계정과 별도로 저장되며 자격 증명은 이 화면에 표시하지 않습니다. 문장 다듬기·캐릭터 대사·문서 본문 등 글쓰기 전용이고, 로컬 파일 반영은 CLI Claude/GPT가 맡습니다.
          </div>

          <div className="grid gap-2 rounded-lg border p-3" data-testid="gemini-web-status">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <span className={`size-2 rounded-full ${state ? STATE_CLASS[state] : "bg-muted-foreground/50 animate-pulse"}`} />
              <span>{stateLabel}</span>
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">계정 1 · 웹 작업자 1명</span>
            </div>
            <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
              {state === "error" && <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
              <span className="min-w-0 break-words">{error ?? status?.message ?? "웹 계정 상태를 확인하는 중입니다."}</span>
            </div>
            {status?.model && <div className="text-[11px] text-muted-foreground">현재 웹 모델: <span className="font-mono">{status.model}</span></div>}
            {status && <div className="text-[11px] text-muted-foreground">{checkedText(status.checkedAt)}</div>}
          </div>

          {status && (
            <Tooltip content={tip}>
              <div
                className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]"
                data-testid="gemini-web-usage"
                title={tip}
              >
                <Sparkles className="size-3.5 shrink-0 text-gemini" />
                <span className="text-muted-foreground">웹 사용량</span>
                <span className="min-w-0 truncate font-medium">{usageText(status.usage)}</span>
              </div>
            </Tooltip>
          )}

          <DialogFooter className="flex-wrap">
            <Button type="button" variant="outline" onClick={() => void query("refresh")} disabled={loading} data-testid="gemini-web-refresh">
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              새로 확인
            </Button>
            <Button type="button" variant="outline" onClick={() => void query("open")} disabled={loading} data-testid="gemini-web-open">
              {loading ? <Loader2 className="animate-spin" /> : <ExternalLink />}
              {state === "ready" || state === "busy" ? "브라우저 열기" : "로그인/브라우저 열기"}
            </Button>
            <Button type="button" onClick={() => { onUseModel(); onOpenChange(false); }} disabled={!canUseArgon || loading} data-testid="gemini-web-use-argon">
              <Sparkles /> Argon 모델 사용
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

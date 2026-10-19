import { useEffect, useState } from "react";
import { Globe2, RotateCw, Sparkles } from "lucide-react";
import { pickUsage, type UsageDisplay } from "../../../shared/usage";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { Button, Tooltip } from "./ui";
import { GeminiWebDialog } from "./GeminiWebDialog";
import { AIStudioDialog } from "./AIStudioDialog";

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
        <span className="w-[108px] shrink-0 whitespace-nowrap">
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

/** Remaining usage: weekly by default, the 5-hour window when it has ≤ 10% left. */
export function UsageBar() {
  const [webOpen, setWebOpen] = useState(false);
  const [aiStudioOpen, setAiStudioOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const usage = useStore((s) => s.usage);
  useEffect(() => {
    const t = setInterval(() => void api.usage().then((u) => useStore.setState({ usage: u })), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>남은 사용량</span>
        <button type="button" disabled={refreshing} aria-label="CLI 사용량 새로고침" title="로그인한 CLI 계정의 사용량 다시 조회" data-testid="usage-refresh" className="rounded p-1 hover:bg-accent disabled:opacity-50" onClick={async () => {
          setRefreshing(true);
          try { useStore.setState({ usage: await api.usage(true) }); }
          catch (error) { useStore.getState().toast(errorMessage(error)); }
          finally { setRefreshing(false); }
        }}><RotateCw className={cn("size-3", refreshing && "animate-spin")} /></button>
      </div>
      <Bar name="클로드" d={pickUsage(usage.claude)} color="bg-claude" />
      <Bar name="지피티" d={pickUsage(usage.codex)} color="bg-gpt" />
      <Bar name="제미나이" d={pickUsage(usage.gemini)} color="bg-gemini" error={usage.gemini?.error} updatedAt={usage.gemini?.updatedAt} />
      <Bar name="그록" d={pickUsage(usage.grok)} color="bg-grok" error={usage.grok?.error} updatedAt={usage.grok?.updatedAt} />
      <div className="grid gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-7 min-w-0 justify-start text-[11px]" onClick={() => setWebOpen(true)} data-testid="gemini-web-manage"><Globe2 /> <span className="truncate">제미나이 웹 계정 관리</span></Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 min-w-0 justify-start text-[11px]" onClick={() => setAiStudioOpen(true)} data-testid="aistudio-manage"><Sparkles /> <span className="truncate">AI Studio · Argon</span></Button>
      </div>
      <GeminiWebDialog open={webOpen} onOpenChange={setWebOpen} />
      <AIStudioDialog open={aiStudioOpen} onOpenChange={setAiStudioOpen} />
    </div>
  );
}

import { useEffect } from "react";
import { pickUsage, type UsageDisplay } from "../../../shared/usage";
import { api, cn } from "../lib/utils";
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
      <Bar name="Gemini" d={pickUsage(usage.gemini)} color="bg-gemini" error={usage.gemini?.error} updatedAt={usage.gemini?.updatedAt} />
    </div>
  );
}

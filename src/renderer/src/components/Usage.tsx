import { useEffect } from "react";
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

function Bar({ label, pct, tip, color }: { label: string; pct?: number; tip: string; color: string }) {
  const v = pct === undefined ? undefined : Math.max(0, Math.min(100, pct));
  return (
    <Tooltip content={tip}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="usage-bar">
        <span className="w-[72px] shrink-0 whitespace-nowrap">{label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          {v !== undefined && <div className={cn("h-full rounded-full", v >= 90 ? "bg-destructive" : color)} style={{ width: `${v}%` }} />}
        </div>
        <span className="w-8 text-right tabular-nums">{v === undefined ? "–" : `${Math.round(v)}%`}</span>
      </div>
    </Tooltip>
  );
}

/** Rate-limit usage: Claude from stream-json rate_limit_event, Codex from account/rateLimits. */
export function UsageBar() {
  const usage = useStore((s) => s.usage);
  useEffect(() => {
    const t = setInterval(() => void api.usage().then((u) => useStore.setState({ usage: u })), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const claude = usage.claude?.fiveHour;
  const claudePct = claude === undefined ? undefined : claude <= 1 ? claude * 100 : claude;
  return (
    <div className="space-y-1">
      <Bar
        label="Claude 5시간"
        pct={claudePct}
        color="bg-claude"
        tip={claudePct === undefined ? "Claude를 한 번 쓰면 표시됩니다" : `Claude 5시간 사용량 · ${resetText(usage.claude?.resetsAt)}`}
      />
      <Bar
        label="GPT 5시간"
        pct={usage.codex?.primary?.usedPercent}
        color="bg-gpt"
        tip={usage.codex?.primary ? `Codex 5시간 사용량 · ${resetText(usage.codex.primary.resetsAt)}` : "Codex 사용량을 불러오는 중"}
      />
      <Bar
        label="GPT 주간"
        pct={usage.codex?.secondary?.usedPercent}
        color="bg-gpt"
        tip={usage.codex?.secondary ? `Codex 주간 사용량 · ${resetText(usage.codex.secondary.resetsAt)}` : "Codex 사용량을 불러오는 중"}
      />
    </div>
  );
}

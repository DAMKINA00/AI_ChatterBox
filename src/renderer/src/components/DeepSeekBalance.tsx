import { useStore } from "../store";
import { cn } from "../lib/utils";
import { Tooltip } from "./ui";

export function DeepSeekBalance({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  const balance = useStore(s => s.usage.deepseek);
  const ready = balance?.state === "ready";
  const label = balance?.state === "unconfigured" ? "키 미설정" : balance?.state === "error" ? "조회 실패" : "조회 중";
  const time = balance?.updatedAt ? `${new Date(balance.updatedAt).toLocaleString("ko-KR")} 조회` : "";
  const amounts = ready ? balance.balances.map(b => `${b.currency} ${b.total}`).join(" · ") : label;
  const insufficient = ready && balance.isAvailable === false;
  const detail = balance?.error ?? (ready ? balance.balances.map(b => `${b.currency} 충전 ${b.toppedUp} · 지급 ${b.granted}`).join(" / ") : label);
  const usd = ready ? balance.balances.find(b => b.currency === "USD") : undefined;
  const percent = usd ? Math.min(100, Math.max(0, Number(usd.total) * 10)) : 0;
  const gauge = usd && <div role="progressbar" aria-label="딥시크 잔고 $10 기준" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percent.toFixed(1))} aria-valuetext={`USD ${usd.total} / USD 10`} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
    <div className={cn("h-full rounded-full", insufficient ? "bg-destructive" : "bg-deepseek")} style={{ width: `${percent}%` }} />
  </div>;
  if (compact) return (
    <Tooltip content={[detail, usd ? `$10 기준 ${percent.toFixed(1)}%` : "", insufficient ? "API 사용 잔고 부족" : "", time].filter(Boolean).join(" · ")}>
      <button type="button" onClick={onOpen} data-testid="deepseek-balance" className="grid w-full gap-1 rounded py-1 text-[11px] hover:bg-accent">
        <div className="flex items-start justify-between gap-2">
          <span className="shrink-0 text-muted-foreground">딥시크 잔고</span>
          <span className={cn("text-right tabular-nums", (insufficient || balance?.state === "error") && "text-destructive")}>{amounts}</span>
        </div>
        {gauge}
      </button>
    </Tooltip>
  );
  return (
    <div className="grid gap-2 text-[12px]" data-testid="deepseek-balance-details">
      {ready ? <>
        {balance.balances.map(b => <div key={b.currency} className="rounded-md bg-muted/40 p-3">
          <div className="flex justify-between gap-3 font-medium"><span>총 사용 가능</span><span className="tabular-nums">{b.currency} {b.total}</span></div>
          <div className="mt-1 flex justify-between gap-3 text-muted-foreground"><span>충전</span><span className="tabular-nums">{b.currency} {b.toppedUp}</span></div>
          <div className="flex justify-between gap-3 text-muted-foreground"><span>지급</span><span className="tabular-nums">{b.currency} {b.granted}</span></div>
          {b.currency === "USD" && <div className="mt-2 grid gap-1">
            {gauge}
            <div className="flex justify-between text-[11px] text-muted-foreground"><span>$10 기준</span><span>{percent.toFixed(1)}%</span></div>
          </div>}
        </div>)}
        {insufficient && <div className="text-destructive">API 사용 잔고 부족</div>}
      </> : <div className={balance?.state === "error" ? "text-destructive" : "text-muted-foreground"}>{balance?.error ?? label}</div>}
      {time && <div className="text-[11px] text-muted-foreground">{time}</div>}
    </div>
  );
}

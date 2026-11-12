// Read-only usage sheet (D5): the desktop usage panel's view of ChatterBox's accounts, API balance and AI Studio request log.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AIStudioUsageRange, AIStudioUsageStats } from "../../../shared/aistudio";
import type { DeepSeekBalance } from "../../../shared/deepseek";
import { REMOTE_LIMITS, type RemoteAIStudioUsageResponse, type RemoteUsageResponse } from "../../../shared/remote-web";
import { deepSeekBalanceText, type UsageAccountRow } from "../../../shared/usage-view";
import { cn } from "../lib/utils";
import { AuthError, request, url } from "./api";
import { Btn, ErrorLine, errorText, Modal } from "./ui";

const AUTH_LABEL = { authenticated: "로그인됨", required: "로그인 필요", unknown: "확인 안 됨" } as const;
const time = (at: number) => new Date(at < 1e12 ? at * 1000 : at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One account row, the same values as the desktop usage panel (shared/usage-view.ts). */
function Row({ name, row }: { name: string; row: UsageAccountRow }) {
  const d = row.display;
  const extra = [row.authStatus === "required" ? AUTH_LABEL.required : "", row.runningWorkers ? `작업자 ${row.runningWorkers}명` : "", !row.enabled ? "배정 제외(조회 안 함)" : "", row.checkedAt ? `${time(row.checkedAt)} 조회` : ""].filter(Boolean).join(" · ");
  return (
    <div className={cn("grid gap-1", !row.enabled && "opacity-60")} data-testid="remote-usage-row">
      <div className="flex justify-between gap-2 text-[12.5px]">
        <span className="font-medium">{name}</span>
        <span className={cn("text-right text-muted-foreground", (d?.warn || row.error) && "text-warning")}>
          {row.error ? `조회 실패: ${row.error}` : d ? `${d.window} ${Math.round(d.remaining)}% 남음${d.resetsAt ? ` · ${time(d.resetsAt)} 초기화` : ""}` : "정보 없음"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {d && <div className={cn("h-full rounded-full", d.warn ? "bg-warning" : "bg-success")} style={{ width: `${d.remaining}%` }} />}
      </div>
      {extra && <div className="text-[11.5px] text-muted-foreground">{extra}</div>}
    </div>
  );
}

export function UsageSheet({ onClose, onAuthError }: { onClose: () => void; onAuthError: (e: unknown) => void }) {
  const [data, setData] = useState<RemoteUsageResponse>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    setPending(true);
    setError(undefined);
    try { setData(await request<RemoteUsageResponse>(url("/api/usage", undefined, { refresh: refresh ? "1" : "0" }))); }
    catch (e) { if (e instanceof AuthError) onAuthError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  }, [onAuthError]);
  useEffect(() => { void load(false); }, [load]);
  return (
    <Modal title="사용량" onClose={onClose} wide>
      <div className="grid gap-5">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12px] text-muted-foreground">데스크톱 앱에 연결된 계정 그대로입니다(읽기 전용). 새로 고침은 {REMOTE_LIMITS.usageRefreshSeconds}초에 한 번 할 수 있습니다.</p>
          <Btn variant="outline" disabled={pending} onClick={() => void load(true)}><RefreshCw className={cn(pending && "animate-spin")} /> 새로 고침</Btn>
        </div>
        <ErrorLine error={error} />
        {data && <section className="grid gap-3" aria-label="남은 사용량 · 잔고">
          {data.groups.map(g => g.accounts.length === 1
            ? <Row key={g.kind} name={g.name} row={g.accounts[0]} />
            : <div key={g.kind} className="grid gap-2" aria-label={`${g.name} 계정별 잔여량`}>
              <h3 className="text-[12.5px] font-medium">{g.name}</h3>
              <div className="grid gap-2 pl-3">{g.accounts.map(r => <Row key={r.accountId} name={r.label} row={r} />)}</div>
            </div>)}
          {data.deepseek && (
            <div className="flex justify-between gap-2 text-[12.5px]">
              <span className="font-medium">딥시크 잔고</span>
              <span className="text-muted-foreground">{deepSeekBalanceText(data.deepseek as DeepSeekBalance)}</span>
            </div>
          )}
        </section>}
        <AIStudioReport onAuthError={onAuthError} />
      </div>
    </Modal>
  );
}

const RANGES: [AIStudioUsageRange, string][] = [["24h", "24시간"], ["7d", "7일"], ["30d", "30일"]];
const n = (v: number) => v.toLocaleString("ko-KR");
const statLine = (s: AIStudioUsageStats) => `요청 ${n(s.requests)} (성공 ${n(s.succeeded)} · 실패 ${n(s.failed)} · 한도 ${n(s.rateLimited)}) · 토큰 ${n(s.totalTokens)}`;

function AIStudioReport({ onAuthError }: { onAuthError: (e: unknown) => void }) {
  const [range, setRange] = useState<AIStudioUsageRange>("24h");
  const [report, setReport] = useState<RemoteAIStudioUsageResponse["report"]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    request<RemoteAIStudioUsageResponse>(url("/api/aistudio/usage", undefined, { range }))
      .then(r => { if (alive) setReport(r.report); })
      .catch(e => { if (e instanceof AuthError) onAuthError(e); else if (alive) { setReport(undefined); setError(errorText(e)); } });
    return () => { alive = false; };
  }, [range, onAuthError]);
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[13px] font-medium">AI Studio 사용 기록</h3>
        <div role="group" aria-label="기간" className="flex gap-1">
          {RANGES.map(([r, label]) => <Btn key={r} variant={r === range ? "default" : "outline"} className="min-h-8 px-2 text-[12px]" aria-pressed={r === range} onClick={() => setRange(r)}>{label}</Btn>)}
        </div>
      </div>
      <ErrorLine error={error} />
      {report && <>
        <div className="text-[12.5px]">{statLine(report.totals)}</div>
        {(["model", "account"] as const).map(g => report.groups[g].length > 0 && (
          <details key={g} className="text-[12.5px]">
            <summary className="cursor-pointer text-muted-foreground">{g === "model" ? "모델별" : "계정별"} {report.groups[g].length}개</summary>
            <ul className="mt-1 grid gap-1">{report.groups[g].map(s => <li key={s.key}><span className="font-medium">{s.key}</span> · {statLine(s)}</li>)}</ul>
          </details>
        ))}
      </>}
    </section>
  );
}

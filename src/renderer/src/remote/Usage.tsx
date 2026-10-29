// Read-only usage sheet (D5): subscription limits, API balance, CLI accounts and AI Studio request log.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AIStudioUsageRange, AIStudioUsageStats } from "../../../shared/aistudio";
import { REMOTE_LIMITS, type RemoteAIStudioUsageResponse, type RemoteCliAccount, type RemoteUsageResponse } from "../../../shared/remote-web";
import { pickUsage, type ProviderUsage } from "../../../shared/usage";
import { cn } from "../lib/utils";
import { AuthError, request, url } from "./api";
import { Btn, ErrorLine, errorText, Modal } from "./ui";

const PROVIDERS = [["claude", "클로드"], ["codex", "지피티"], ["gemini", "제미나이"], ["grok", "그록"]] as const;
const ACCOUNT_KIND = { claude: "클로드", gpt: "지피티", grok: "그록" } as const;
const AUTH_LABEL = { authenticated: "로그인됨", required: "로그인 필요", unknown: "확인 안 됨" } as const;
const resetText = (at?: number | null) => {
  if (!at) return "";
  const ms = at < 1e12 ? at * 1000 : at;
  return ` · ${new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 초기화`;
};

function Bar({ name, usage }: { name: string; usage?: ProviderUsage }) {
  const d = usage?.error ? null : pickUsage(usage);
  return (
    <div className="grid gap-1">
      <div className="flex justify-between gap-2 text-[12.5px]">
        <span className="font-medium">{name}</span>
        <span className={cn("text-muted-foreground", d?.warn && "text-warning")}>{d ? `${d.window} ${Math.round(d.remaining)}% 남음${resetText(d.resetsAt)}` : usage?.error ?? "정보 없음"}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {d && <div className={cn("h-full rounded-full", d.warn ? "bg-warning" : "bg-success")} style={{ width: `${d.remaining}%` }} />}
      </div>
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
  const usage = data?.usage;
  return (
    <Modal title="사용량" onClose={onClose} wide>
      <div className="grid gap-5">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12px] text-muted-foreground">읽기 전용입니다. 새로 고침은 {REMOTE_LIMITS.usageRefreshSeconds}초에 한 번 할 수 있습니다.</p>
          <Btn variant="outline" disabled={pending} onClick={() => void load(true)}><RefreshCw className={cn(pending && "animate-spin")} /> 새로 고침</Btn>
        </div>
        <ErrorLine error={error} />
        {usage && <section className="grid gap-3">
          {PROVIDERS.map(([key, name]) => <Bar key={key} name={name} usage={usage[key]} />)}
          {usage.geminiWeb && <div className="flex justify-between gap-2 text-[12.5px]"><span className="font-medium">제미나이 웹</span><span className="text-muted-foreground">{usage.geminiWeb.detail || usage.geminiWeb.status}</span></div>}
          {usage.deepseek && usage.deepseek.state !== "unconfigured" && (
            <div className="flex justify-between gap-2 text-[12.5px]">
              <span className="font-medium">딥시크 잔고</span>
              <span className="text-muted-foreground">{usage.deepseek.error ?? (usage.deepseek.balances.map(b => `${b.total} ${b.currency}`).join(" · ") || "정보 없음")}</span>
            </div>
          )}
        </section>}
        {data && data.accounts.length > 0 && <Accounts accounts={data.accounts} usage={data.usage} />}
        <AIStudioReport onAuthError={onAuthError} />
      </div>
    </Modal>
  );
}

function Accounts({ accounts, usage }: { accounts: RemoteCliAccount[]; usage: RemoteUsageResponse["usage"] }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-[13px] font-medium">CLI 계정</h3>
      <ul className="grid gap-2">
        {accounts.map(a => (
          <li key={a.accountId} className={cn("grid gap-1 rounded-md border px-3 py-2", !a.enabled && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
              <span className="font-medium">{ACCOUNT_KIND[a.kind]} · {a.label}</span>
              {a.isDefault && <span className="rounded border px-1 text-[11px]">기본</span>}
              {!a.enabled && <span className="text-[11px] text-muted-foreground">배정 제외</span>}
              <span className={cn("ml-auto text-[11.5px]", a.authStatus === "required" ? "text-destructive" : "text-muted-foreground")}>{AUTH_LABEL[a.authStatus]}{a.runningWorkers ? ` · 작업자 ${a.runningWorkers}명` : ""}</span>
            </div>
            {usage.accounts?.[a.accountId] ? <Bar name="잔여" usage={usage.accounts[a.accountId]} />
              : a.remainingPercent !== undefined && <div className="text-[12px] text-muted-foreground">잔여 {Math.round(a.remainingPercent)}%</div>}
          </li>
        ))}
      </ul>
    </section>
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

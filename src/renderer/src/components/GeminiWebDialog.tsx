import { useCallback, useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, Plus, RefreshCw, Sparkles } from "lucide-react";
import type { GeminiWebAccountId, GeminiWebAccountStatus, GeminiWebStatus, GeminiWebUsage } from "../../../shared/types";
import { api, errorMessage } from "../lib/utils";
import { Button, Dialog, DialogContent, DialogFooter, Input, Tooltip } from "./ui";

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

const WEB_DESCRIPTION = "최대 10개 계정의 로그인을 분리해 관리합니다. 이전 계정에 잔여량이 충분하면 이어서 배정합니다. 잔여량이 10% 이하이거나 작업 중이면 쉬고 있는 계정 중 가장 여유 있는 계정에 맥락과 초안을 인계합니다. 모두 작업 중이거나 한도가 부족하면 대기하며 주기적으로 다시 확인합니다.";

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
  onUseModel?: () => void;
}

function AccountCard({ account, pending, update, query }: {
  account: GeminiWebAccountStatus;
  pending: boolean;
  update: (id: GeminiWebAccountId, patch: { label?: string; enabled?: boolean }) => void;
  query: (id: GeminiWebAccountId, action: "open" | "refresh") => void;
}) {
  const [label, setLabel] = useState(account.label);
  useEffect(() => setLabel(account.label), [account.label]);
  const tip = usageTooltip(account.usage);
  const windows = quotaWindows(account.usage);
  const busy = account.state === "busy";
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" data-testid="gemini-web-account" data-account-id={account.accountId}>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${STATE_CLASS[account.state]}`} />
        <span className="text-[12px] font-medium">계정 {account.accountId.slice(7)} · {STATE_LABEL[account.state]}</span>
        <label className="ml-auto flex items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={account.enabled} disabled={pending || busy} aria-label={`계정 ${account.accountId.slice(7)} 자동 배정`} onChange={e => update(account.accountId, { enabled: e.target.checked })} />
          자동 배정
        </label>
      </div>
      <div className="flex gap-2">
        <Input value={label} onChange={e => setLabel(e.target.value)} maxLength={60} aria-label={`계정 ${account.accountId.slice(7)} 이름`} />
        <Button type="button" size="sm" variant="outline" disabled={pending || !label.trim() || label.trim() === account.label} onClick={() => update(account.accountId, { label: label.trim() })}>저장</Button>
      </div>
      <Tooltip content={tip}>
        <div className="grid gap-2 text-[12px]" title={tip} data-testid="gemini-web-account-usage">
          {account.usage.status !== "error" && Object.entries(windows).filter(([, value]) => !!value).map(([key, value]) => (
            <div className="flex items-center gap-2" key={key}>
              <span className="w-8 text-muted-foreground">{key === "current" ? "현재" : "주간"}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className={remainingPercent(value!) <= 10 ? "h-full bg-destructive" : "h-full bg-gemini"} style={{ width: `${remainingPercent(value!)}%` }} /></div>
              <span className="w-20 text-right tabular-nums">{percentText(remainingPercent(value!))}% 남음</span>
            </div>
          ))}
          <span className="text-muted-foreground">{usageText(account.usage)}</span>
          <span className="text-[11px] text-muted-foreground">{checkedText(account.usage.checkedAt)}</span>
        </div>
      </Tooltip>
      <p className="min-h-8 text-[12px] text-muted-foreground">{account.message}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => query(account.accountId, "open")}><ExternalLink /> 로그인 / 브라우저</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => query(account.accountId, "refresh")}><RefreshCw /> 사용량 확인</Button>
      </div>
    </section>
  );
}

export function GeminiWebDialog({ open, onOpenChange, onUseModel }: Props) {
  const [accounts, setAccounts] = useState<GeminiWebAccountStatus[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => setAccounts(await api.geminiWebAccounts("list")), []);
  useEffect(() => {
    if (!open) return;
    void reload().catch(e => setError(errorMessage(e)));
    const timer = setInterval(() => void reload().catch(e => setError(errorMessage(e))), 3000);
    return () => clearInterval(timer);
  }, [open, reload]);
  const manage = async (action: "add" | "update", input?: { accountId?: GeminiWebAccountId; label?: string; enabled?: boolean }) => {
    setPending(true); setError(undefined);
    try { setAccounts(await api.geminiWebAccounts(action, input)); }
    catch (e) { setError(errorMessage(e)); }
    finally { setPending(false); }
  };
  const query = async (id: GeminiWebAccountId, action: "open" | "refresh") => {
    setPending(true); setError(undefined);
    try { await api.geminiWeb(action, id); await reload(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setPending(false); }
  };
  const canUse = accounts.some(a => a.enabled && a.state !== "login_required" && a.state !== "error" && a.usage.status !== "limited" && a.remainingPercent !== 0
    && (a.state === "ready" || a.state === "busy" || (a.usage.status === "available" && (a.remainingPercent ?? 0) > 0)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Gemini 웹 계정 관리" description={WEB_DESCRIPTION} className="w-[min(920px,calc(100vw-32px))]">
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-muted-foreground">등록 {accounts.length}/10 · 계정마다 한 작업씩 배정합니다.</span>
          <Button className="ml-auto" type="button" variant="outline" disabled={pending || accounts.length >= 10} onClick={() => void manage("add")} data-testid="gemini-web-add-account"><Plus /> 계정 추가</Button>
        </div>
        {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/50 p-3 text-[12px] text-destructive"><CircleAlert className="size-4 shrink-0" />{error}</div>}
        <div className="grid max-h-[58vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2" data-testid="gemini-web-accounts">
          {accounts.map(account => <AccountCard key={account.accountId} account={account} pending={pending} update={(id, patch) => void manage("update", { accountId: id, ...patch })} query={(id, action) => void query(id, action)} />)}
          {!accounts.length && <p className="text-[12px] text-muted-foreground">계정을 불러오는 중입니다.</p>}
        </div>
        <DialogFooter>
          {pending && <Loader2 className="mr-auto size-4 animate-spin" aria-label="계정 처리 중" />}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>닫기</Button>
          {onUseModel && <Button type="button" onClick={() => { onUseModel(); onOpenChange(false); }} disabled={!canUse || pending} data-testid="gemini-web-use-argon"><Sparkles /> Argon 자동 배정 사용</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

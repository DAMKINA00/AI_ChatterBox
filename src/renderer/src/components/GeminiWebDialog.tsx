import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, LogOut, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type { AIStudioAccount, AIStudioCooldown, AIStudioStatus } from "../../../shared/aistudio";
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

const WEB_DESCRIPTION = "최대 10개 계정의 로그인을 분리해 관리합니다. 마스터가 전체 계정의 잔여량·조회 시각·작업 상태를 직접 보고 계정을 지정해 작업자를 생성합니다. 이전 계정에 잔여량이 충분하면 이어서 배정합니다. 잔여량이 10% 이하이거나 작업 중이면 쉬고 있는 계정 중 가장 여유 있는 계정에 맥락과 초안을 인계합니다. 모두 작업 중이거나 한도가 부족하면 대기하며 주기적으로 다시 확인합니다.";

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

type AIStudioWebLink = NonNullable<AIStudioStatus["webLinks"]>[string];

function aiStudioLink(status: AIStudioStatus | undefined, accountId: GeminiWebAccountId): AIStudioWebLink | undefined {
  return status?.webLinks?.[accountId];
}

function aiStudioAccount(status: AIStudioStatus | undefined, link: AIStudioWebLink | undefined): AIStudioAccount | undefined {
  return link?.accountId ? status?.accounts.find(account => account.id === link.accountId) : undefined;
}

function aiStudioCooldowns(status: AIStudioStatus | undefined, account: AIStudioAccount | undefined): AIStudioCooldown[] {
  if (!account || !status) return [];
  return status.cooldowns.filter(cooldown => cooldown.account_id === account.id);
}

function cooldownResetText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ko-KR");
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseModel?: () => void;
}

type LoginFeedback = "pending" | "complete";
type DisconnectAction = "logout" | "remove";

function AccountCard({ account, pending, loginFeedback, update, query, aiStudioStatus, aiStudioPending, syncAIStudio, disconnect }: {
  account: GeminiWebAccountStatus;
  pending: boolean;
  loginFeedback?: LoginFeedback;
  update: (id: GeminiWebAccountId, patch: { label?: string; enabled?: boolean }) => void;
  query: (id: GeminiWebAccountId, action: "login" | "open" | "refresh") => void;
  aiStudioStatus?: AIStudioStatus;
  aiStudioPending: boolean;
  syncAIStudio: (id: GeminiWebAccountId) => void;
  disconnect: (id: GeminiWebAccountId, action: DisconnectAction) => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [confirmAction, setConfirmAction] = useState<DisconnectAction>();
  useEffect(() => setLabel(account.label), [account.label]);
  const tip = usageTooltip(account.usage);
  const windows = quotaWindows(account.usage);
  const busy = account.state === "busy";
  const browserAction = account.state === "ready" || account.state === "busy" ? "open" : "login";
  const showLoginFeedback = loginFeedback === "complete"
    ? account.state === "ready" || account.state === "busy"
    : loginFeedback === "pending" && (pending || (account.state !== "closed" && account.state !== "error"));
  const studioLink = aiStudioLink(aiStudioStatus, account.accountId);
  const studioAccount = aiStudioAccount(aiStudioStatus, studioLink);
  const cooldowns = aiStudioCooldowns(aiStudioStatus, studioAccount);
  const argonAvailable = studioAccount && aiStudioStatus
    ? studioAccount.models.includes(aiStudioStatus.settings.model)
    : undefined;
  const studioBusy = !!studioAccount && /busy|running/i.test(studioAccount.state);
  const disconnectDisabled = pending || aiStudioPending || busy || studioBusy;
  const studioStateText = studioLink?.state === "connected" ? "연결됨" : studioLink?.state === "error" ? "오류" : "연결되지 않음";
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" data-testid="gemini-web-account" data-account-id={account.accountId}>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${STATE_CLASS[account.state]}`} />
        <span className="text-[12px] font-medium">계정 {account.accountId.slice(7)} · {STATE_LABEL[account.state]}</span>
        <label className="ml-auto flex items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={account.enabled} disabled={pending || busy} aria-label={`계정 ${account.accountId.slice(7)} 마스터 배정`} onChange={e => update(account.accountId, { enabled: e.target.checked })} />
          마스터 배정
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
      <section className="grid gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3" data-testid="aistudio-link">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-[12px] font-medium">AI Studio · Argon</span>
          <span className={studioLink?.state === "connected" ? "text-[11px] text-emerald-500" : studioLink?.state === "error" ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"} data-testid="aistudio-sync-state">{studioStateText}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ml-auto"
            disabled={pending || aiStudioPending || studioBusy}
            onClick={() => syncAIStudio(account.accountId)}
            title="현재 Gemini Web 로그인 세션으로 연결합니다. 필요하면 AI Studio 동의 탭이 열립니다."
            data-testid="aistudio-sync"
          >
            <Sparkles /> {studioLink?.state === "connected" ? "다시 동기화" : "연결"}
          </Button>
        </div>
        <p className="text-[11.5px] text-muted-foreground" data-testid="aistudio-sync-message">
          {studioLink?.message ?? "현재 웹 로그인 세션을 사용해 명시적으로 연결하세요. 필요하면 AI Studio 동의 탭이 열립니다."}
          {studioLink?.checkedAt ? ` · ${checkedText(studioLink.checkedAt)}` : ""}
        </p>
        {studioAccount ? (
          <div className="grid gap-1 text-[11.5px] text-muted-foreground" data-testid="aistudio-account-info">
            <span>연결된 계정: {studioAccount.label || studioAccount.id} · 등급 {studioAccount.benefit_tier || "정보 없음"} · 상태 {studioAccount.state || "정보 없음"}</span>
            <span className={argonAvailable === true ? "text-emerald-500" : argonAvailable === false ? "text-destructive" : "text-muted-foreground"}>Argon 사용 가능: {argonAvailable === undefined ? "알 수 없음" : argonAvailable ? "예" : "아니요"}</span>
            <div className="grid gap-1" data-testid="aistudio-cooldowns">
              {cooldowns.length ? cooldowns.map(cooldown => (
                <span key={`${cooldown.model_id}:${cooldown.channel}:${cooldown.until}`}>
                  쿨다운: {cooldown.model_id} · {cooldown.channel} · {cooldownResetText(cooldown.until)} 초기화{cooldown.reason ? ` · ${cooldown.reason}` : ""}
                </span>
              )) : <span>쿨다운 없음</span>}
            </div>
          </div>
        ) : (
          <span className="text-[11.5px] text-muted-foreground">연결 후 AI Studio 계정 등급·상태·Argon 가능 여부와 쿨다운을 표시합니다.</span>
        )}
        {aiStudioStatus?.error && <span className="text-[11.5px] text-destructive" data-testid="aistudio-status-error">AI Studio 상태: {aiStudioStatus.error}</span>}
      </section>
      <p className="min-h-8 text-[12px] text-muted-foreground">{account.message}</p>
      {showLoginFeedback && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground" data-testid="gemini-web-login-feedback" role="status" aria-live="polite">
          {loginFeedback === "pending" ? "로그인 진행 중" : "로그인 완료"}
        </div>
      )}
      {confirmAction && (
        <div className="grid gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-[12px]" data-testid="gemini-web-disconnect-confirm" role="alert">
          <p>{confirmAction === "logout"
            ? "로그아웃하면 슬롯은 유지되고 Google 로그인과 연결된 AI Studio 세션이 해제됩니다."
            : "슬롯을 삭제하면 이 슬롯이 목록에서 제거되어 새 계정을 추가할 수 있습니다."}</p>
          <p className="text-muted-foreground">이 앱의 로그인 정보와 연결된 AI Studio 계정 등록을 정리합니다. Google 계정과 대화 기록은 삭제하지 않습니다.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant={confirmAction === "remove" ? "destructive" : "default"}
              disabled={disconnectDisabled}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(undefined);
                disconnect(account.accountId, action);
              }}
              data-testid={`gemini-web-confirm-${confirmAction}`}
            >
              {confirmAction === "logout" ? "로그아웃 확인" : "슬롯 삭제 확인"}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setConfirmAction(undefined)} data-testid="gemini-web-disconnect-cancel">취소</Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => query(account.accountId, browserAction)} data-testid="gemini-web-login"><ExternalLink /> 로그인 / 브라우저</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => query(account.accountId, "refresh")}><RefreshCw /> 사용량 확인</Button>
        <Button type="button" size="sm" variant="outline" disabled={disconnectDisabled} onClick={() => setConfirmAction("logout")} data-testid="gemini-web-logout"><LogOut /> 로그아웃</Button>
        <Button type="button" size="sm" variant="destructive" disabled={disconnectDisabled} onClick={() => setConfirmAction("remove")} data-testid="gemini-web-remove"><Trash2 /> 슬롯 삭제</Button>
      </div>
    </section>
  );
}

export function GeminiWebDialog({ open, onOpenChange, onUseModel }: Props) {
  const [accounts, setAccounts] = useState<GeminiWebAccountStatus[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingAccounts, setPendingAccounts] = useState<Set<GeminiWebAccountId>>(() => new Set());
  const [loginFeedback, setLoginFeedback] = useState<Partial<Record<GeminiWebAccountId, LoginFeedback>>>({});
  const [error, setError] = useState<string>();
  const [aiStudioStatus, setAIStudioStatus] = useState<AIStudioStatus>();
  const [aiStudioError, setAIStudioError] = useState<string>();
  const [aiStudioPending, setAIStudioPending] = useState<Set<GeminiWebAccountId>>(() => new Set());
  const listRequestInFlight = useRef<Promise<GeminiWebAccountStatus[]> | undefined>(undefined);
  const aiStudioRequestInFlight = useRef(false);
  const reload = useCallback(async (force = false) => {
    const current = listRequestInFlight.current;
    if (current) {
      const result = await current;
      if (!force) return result;
    }
    const request = api.geminiWebAccounts("list");
    listRequestInFlight.current = request;
    try {
      const next = await request;
      setAccounts(next);
      setAccountsLoaded(true);
      return next;
    } finally {
      if (listRequestInFlight.current === request) listRequestInFlight.current = undefined;
    }
  }, []);
  const refreshAIStudioStatus = useCallback(async () => {
    try {
      const status = await api.aiStudio("status");
      setAIStudioStatus(status);
      setAIStudioError(status.error);
      return status;
    } catch (e) {
      setAIStudioError(errorMessage(e));
      throw e;
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () => {
      if (active) void reload().catch(e => setError(errorMessage(e)));
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, reload]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      if (!active || aiStudioRequestInFlight.current) return;
      aiStudioRequestInFlight.current = true;
      try {
        await refreshAIStudioStatus();
      } catch {
        // The status banner carries the current error.
      } finally {
        aiStudioRequestInFlight.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, refreshAIStudioStatus]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const unsubscribe = api.onGeminiWebLogin(status => {
      if (!active) return;
      setAccounts(current => current.map(account => account.accountId === status.accountId ? { ...account, ...status } : account));
      if (status.state === "ready" || status.state === "busy") {
        setLoginFeedback(current => ({ ...current, [status.accountId]: "complete" }));
        setPendingAccounts(current => {
          const next = new Set(current);
          next.delete(status.accountId);
          return next;
        });
      }
      void reload().catch(e => setError(errorMessage(e)));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open, reload]);
  const manage = async (action: "add" | "update" | "logout" | "remove", input?: { accountId?: GeminiWebAccountId; label?: string; enabled?: boolean }) => {
    const accountId = input?.accountId;
    if (accountId) setPendingAccounts(current => new Set(current).add(accountId));
    setPending(true); setError(undefined);
    try {
      const next = await api.geminiWebAccounts(action, input);
      setAccounts(next);
      setAccountsLoaded(true);
      if (action === "logout" || action === "remove") {
        if (accountId) setLoginFeedback(current => {
          const next = { ...current };
          delete next[accountId];
          return next;
        });
        await reload(true).catch(e => setError(errorMessage(e)));
        await refreshAIStudioStatus().catch(() => undefined);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
      if (accountId) setPendingAccounts(current => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
    }
  };
  const query = async (id: GeminiWebAccountId, action: "login" | "open" | "refresh") => {
    setPendingAccounts(current => new Set(current).add(id));
    setError(undefined);
    if (action === "login") setLoginFeedback(current => ({ ...current, [id]: "pending" }));
    try {
      const status = await api.geminiWeb(action, id);
      setAccounts(current => current.map(account => account.accountId === status.accountId ? { ...account, ...status } : account));
      if (action === "login" && (status.state === "ready" || status.state === "busy")) setLoginFeedback(current => ({ ...current, [id]: "complete" }));
      await reload();
    }
    catch (e) {
      setError(errorMessage(e));
      if (action === "login") setLoginFeedback(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
    finally {
      setPendingAccounts(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const syncAIStudio = async (id: GeminiWebAccountId) => {
    if (aiStudioRequestInFlight.current) return;
    setAIStudioPending(current => new Set(current).add(id));
    setAIStudioError(undefined);
    aiStudioRequestInFlight.current = true;
    try {
      const status = await api.aiStudio("sync-web", { accountId: id });
      setAIStudioStatus(status);
      setAIStudioError(status.error);
      await reload().catch(e => setError(errorMessage(e)));
    } catch (e) {
      setAIStudioError(errorMessage(e));
    } finally {
      aiStudioRequestInFlight.current = false;
      setAIStudioPending(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const canUse = accounts.some(a => a.enabled && a.state !== "login_required" && a.state !== "error" && a.usage.status !== "limited" && a.remainingPercent !== 0
    && (a.state === "ready" || a.state === "busy" || (a.usage.status === "available" && (a.remainingPercent ?? 0) > 0)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="제미나이 웹 계정 관리" description={WEB_DESCRIPTION} className="w-[min(920px,calc(100vw-32px))]">
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-muted-foreground">등록 {accounts.length}/10 · 계정마다 한 작업씩 배정합니다.</span>
          <Button className="ml-auto" type="button" variant="outline" disabled={pending || accounts.length >= 10} onClick={() => void manage("add")} data-testid="gemini-web-add-account"><Plus /> 계정 추가</Button>
        </div>
        {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/50 p-3 text-[12px] text-destructive"><CircleAlert className="size-4 shrink-0" />{error}</div>}
        {(aiStudioError || aiStudioStatus?.error) && <div role="status" className="flex gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[12px] text-muted-foreground" data-testid="aistudio-status-error"><Sparkles className="size-4 shrink-0 text-primary" />AI Studio 상태를 확인하지 못했습니다: {aiStudioError ?? aiStudioStatus?.error}</div>}
        <div className="grid max-h-[58vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2" data-testid="gemini-web-accounts">
          {accounts.map(account => <AccountCard
            key={account.accountId}
            account={account}
            pending={pending || pendingAccounts.has(account.accountId)}
            loginFeedback={loginFeedback[account.accountId]}
            update={(id, patch) => void manage("update", { accountId: id, ...patch })}
            query={(id, action) => void query(id, action)}
            aiStudioStatus={aiStudioStatus}
            aiStudioPending={aiStudioPending.has(account.accountId)}
            syncAIStudio={(id) => void syncAIStudio(id)}
            disconnect={(id, action) => void manage(action, { accountId: id })}
          />)}
          {!accountsLoaded && <p className="text-[12px] text-muted-foreground">계정을 불러오는 중입니다.</p>}
          {accountsLoaded && !accounts.length && <p className="text-[12px] text-muted-foreground">등록된 계정이 없습니다. 계정 추가로 슬롯을 만드세요.</p>}
        </div>
        <DialogFooter>
          {pending && <Loader2 className="mr-auto size-4 animate-spin" aria-label="계정 처리 중" />}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>닫기</Button>
          {onUseModel && <Button type="button" onClick={() => { onUseModel(); onOpenChange(false); }} disabled={!canUse || pending} data-testid="gemini-web-use-argon"><Sparkles /> Argon 마스터 배정 사용</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

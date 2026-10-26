import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, LogOut, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { CliAccountStatus, CliAccountPolicies } from "../../../shared/types";
import { api, errorMessage } from "../lib/utils";
import { CLI_KINDS, CLI_KIND_LABEL, cliCheckedText, cliRemaining, type CliKind } from "../lib/cli-accounts-ui";
import { useStore } from "../store";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input } from "./ui";
import { CliAccountPolicyField } from "./CliAccountPolicyField";

export function CliAccountCard({ account, pending, update, run }: {
  account: CliAccountStatus;
  pending: boolean;
  update: (patch: { label?: string; enabled?: boolean }) => void;
  run: (action: "login" | "logout" | "refresh" | "remove") => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [confirm, setConfirm] = useState<"logout" | "remove">();
  useEffect(() => setLabel(account.label), [account.label]);
  const busy = account.runningWorkers > 0;
  return (
    <section className="grid content-start gap-3 rounded-xl border bg-card p-4" data-testid="cli-account" data-account-id={account.accountId} aria-label={account.label}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-medium">{account.accountId}</span>
        {account.isDefault && <Badge>기본</Badge>}
        <label className="ml-auto flex items-center gap-1.5">
          <input type="checkbox" checked={account.enabled} disabled={pending || busy || account.isDefault} aria-label={`${account.accountId} 배정 사용`} onChange={event => update({ enabled: event.target.checked })} />
          배정 {account.enabled ? "사용" : "제외"}
        </label>
      </div>
      <div className="flex gap-2">
        <Input value={label} maxLength={60} disabled={pending} aria-label={`${account.accountId} 이름`} onChange={event => setLabel(event.target.value)} />
        <Button type="button" size="sm" variant="outline" disabled={pending || !label.trim() || label.trim() === account.label} onClick={() => update({ label: label.trim() })}>이름 저장</Button>
      </div>
      <p className="break-all text-[12px]" data-testid="cli-account-auth">
        {account.authStatus === "authenticated" ? "로그인됨" : account.authStatus === "required" ? "로그인 필요" : "로그인 상태 미확인"}
        {account.auth?.email ? ` · ${account.auth?.email}` : ""}
      </p>
      {account.authStatus === "unknown" && <p className="text-[11.5px] text-muted-foreground">로그인 창에서 로그인을 마친 뒤 상태 새로고침을 눌러주세요.</p>}
      <div className="grid gap-2 text-[12px]" data-testid="cli-account-usage">
        {(["fiveHour", "weekly"] as const).map(key => {
          const remaining = account.usage?.error ? undefined : cliRemaining(account.usage?.[key]);
          return <div key={key} className="flex items-center gap-2">
            <span className="w-10 text-muted-foreground">{key === "fiveHour" ? "5시간" : "주간"}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${account.accountId} ${key === "fiveHour" ? "5시간" : "주간"} 잔여량`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={remaining === undefined ? "정보 없음" : `${Math.round(remaining)}% 남음`}>
              {remaining !== undefined && <div className={remaining <= 10 ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${remaining}%` }} />}
            </div>
            <span className="w-20 text-right tabular-nums">{remaining === undefined ? "정보 없음" : `${Math.round(remaining)}% 남음`}</span>
          </div>;
        })}
        {account.usage?.error && <span className="text-destructive">{account.usage.error}</span>}
        <span className="text-[11px] text-muted-foreground">{cliCheckedText(account.usage?.checkedAt ?? account.auth?.checkedAt)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        배분 참고 잔여량: {account.remainingPercent === undefined ? "미확인" : `${Math.round(account.remainingPercent)}%`} · 실행 중 {account.runningWorkers}명
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={() => run("login")}><ExternalLink /> 로그인</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run("refresh")}><RefreshCw /> 상태 새로고침</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={() => setConfirm("logout")}><LogOut /> 로그아웃</Button>
        <Button type="button" size="sm" variant="destructive" disabled={pending || busy || account.isDefault} onClick={() => setConfirm("remove")} title={account.isDefault ? "기본 계정은 삭제할 수 없습니다" : undefined}><Trash2 /> 삭제</Button>
      </div>
      <Dialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(undefined); }}>
        <DialogContent title={confirm === "remove" ? "CLI 계정 삭제" : "CLI 계정 로그아웃"} description={`${account.label} (${account.accountId})`}>
          <p className="text-[13px]">{confirm === "remove" ? "이 계정과 저장된 로그인 정보를 삭제하시겠습니까?" : "이 계정에서 로그아웃하시겠습니까? 다시 사용하려면 로그인해야 합니다."}</p>
          {confirm === "logout" && account.isDefault && <p role="alert" className="text-[13px] text-destructive">평소 터미널에서 쓰는 기본 CLI 로그인(~/.claude, ~/.codex, ~/.grok)도 함께 끊깁니다.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirm(undefined)}>취소</Button>
            <Button type="button" variant="destructive" disabled={pending || busy || (confirm === "remove" && account.isDefault)} onClick={() => { if (confirm) run(confirm); setConfirm(undefined); }}>{confirm === "remove" ? "삭제 확인" : "로그아웃 확인"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function CliAccountsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [kind, setKind] = useState<CliKind>("claude");
  const [accounts, setAccounts] = useState<CliAccountStatus[]>([]);
  const [policy, setPolicy] = useState<CliAccountPolicies>({});
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const inFlight = useRef(false);
  const reload = useCallback(async () => {
    const [nextAccounts, nextPolicy] = await Promise.all([api.cliAccounts.list(), api.cliAccounts.getPolicy()]);
    setAccounts(nextAccounts);
    useStore.setState({ cliAccounts: nextAccounts });
    setPolicy(nextPolicy);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setNotice(undefined);
    setLoaded(false);
    void reload().catch(error => setError(errorMessage(error)));
  }, [open, reload]);
  const manage = async (action: () => Promise<unknown>, success?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      if (success) setNotice(success);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      try { await reload(); } catch (error) { setError(errorMessage(error)); }
      void api.usage().then(usage => useStore.setState({ usage })).catch(() => undefined);
      inFlight.current = false;
      setPending(false);
    }
  };
  const list = accounts.filter(account => account.kind === kind);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="CLI 계정 관리" description="계열별로 최대 10개 계정을 관리합니다. 새 계정을 만든 뒤 로그인하고, 콘솔에서 로그인을 마치면 상태를 새로고침하세요." className="w-[min(920px,calc(100vw-32px))]" data-testid="cli-accounts-dialog">
        <div className="flex gap-2" role="group" aria-label="CLI 계열">
          {CLI_KINDS.map(value => <Button key={value} type="button" variant={value === kind ? "default" : "outline"} aria-pressed={value === kind} disabled={pending} onClick={() => { setKind(value); setNotice(undefined); }}>{CLI_KIND_LABEL[value]}</Button>)}
        </div>
        {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/50 p-3 text-[12px] text-destructive"><CircleAlert className="size-4 shrink-0" />{error}</div>}
        {notice && <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-[12px]">{notice}</p>}
        <section className="grid gap-2 rounded-lg border p-3">
          <h3 className="text-[12px] font-medium">앱 전역 계정 선택 · {CLI_KIND_LABEL[kind]}</h3>
          <CliAccountPolicyField kind={kind} accounts={accounts} value={policy[kind]} disabled={pending || !loaded} onChange={value => { if (value) void manage(() => api.cliAccounts.setPolicy({ ...policy, [kind]: value })); }} />
        </section>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">등록 {list.length}/10</span>
          <Button className="ml-auto" type="button" variant="outline" disabled={pending || !loaded || list.length >= 10} onClick={() => void manage(() => api.cliAccounts.create(kind), "새 계정을 만들었습니다. 로그인 버튼으로 새 콘솔을 열어주세요.")} data-testid="cli-account-create"><Plus /> 새 계정 만들기</Button>
        </div>
        <p className="text-[11.5px] text-muted-foreground" data-testid="cli-new-account-note">새 계정은 빈 설정 폴더로 생성되며, 기존 계정의 설정·플러그인을 가져오지 않습니다.</p>
        {!loaded && <p role="status" className="text-[12px] text-muted-foreground">계정을 불러오는 중입니다.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map(account => <CliAccountCard key={account.accountId} account={account} pending={pending || !loaded}
            update={patch => void manage(() => api.cliAccounts.update(account.accountId, patch))}
            run={action => void manage(async () => {
              await api.cliAccounts[action](account.accountId);
              if (action === "remove") useStore.setState({ projects: await api.listProjects() });
            }, action === "login" ? "로그인 콘솔을 열었습니다. 로그인 창에서 로그인을 마친 뒤 이 계정의 상태 새로고침을 눌러주세요." : undefined)} />)}
        </div>
        <DialogFooter>
          {pending && <Loader2 className="mr-auto size-4 animate-spin" aria-label="계정 처리 중" />}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

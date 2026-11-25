import { useEffect, useState } from "react";
import { ChevronRight, KeyRound, MessagesSquare, RotateCw, Settings, Smartphone, Terminal } from "lucide-react";
import type { UsageDisplay } from "../../../shared/usage";
import type { RemoteUsageAccount, RemoteUsageGroup } from "../../../shared/remote-web";

const KIND_COLOR = { claude: "bg-claude", gpt: "bg-gpt", gemini: "bg-gemini", grok: "bg-grok" } as const;
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "./ui";
import { usageGroups, type UsageKindGroup } from "../../../shared/usage-view";
import { CliAccountsDialog } from "./CliAccountsDialog";
import { DeepSeekDialog } from "./DeepSeekDialog";
import { DeepSeekBalance } from "./DeepSeekBalance";
import { RemoteWebDialog } from "./RemoteWebDialog";
import { CharacterModelsDialog } from "./CharacterModelsDialog";
import { isRemote, useMobile, useRemoteUsage } from "../lib/remote-mode";

function resetText(ts?: number | null) {
  if (!ts) return "";
  const ms = (ts > 1e12 ? ts : ts * 1000) - Date.now();
  if (ms <= 0) return "곧 초기화";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 뒤 초기화` : `${h}시간 ${m}분 뒤 초기화`;
}

function Bar({ name, d, color, error, updatedAt, disabled, showReset }: { name: string; d: UsageDisplay | null; color: string; error?: string; updatedAt?: number; disabled?: boolean; showReset?: boolean }) {
  const tip = error ?? (d
    ? [`${name} ${d.window} 남은 사용량 ${Math.round(d.remaining)}%`, resetText(d.resetsAt), d.warn ? "5시간 한도가 거의 찼습니다" : d.note]
        .filter(Boolean)
        .join(" · ")
    : "사용량 정보를 확인하는 중입니다");
  const full = [tip, updatedAt ? `${new Date(updatedAt).toLocaleString("ko-KR")} 조회` : "", disabled ? "배정 제외 계정(사용량을 새로 조회하지 않음)" : ""].filter(Boolean).join(" · ");
  const reset = showReset && !error && resetText(d?.resetsAt);
  const row = (
    <Tooltip content={full}>
      <div className={cn("flex items-center gap-2 text-[11px] text-muted-foreground", disabled && "opacity-60")} data-testid="usage-bar">
        <span className={cn("w-[108px] shrink-0 whitespace-nowrap", showReset && "truncate")}>
          {name} <span className={cn(d?.warn && "font-semibold text-destructive")}>{error ? "조회 실패" : d ? d.window : "정보 없음"}</span>
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          {d && <div className={cn("h-full rounded-full", d.warn ? "bg-destructive" : color)} style={{ width: `${d.remaining}%` }} />}
        </div>
        <span className={cn("w-9 text-right tabular-nums", d?.warn && "text-destructive")}>{d ? `${Math.round(d.remaining)}%` : "–"}</span>
      </div>
    </Tooltip>
  );
  return reset ? <div>{row}<div className="text-right text-[11px] text-muted-foreground" data-testid="usage-reset">{reset}</div></div> : row;
}

/** One family from the ChatterBox account store: a single bar for one account, a labelled bar per account otherwise. */
export function CliUsageBars({ group, color }: { group: UsageKindGroup | RemoteUsageGroup; color: string }) {
  const bar = (row: RemoteUsageAccount, name: string) => <Bar name={name} d={row.display && group.kind === "gemini" ? { ...row.display, note: "Gemini Models · 주간/5시간 중 최소 잔여량" } : row.display} color={color} error={row.error} updatedAt={row.checkedAt} disabled={!row.enabled} showReset={isRemote()} />;
  if (group.accounts.length === 1) return <div title={group.accounts[0].label}>{bar(group.accounts[0], group.name)}</div>;
  return <section className="space-y-1" data-testid={`cli-usage-${group.kind}`} aria-label={`${group.name} 계정별 잔여량`}>
    <div className="text-[11px] font-medium text-muted-foreground">{group.name}</div>
    <div className="space-y-1 pl-2">
      {group.accounts.map((row, i) => {
        const id = "accountId" in row ? row.accountId : undefined;
        return <div key={id ?? i} title={id ? `${id}${!row.enabled ? " · 배정 제외" : ""}` : undefined}>{bar(row, row.label)}</div>;
      })}
    </div>
  </section>;
}

export async function refreshUsageAndAccounts(wait = false): Promise<void> {
  const [usage, cliAccounts] = await Promise.allSettled([api.usage(wait), api.cliAccounts.list()]);
  if (usage.status === "fulfilled") useStore.setState({ usage: usage.value });
  else useStore.getState().toast(errorMessage(usage.reason));
  if (cliAccounts.status === "fulfilled") useStore.setState({ cliAccounts: cliAccounts.value });
  else useStore.getState().toast(errorMessage(cliAccounts.reason));
}

/** Remaining usage: weekly by default, the 5-hour window when it has ≤ 10% left. */
export function UsageBar() {
  return isRemote() ? <RemoteUsageBar /> : <DesktopUsageBar />;
}

/**
 * Remote web: the same bars from the server's read-only usage view (GET /api/usage, D5). Account and
 * API settings stay on the PC, so there is no settings menu here.
 */
function RemoteUsageBar() {
  const groups = useRemoteUsage(s => s.groups);
  const mobile = useMobile();
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const t = setInterval(() => void api.usage().then(usage => useStore.setState({ usage })).catch(() => undefined), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="space-y-1" data-testid="remote-usage" aria-label="남은 사용량 · 잔고">
      <div className={cn("flex items-center text-[11px] font-medium text-muted-foreground", mobile ? "justify-end" : "justify-between")}>
        {!mobile && <span>남은 사용량 · 잔고</span>}
        <button type="button" disabled={refreshing} aria-label="사용량·잔고 새로고침" title="PC 앱의 계정 사용량을 다시 조회 (1분에 한 번)" data-testid="usage-refresh" className={cn("rounded p-1 hover:bg-accent disabled:opacity-50", mobile && "grid size-11 place-items-center")} onClick={async () => {
          setRefreshing(true);
          try { useStore.setState({ usage: await api.usage(true) }); }
          catch (error) { useStore.getState().toast(errorMessage(error)); }
          finally { setRefreshing(false); }
        }}><RotateCw className={cn("size-3", refreshing && "animate-spin")} /></button>
      </div>
      {groups.map(group => <CliUsageBars key={group.kind} group={group} color={KIND_COLOR[group.kind]} />)}
      <DeepSeekBalance compact />
    </section>
  );
}

function DesktopUsageBar() {
  const [cliOpen, setCliOpen] = useState(false);
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [characterModelsOpen, setCharacterModelsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const usage = useStore((s) => s.usage);
  const cliAccounts = useStore((s) => s.cliAccounts);
  useEffect(() => {
    void api.cliAccounts.list().then(cliAccounts => useStore.setState({ cliAccounts })).catch(error => useStore.getState().toast(errorMessage(error)));
    const t = setInterval(() => void refreshUsageAndAccounts(), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>남은 사용량 · 잔고</span>
        <div className="flex items-center gap-0.5">
          <button type="button" disabled={refreshing} aria-label="사용량·잔고 새로고침" title="연결된 계정의 사용량과 API 잔고 다시 조회" data-testid="usage-refresh" className="rounded p-1 hover:bg-accent disabled:opacity-50" onClick={async () => {
            setRefreshing(true);
            try {
              await refreshUsageAndAccounts(true);
            }
            catch (error) { useStore.getState().toast(errorMessage(error)); }
            finally { setRefreshing(false); }
          }}><RotateCw className={cn("size-3", refreshing && "animate-spin")} /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="계정 및 API 설정" title="계정 및 API 설정" data-testid="connection-settings" className="size-6 text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-3.5"><Settings /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" sideOffset={10} collisionPadding={12} aria-label="계정 및 API 설정" data-testid="connection-settings-menu" className="w-[300px] max-h-[calc(100vh-24px)] max-w-[calc(100vw-24px)] rounded-xl p-1.5 shadow-2xl">
              <DropdownMenuLabel className="px-3 pb-2.5 pt-2">
                <span className="block text-[13px] font-semibold text-foreground">연결 설정</span>
                <span className="mt-0.5 block text-[11px] font-normal">계정과 API 연결을 관리하세요</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCliOpen(true)} data-testid="cli-accounts-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Terminal className="!text-primary" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">CLI 계정 관리</span><span className="mt-0.5 block text-[11px] text-muted-foreground">Claude · Codex · Antigravity · Grok 로그인과 계정 선택</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDeepseekOpen(true)} data-testid="deepseek-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-deepseek/10"><KeyRound className="!text-deepseek" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">DeepSeek API 설정</span><span className="mt-0.5 block text-[11px] text-muted-foreground">API 키 · 모델 · 잔고</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              {api.characterModels && <DropdownMenuItem onSelect={() => setCharacterModelsOpen(true)} data-testid="character-models-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10"><MessagesSquare className="!text-primary" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">캐릭터 채팅 모델</span><span className="mt-0.5 block text-[11px] text-muted-foreground">개별 대화와 회의실에 사용할 모델</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setRemoteOpen(true)} data-testid="remote-web-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Smartphone className="!text-primary" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">원격 웹 접속</span><span className="mt-0.5 block text-[11px] text-muted-foreground">브라우저에서 채팅 확인 · 추가 지시 · 승인</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-3">사용 기록</DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {usageGroups(cliAccounts, usage).map(group => <CliUsageBars key={group.kind} group={group} color={KIND_COLOR[group.kind]} />)}
      <DeepSeekBalance compact />
      <CliAccountsDialog open={cliOpen} onOpenChange={setCliOpen} />
      <DeepSeekDialog open={deepseekOpen} onOpenChange={setDeepseekOpen} />
      <CharacterModelsDialog open={characterModelsOpen} onOpenChange={setCharacterModelsOpen} />
      <RemoteWebDialog open={remoteOpen} onOpenChange={setRemoteOpen} />
    </div>
  );
}

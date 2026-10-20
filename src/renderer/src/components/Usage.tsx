import { useEffect, useState } from "react";
import { ChevronRight, Globe2, KeyRound, RotateCw, Settings, Sparkles } from "lucide-react";
import { pickUsage, type UsageDisplay } from "../../../shared/usage";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "./ui";
import { GeminiWebDialog } from "./GeminiWebDialog";
import { AIStudioDialog } from "./AIStudioDialog";
import { AIStudioUsage } from "./AIStudioUsage";
import { DeepSeekDialog } from "./DeepSeekDialog";
import { DeepSeekBalance } from "./DeepSeekBalance";

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
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const usage = useStore((s) => s.usage);
  useEffect(() => {
    const t = setInterval(() => void api.usage().then((u) => useStore.setState({ usage: u })), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>남은 사용량 · 잔고</span>
        <div className="flex items-center gap-0.5">
          <button type="button" disabled={refreshing} aria-label="사용량·잔고 새로고침" title="연결된 계정의 사용량과 API 잔고 다시 조회" data-testid="usage-refresh" className="rounded p-1 hover:bg-accent disabled:opacity-50" onClick={async () => {
            setRefreshing(true);
            try { useStore.setState({ usage: await api.usage(true) }); }
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
              <DropdownMenuItem onSelect={() => setWebOpen(true)} data-testid="gemini-web-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gemini/10"><Globe2 className="!text-gemini" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">제미나이 웹 계정 관리</span><span className="mt-0.5 block text-[11px] text-muted-foreground">Google 로그인 · 계정 전환</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAiStudioOpen(true)} data-testid="aistudio-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Sparkles className="!text-primary" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">AI Studio · Argon</span><span className="mt-0.5 block text-[11px] text-muted-foreground">서비스 연결 · 계정 라우팅</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDeepseekOpen(true)} data-testid="deepseek-manage" className="group gap-3 rounded-lg px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-deepseek/10"><KeyRound className="!text-deepseek" /></span>
                <span className="min-w-0 flex-1"><span className="block text-[12px] font-medium">DeepSeek API 설정</span><span className="mt-0.5 block text-[11px] text-muted-foreground">API 키 · 모델 · 잔고</span></span>
                <ChevronRight className="!size-3.5 opacity-40 group-data-[highlighted]:opacity-100" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-3">사용 기록</DropdownMenuLabel>
              <AIStudioUsage compact onOpen={() => setAiStudioOpen(true)} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <Bar name="클로드" d={pickUsage(usage.claude)} color="bg-claude" />
      <Bar name="지피티" d={pickUsage(usage.codex)} color="bg-gpt" />
      <Bar name="제미나이" d={pickUsage(usage.gemini)} color="bg-gemini" error={usage.gemini?.error} updatedAt={usage.gemini?.updatedAt} />
      <Bar name="그록" d={pickUsage(usage.grok)} color="bg-grok" error={usage.grok?.error} updatedAt={usage.grok?.updatedAt} />
      <DeepSeekBalance compact />
      <GeminiWebDialog open={webOpen} onOpenChange={setWebOpen} />
      <AIStudioDialog open={aiStudioOpen} onOpenChange={setAiStudioOpen} />
      <DeepSeekDialog open={deepseekOpen} onOpenChange={setDeepseekOpen} />
    </div>
  );
}

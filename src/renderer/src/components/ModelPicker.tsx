import { useEffect, useState } from "react";
import { ChevronDown, KeyRound, Loader2, PencilLine, RotateCcw, Sparkles } from "lucide-react";
import { DEEPSEEK_MODEL } from "../../../shared/deepseek";
import { ANTIGRAVITY_MODEL } from "../../../shared/types";
import { AGENT_LABEL, type AgentKind } from "../../../shared/types";
import { cn, errorMessage } from "../lib/utils";
import { latestModels } from "../../../shared/models";
import { useStore } from "../store";
import { CliAccountsDialog } from "./CliAccountsDialog";
import { DeepSeekDialog } from "./DeepSeekDialog";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "./ui";

const MODEL_GROUP_LABEL: Record<AgentKind, string> = {
  claude: "클로드 모델 (Claude Code)",
  codex: "지피티 모델",
  gemini: "제미나이 모델",
  grok: "그록 모델",
  deepseek: "DeepSeek 모델 (API)",
};

/** "claude:opus" for the orchestrator (both CLIs), or a plain model id for a worker. */
export function useModelLabel() {
  const models = useStore((s) => s.models);
  return (agent: AgentKind, id: string) =>
    models[agent]?.find((m) => m.id === id)?.label ?? (agent === "gemini" && id === ANTIGRAVITY_MODEL ? "Antigravity · Argon" : id || (agent === "gemini" ? "Antigravity · Argon" : agent === "deepseek" ? DEEPSEEK_MODEL : "기본값"));
}

interface Props {
  /** CLIs whose models are offered; two = orchestrator picker (values are "agent:model"). */
  agents: AgentKind[];
  value: string;
  onChange: (value: string) => void;
  /** Chat header: the value is inherited from the project. */
  inherited?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  className?: string;
  compact?: boolean;
  ariaLabel: string;
}

export function ModelPicker({ agents, value, onChange, inherited, onReset, resetLabel, className, compact, ariaLabel }: Props) {
  const models = useStore((s) => s.models);
  const errors = useStore((s) => s.modelErrors);
  const loadModels = useStore((s) => s.loadModels);
  const refreshCli = useStore((s) => s.refreshCli);
  const geminiInstalled = useStore(s => !!s.cli.find(c => c.agent === "gemini")?.path);
  const label = useModelLabel();
  const [custom, setCustom] = useState<AgentKind | null>(null);
  const [customText, setCustomText] = useState("");
  const [cliOpen, setCliOpen] = useState(false);
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const encoded = agents.length > 1;
  const encodedAgent = agents.find((a) => value.startsWith(`${a}:`)) ?? agents[0];
  const rawCurrent = encoded
    ? { agent: encodedAgent, id: value.slice(value.indexOf(":") + 1) }
    : { agent: agents[0], id: value };
  const current = rawCurrent.agent === "gemini" && !rawCurrent.id ? { ...rawCurrent, id: ANTIGRAVITY_MODEL } : rawCurrent;

  useEffect(() => {
    for (const a of agents) if (a !== "gemini" || geminiInstalled) void loadModels(a);
  }, [agents.join(","), loadModels, geminiInstalled]);

  const make = (agent: AgentKind, id: string) => (encoded ? `${agent}:${id}` : id);
  const refreshInstallation = () => void refreshCli().catch(error => useStore.getState().toast(errorMessage(error)));

  return (
    <>
      <DropdownMenu onOpenChange={(open) => {
        if (open) void refreshCli(false).catch(() => undefined);
        if (open) for (const a of agents) if (errors[a] && (a !== "gemini" || geminiInstalled)) void loadModels(a);
      }}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "xs" : "default"}
            aria-label={ariaLabel}
            disabled={!encoded && current.agent === "gemini" && !geminiInstalled}
            title={current.agent === "gemini" && !geminiInstalled ? "Antigravity CLI(agy) 미설치 · 설치 후 다시 확인하세요." : undefined}
            className={cn("min-w-0 justify-between font-normal", compact && "max-w-40", !compact && "w-full", className)}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {encoded && <span className="text-muted-foreground">{AGENT_LABEL[current.agent]} ·</span>}
              <span className="truncate">{label(current.agent, current.id)}</span>
              {current.agent === "gemini" && !geminiInstalled && <span className="text-muted-foreground">· 미설치</span>}
            </span>
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {/* Only a chat that overrides the project value can go back to it. */}
          {onReset && !inherited && (
            <>
              <DropdownMenuItem onSelect={onReset}>
                <RotateCcw />
                {resetLabel ?? "프로젝트 값 사용"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {agents.map((a, i) => (
            <div key={a}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{MODEL_GROUP_LABEL[a]}</DropdownMenuLabel>
              {a === "gemini" && !geminiInstalled ? <>
                <DropdownMenuItem disabled data-testid="antigravity-unavailable">Antigravity CLI 미설치 · 사용 안 함</DropdownMenuItem>
                <DropdownMenuItem onSelect={event => { event.preventDefault(); refreshInstallation(); }}><RotateCcw /> 설치 후 다시 확인</DropdownMenuItem>
              </> : <>
              {a === "gemini" ? (
                <>
                  <DropdownMenuItem onSelect={() => setCliOpen(true)} data-testid="antigravity-connect">
                    <Sparkles />
                    Antigravity CLI 계정 관리…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : (a === "grok" || a === "deepseek") && (
                <>
                  {a === "deepseek" && <DropdownMenuItem onSelect={() => setDeepseekOpen(true)} data-testid="deepseek-connect">
                    <KeyRound />
                    DeepSeek API 설정…
                  </DropdownMenuItem>}
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckItem checked={current.agent === a && current.id === ""} onSelect={() => onChange(make(a, ""))}>
                    <span className="flex-1 truncate">{a === "deepseek" ? "API 기본 모델" : "CLI 기본 모델"}</span>
                  </DropdownMenuCheckItem>
                </>
              )}
              {!models[a] && !errors[a] && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 목록을 불러오는 중…
                </div>
              )}
              {errors[a] && <>
                <div className="px-2 py-1.5 text-[12px] text-destructive">{errors[a]}</div>
                <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void loadModels(a); }}>
                  <RotateCcw /> 목록 다시 확인
                </DropdownMenuItem>
              </>}
              {models[a] &&
                latestModels(a, models[a]!, current.agent === a ? [current.id] : []).map((m) => (
                  <DropdownMenuCheckItem
                    key={m.id}
                    checked={current.agent === a && current.id === m.id}
                    onSelect={() => onChange(make(a, m.id))}
                  >
                    <span className="flex-1 truncate">{m.label}</span>
                    {m.old && <span className="text-[11px] text-warning">이전 버전</span>}
                    <span className="font-mono text-[11px] text-muted-foreground">{m.id}</span>
                  </DropdownMenuCheckItem>
                ))}
              {a !== "gemini" && <DropdownMenuItem
                onSelect={() => {
                  setCustomText(current.agent === a ? current.id : "");
                  setCustom(a);
                }}
              >
                <PencilLine />
                직접 입력…
              </DropdownMenuItem>}
              </>}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!encoded && current.agent === "gemini" && !geminiInstalled && <Button variant="ghost" size="xs" aria-label="Antigravity 설치 다시 확인" onClick={refreshInstallation}><RotateCcw /> 설치 확인</Button>}
      <Dialog open={custom !== null} onOpenChange={(o) => !o && setCustom(null)}>
        <DialogContent
          title={`${custom ? AGENT_LABEL[custom] : ""} 모델 직접 입력`}
          description={
            custom === "codex"
              ? "Codex가 받는 모델 id (예: gpt-6-astra)"
              : custom === "gemini" ? "Antigravity CLI 모델 id" : custom === "grok" ? "Grok CLI 모델 id" : custom === "deepseek" ? "DeepSeek API 모델 id" : "Claude Code --model 값 (별칭 또는 전체 id)"
          }
          className="w-[420px]"
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom && customText.trim()) onChange(make(custom, customText.trim()));
              setCustom(null);
            }}
          >
            <Input autoFocus value={customText} onChange={(e) => setCustomText(e.target.value)} placeholder="모델 id" className="font-mono" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCustom(null)}>
                취소
              </Button>
              <Button type="submit" disabled={!customText.trim()}>
                적용
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <CliAccountsDialog open={cliOpen} onOpenChange={setCliOpen} />
      <DeepSeekDialog
        open={deepseekOpen}
        onOpenChange={setDeepseekOpen}
        onUseModel={(id) => onChange(make("deepseek", id))}
      />
    </>
  );
}

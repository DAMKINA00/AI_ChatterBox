import { useEffect, useState } from "react";
import { ChevronDown, Loader2, PencilLine, RotateCcw } from "lucide-react";
import { AGENT_LABEL, type AgentKind } from "../../../shared/types";
import { cn } from "../lib/utils";
import { useStore } from "../store";
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

/** "claude:opus" for the orchestrator (both CLIs), or a plain model id for a worker. */
export function useModelLabel() {
  const models = useStore((s) => s.models);
  return (agent: AgentKind, id: string) => models[agent]?.find((m) => m.id === id)?.label ?? (id || "기본값");
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
  const label = useModelLabel();
  const [custom, setCustom] = useState<AgentKind | null>(null);
  const [customText, setCustomText] = useState("");
  const encoded = agents.length > 1;

  useEffect(() => {
    for (const a of agents) void loadModels(a);
  }, [agents.join(","), loadModels]);

  const current = encoded
    ? { agent: (value.startsWith("codex:") ? "codex" : "claude") as AgentKind, id: value.slice(value.indexOf(":") + 1) }
    : { agent: agents[0], id: value };
  const make = (agent: AgentKind, id: string) => (encoded ? `${agent}:${id}` : id);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "xs" : "default"}
            aria-label={ariaLabel}
            className={cn("justify-between font-normal", !compact && "w-full", className)}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {encoded && <span className="text-muted-foreground">{AGENT_LABEL[current.agent]} ·</span>}
              <span className="truncate">{label(current.agent, current.id)}</span>
              {inherited && <span className="text-[11px] text-muted-foreground">(프로젝트 기본값)</span>}
            </span>
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {onReset && (
            <>
              <DropdownMenuItem onSelect={onReset} disabled={inherited}>
                <RotateCcw />
                {resetLabel ?? "프로젝트 값 사용"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {agents.map((a, i) => (
            <div key={a}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{a === "claude" ? "Claude 모델 (Claude Code)" : "GPT 모델 (Codex)"}</DropdownMenuLabel>
              {!models[a] && !errors[a] && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 목록을 불러오는 중…
                </div>
              )}
              {errors[a] && <div className="px-2 py-1.5 text-[12px] text-destructive">{errors[a]}</div>}
              {models[a]?.map((m) => (
                <DropdownMenuCheckItem
                  key={m.id}
                  checked={current.agent === a && current.id === m.id}
                  onSelect={() => onChange(make(a, m.id))}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{m.id}</span>
                </DropdownMenuCheckItem>
              ))}
              {current.agent === a && current.id && models[a] && !models[a]!.some((m) => m.id === current.id) && (
                <DropdownMenuCheckItem checked onSelect={() => undefined}>
                  <span className="flex-1 truncate font-mono">{current.id}</span>
                </DropdownMenuCheckItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  setCustomText(current.agent === a ? current.id : "");
                  setCustom(a);
                }}
              >
                <PencilLine />
                직접 입력…
              </DropdownMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={custom !== null} onOpenChange={(o) => !o && setCustom(null)}>
        <DialogContent
          title={`${custom ? AGENT_LABEL[custom] : ""} 모델 직접 입력`}
          description={custom === "codex" ? "Codex가 받는 모델 id (예: gpt-6-astra)" : "Claude Code --model 값 (별칭 또는 전체 id)"}
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
    </>
  );
}

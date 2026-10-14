import { useEffect, useState } from "react";
import { ChevronDown, Globe2, Loader2, PencilLine, RotateCcw } from "lucide-react";
import { AGENT_LABEL, GEMINI_WEB_MODEL, type AgentKind } from "../../../shared/types";
import { cn } from "../lib/utils";
import { latestModels } from "../../../shared/models";
import { useStore } from "../store";
import { GeminiWebDialog } from "./GeminiWebDialog";
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
  claude: "Claude 모델 (Claude Code)",
  codex: "GPT 모델 (Codex)",
  gemini: "Gemini 모델 (Antigravity)",
};

const GEMINI_WEB_LABEL = "Gemini 웹 · Argon (계정 1)";

/** "claude:opus" for the orchestrator (both CLIs), or a plain model id for a worker. */
export function useModelLabel() {
  const models = useStore((s) => s.models);
  return (agent: AgentKind, id: string) =>
    models[agent]?.find((m) => m.id === id)?.label ?? (agent === "gemini" && id === GEMINI_WEB_MODEL ? GEMINI_WEB_LABEL : id || (agent === "gemini" ? "Pro 자동 선택" : "기본값"));
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
  const [geminiWebOpen, setGeminiWebOpen] = useState(false);
  const encoded = agents.length > 1;
  const encodedAgent = agents.find((a) => value.startsWith(`${a}:`)) ?? agents[0];
  const current = encoded
    ? { agent: encodedAgent, id: value.slice(value.indexOf(":") + 1) }
    : { agent: agents[0], id: value };
  const webSelected = current.agent === "gemini" && current.id === GEMINI_WEB_MODEL;

  useEffect(() => {
    for (const a of agents) if (!(webSelected && a === "gemini")) void loadModels(a);
  }, [agents.join(","), loadModels, webSelected]);

  const make = (agent: AgentKind, id: string) => (encoded ? `${agent}:${id}` : id);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => {
        if (open) for (const a of agents) if (!(webSelected && a === "gemini") && errors[a]) void loadModels(a);
      }}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "xs" : "default"}
            aria-label={ariaLabel}
            className={cn("min-w-0 justify-between font-normal", compact && "max-w-40", !compact && "w-full", className)}
          >
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {encoded && <span className="text-muted-foreground">{AGENT_LABEL[current.agent]} ·</span>}
              <span className="truncate">{label(current.agent, current.id)}</span>
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
              {a === "gemini" && (
                <>
                  <DropdownMenuItem onSelect={() => setGeminiWebOpen(true)} data-testid="gemini-web-connect">
                    <Globe2 />
                    웹 계정 관리…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckItem checked={current.agent === a && current.id === ""} onSelect={() => onChange(make(a, ""))}>
                    <span className="flex-1 truncate">Pro 자동 선택</span>
                  </DropdownMenuCheckItem>
                </>
              )}
              {!models[a] && !errors[a] && !(webSelected && a === "gemini") && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 목록을 불러오는 중…
                </div>
              )}
              {errors[a] && !(webSelected && a === "gemini") && <>
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
          description={
            custom === "codex"
              ? "Codex가 받는 모델 id (예: gpt-6-astra)"
              : custom === "gemini"
                ? "Antigravity가 받는 Gemini 모델 id"
                : "Claude Code --model 값 (별칭 또는 전체 id)"
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
      <GeminiWebDialog
        open={geminiWebOpen}
        onOpenChange={setGeminiWebOpen}
        onUseModel={() => onChange(make("gemini", GEMINI_WEB_MODEL))}
      />
    </>
  );
}

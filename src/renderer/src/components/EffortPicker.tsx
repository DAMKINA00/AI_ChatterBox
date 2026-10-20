import { useEffect, useMemo } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { isAIStudioModel } from "../../../shared/aistudio";
import { GEMINI_WEB_MODEL, type AgentKind, type ModelOption } from "../../../shared/types";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { Button, DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "./ui";

const WORKER_EFFORTS = new Set(["medium", "high", "xhigh"]);
const DEEPSEEK_WORKER_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];
const WEB_EFFORT_TITLE = "제미나이 웹은 medium/high/xhigh 추론 수준을 제공하지 않습니다. 웹 서비스가 모델 설정을 관리합니다.";

export function effortLabel(value: string | null | undefined): string {
  if (!value) return "CLI 기본값";
  if (value === "auto") return "자동 배정";
  return value;
}

/** Resolve Gemini's empty model to the CLI-reported default metadata. */
export function modelOption(
  models: Partial<Record<AgentKind, ModelOption[]>>,
  agent: AgentKind,
  model: string,
): ModelOption | undefined {
  const list = models[agent] ?? [];
  return list.find((m) => m.id === model) ?? ((agent === "gemini" || agent === "deepseek") && !model ? list.find((m) => m.isDefault) : undefined);
}

export function effortOptions(
  models: Partial<Record<AgentKind, ModelOption[]>>,
  agent: AgentKind,
  model: string,
  worker: boolean,
): string[] {
  const supported = modelOption(models, agent, model)?.reasoningEfforts ?? [];
  const unique = [...new Set(supported.filter((value) => typeof value === "string" && value.length > 0))];
  const ordered = [
    ...EFFORT_ORDER.filter((value) => unique.includes(value)),
    ...unique.filter((value) => !EFFORT_ORDER.includes(value)),
  ];
  const workerEfforts = agent === "deepseek" ? DEEPSEEK_WORKER_EFFORTS : WORKER_EFFORTS;
  return worker ? ["auto", ...ordered.filter((value) => workerEfforts.has(value))] : ["", ...ordered];
}

/** Choose the value to use immediately after a model changes. */
export function defaultEffortForModel(
  models: Partial<Record<AgentKind, ModelOption[]>>,
  agent: AgentKind,
  model: string,
  worker: boolean,
): string {
  if (worker) return "auto";
  return effortOptions(models, agent, model, false).includes("xhigh") ? "xhigh" : "";
}

interface Props {
  agent: AgentKind;
  model: string;
  value: string;
  onChange: (value: string) => void;
  /** Worker pickers offer auto plus the model's medium/high/xhigh subset. */
  worker?: boolean;
  /** Chat header: the value is inherited from the project. */
  inherited?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  className?: string;
  compact?: boolean;
  ariaLabel: string;
}

export function EffortPicker({
  agent,
  model,
  value,
  onChange,
  worker = false,
  inherited,
  onReset,
  resetLabel,
  className,
  compact,
  ariaLabel,
}: Props) {
  const models = useStore((s) => s.models);
  const modelErrors = useStore((s) => s.modelErrors);
  const loadModels = useStore((s) => s.loadModels);
  const webModel = agent === "gemini" && model === GEMINI_WEB_MODEL;
  const aiStudioModel = agent === "gemini" && isAIStudioModel(model);

  useEffect(() => {
    if (!webModel && !aiStudioModel) void loadModels(agent);
  }, [agent, aiStudioModel, loadModels, webModel]);

  const options = useMemo(() => effortOptions(models, agent, model, worker), [models, agent, model, worker]);
  const metadata = models[agent];
  const selectedModel = modelOption(models, agent, model);
  const metadataPending = metadata === undefined && !modelErrors[agent];
  const metadataFailed = !!modelErrors[agent];
  const selectedIsSupported = options.includes(value);
  let status: string | undefined;
  if (!selectedIsSupported) {
    if (metadataFailed) status = "모델 지원 목록을 불러오지 못했습니다";
    else if (metadataPending) status = "지원 목록 확인 중";
    else if (!selectedModel) status = "모델 지원 정보를 확인할 수 없습니다";
    else status = "이 모델에서 지원하지 않는 요청값입니다";
  }
  const statusTitle = status ? `${effortLabel(value)} · ${status}` : undefined;

  if (webModel || aiStudioModel) {
    const title = webModel ? WEB_EFFORT_TITLE : "현재 AI Studio 연결은 모델의 기본 추론 설정을 사용합니다.";
    return (
      <Tooltip content={title}>
        <span className="inline-flex" title={title}>
          <Button
            variant="outline"
            size={compact ? "xs" : "default"}
            disabled
            aria-label={ariaLabel}
            title={title}
            data-testid="effort-picker"
            data-effort={value}
            data-effort-status={webModel ? "web" : "aistudio"}
            className={cn("justify-between font-normal", compact && "max-w-28", !compact && "min-w-32", className)}
          >
            <span className="truncate">{webModel ? "웹 모델 설정" : "AI Studio 모델 설정"}</span>
            <ChevronDown className="opacity-60" />
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={compact ? "xs" : "default"}
          aria-label={ariaLabel}
          aria-invalid={status ? true : undefined}
          title={statusTitle}
          data-testid="effort-picker"
          data-effort={value}
          data-effort-status={status}
          className={cn("justify-between font-normal", compact && "max-w-28", !compact && "min-w-32", className)}
        >
          <span className="truncate">{effortLabel(value)}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {onReset && !inherited && (
          <>
            <DropdownMenuItem onSelect={onReset}>
              <RotateCcw />
              {resetLabel ?? "프로젝트 값 사용"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {options.map((option) => (
          <DropdownMenuCheckItem key={option || "cli-default"} checked={value === option} onSelect={() => onChange(option)}>
            {effortLabel(option)}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

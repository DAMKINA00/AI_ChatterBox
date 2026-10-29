// Model and reasoning-effort selects shared by the chat settings and the project settings sheets.
// Model lists come from GET /api/models (the server's allow-list); they are cached here for a minute.
import { useEffect, useState } from "react";
import { AGENT_LABEL, MASTER_LABEL, parseOrchestrator, type AgentKind, type ModelOption } from "../../../shared/types";
import type { RemoteModelsResponse } from "../../../shared/remote-web";
import { request, url } from "./api";
import { effortChoices, effortText, MODEL_AGENTS, modelChoices } from "./logic";

export type ModelMap = Partial<Record<AgentKind, ModelOption[]>>;
let cache: { at: number; models: ModelMap } | null = null;

/** All agents' model lists; agents whose list fails to load are left out (their select shows the raw value). */
export function useModels(): ModelMap | null {
  const [models, setModels] = useState<ModelMap | null>(cache && Date.now() - cache.at < 60_000 ? cache.models : null);
  useEffect(() => {
    if (models) return;
    let alive = true;
    void Promise.allSettled(MODEL_AGENTS.map(agent => request<RemoteModelsResponse>(url("/api/models", undefined, { agent })))).then(results => {
      const map: ModelMap = {};
      results.forEach((r, i) => { if (r.status === "fulfilled") map[MODEL_AGENTS[i]] = r.value.models; });
      cache = { at: Date.now(), models: map };
      if (alive) setModels(map);
    });
    return () => { alive = false; };
  }, [models]);
  return models;
}

/** The six model slots of a chat / project. */
export const MODEL_SLOTS = [
  { slot: "orchestrator", label: MASTER_LABEL, agent: null, worker: false },
  { slot: "claude", label: AGENT_LABEL.claude, agent: "claude", worker: true },
  { slot: "codex", label: AGENT_LABEL.codex, agent: "codex", worker: true },
  { slot: "gemini", label: AGENT_LABEL.gemini, agent: "gemini", worker: true },
  { slot: "grok", label: AGENT_LABEL.grok, agent: "grok", worker: true },
  { slot: "deepseek", label: AGENT_LABEL.deepseek, agent: "deepseek", worker: true },
] as const satisfies readonly { slot: string; label: string; agent: AgentKind | null; worker: boolean }[];
export type ModelSlot = (typeof MODEL_SLOTS)[number]["slot"];

const INHERIT = "\u0000inherit";
const SELECT = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/** Agent and model id of a slot value (the orchestrator stores `agent:model`). */
export const slotModel = (slot: ModelSlot, value: string) => (slot === "orchestrator" ? parseOrchestrator(value) : { agent: slot as AgentKind, model: value });

const modelName = (models: ModelMap, slot: ModelSlot, value: string) => {
  const { agent, model } = slotModel(slot, value);
  const label = models[agent]?.find(m => m.id === model)?.label ?? (model || "CLI 기본값");
  return slot === "orchestrator" ? `${AGENT_LABEL[agent]} · ${label}` : label;
};

/**
 * One slot: model select + effort select. `value`/`effort` null = follow `inherited*` (chat overrides);
 * pass `allowInherit=false` for project settings, where a value is always set.
 */
export function ModelSlotRow({ models, slot, label, worker, value, inheritedValue, effort, inheritedEffort, allowInherit, disabled, onModel, onEffort }: {
  models: ModelMap; slot: ModelSlot; label: string; worker: boolean;
  value: string | null; inheritedValue: string; effort: string | null; inheritedEffort: string;
  allowInherit: boolean; disabled?: boolean;
  onModel: (value: string | null) => void; onEffort: (value: string | null) => void;
}) {
  const effective = value ?? inheritedValue;
  const { agent, model } = slotModel(slot, effective);
  const efforts = effortChoices(models, agent, model, worker);
  const effortValue = effort ?? inheritedEffort;
  if (effortValue && !efforts.includes(effortValue)) efforts.push(effortValue);
  return (
    <fieldset className="grid gap-1.5" disabled={disabled}>
      <legend className="mb-1 text-[12.5px] font-medium">{label}</legend>
      <select aria-label={`${label} 모델`} className={SELECT} value={value ?? (allowInherit ? INHERIT : effective)} onChange={e => onModel(e.target.value === INHERIT ? null : e.target.value)}>
        {allowInherit && <option value={INHERIT}>프로젝트 값 ({modelName(models, slot, inheritedValue)})</option>}
        {slot === "orchestrator"
          ? MODEL_AGENTS.map(a => (
            <optgroup key={a} label={AGENT_LABEL[a]}>
              {modelChoices(models[a], agent === a ? model : "").map(m => <option key={m.id} value={`${a}:${m.id}`}>{m.label}{m.deprecated ? " (이전 모델)" : ""}</option>)}
            </optgroup>
          ))
          : modelChoices(models[agent], model).map(m => <option key={m.id} value={m.id}>{m.label}{m.deprecated ? " (이전 모델)" : ""}</option>)}
      </select>
      <select aria-label={`${label} 추론 수준`} className={SELECT} value={effort ?? (allowInherit ? INHERIT : effortValue)} onChange={e => onEffort(e.target.value === INHERIT ? null : e.target.value)}>
        {allowInherit && <option value={INHERIT}>프로젝트 값 ({effortText(inheritedEffort)})</option>}
        {efforts.map(v => <option key={v} value={v}>{effortText(v)}</option>)}
      </select>
    </fieldset>
  );
}

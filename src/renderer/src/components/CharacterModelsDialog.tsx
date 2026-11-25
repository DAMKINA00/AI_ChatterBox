import { useEffect, useState } from "react";
import { CHARACTER_PROVIDERS, type CharacterModels } from "../../../shared/character-meeting";
import { AGENT_LABEL, type AgentKind, type ModelOption } from "../../../shared/types";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../../../shared/usage-companion";
import { api, errorMessage } from "../lib/utils";
import { Button, Dialog, DialogContent, DialogFooter } from "./ui";

const providers = Object.values(CHARACTER_PROVIDERS);
const selectStyle = "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline focus-visible:outline-primary";

export function CharacterModelsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [choices, setChoices] = useState<CharacterModels>();
  const [catalog, setCatalog] = useState<Partial<Record<AgentKind, ModelOption[]>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !api.characterModels || !api.characterModelOptions) return;
    let current = true;
    setChoices(undefined);
    setError("");
    setCatalog({});
    void api.characterModels().then(value => { if (current) setChoices(value); }).catch(error => { if (current) setError(errorMessage(error)); });
    for (const agent of providers) {
      void api.characterModelOptions(agent).then(list => list.filter(model => !model.hidden && !model.deprecated), () => [])
        .then(list => { if (current) setCatalog(old => ({ ...old, [agent]: list })); });
    }
    return () => { current = false; };
  }, [open]);

  const change = (id: MonitorCharacterId, agent?: AgentKind, model = "") =>
    setChoices(old => ({ ...old, [id]: agent ? { agent, model } : undefined }));

  async function save() {
    if (!choices || !api.saveCharacterModels) return;
    setSaving(true);
    setError("");
    try { await api.saveCharacterModels(choices); onOpenChange(false); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <DialogContent title="캐릭터 채팅 모델" description="개별 캐릭터 채팅과 회의실에서 사용할 모델을 골라 주세요." className="w-[560px] max-w-[calc(100vw-24px)]">
      {choices && <div className="grid gap-3">
        {MONITOR_CHARACTERS.map(id => {
          const agent = id === "orch" ? choices.orch?.agent : CHARACTER_PROVIDERS[id];
          const selected = choices[id]?.model ?? "";
          const list = agent ? catalog[agent] : undefined;
          return <div key={id} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
            <label htmlFor={`character-model-${id}`} className="pt-2 text-sm font-medium">{MONITOR_CHARACTER_LABEL[id]}</label>
            <div className="flex min-w-0 flex-wrap gap-2">
              {id === "orch" && <select aria-label="마스터 제공자" value={agent ?? ""} className={selectStyle} onChange={e => change(id, e.target.value ? e.target.value as AgentKind : undefined)}>
                <option value="">연결된 제공자 자동 선택</option>
                {providers.map(provider => <option key={provider} value={provider}>{AGENT_LABEL[provider]}</option>)}
              </select>}
              {agent && <select id={`character-model-${id}`} aria-label={`${MONITOR_CHARACTER_LABEL[id]} 모델`} value={selected} className={selectStyle} onChange={e => change(id, agent, e.target.value)}>
                <option value="">{!list ? "기본 모델 · 목록 확인 중" : !list.length ? "기본 모델 · 목록을 가져오지 못함" : "제공자 기본 모델"}</option>
                {selected && !list?.some(model => model.id === selected) && <option value={selected}>{selected}</option>}
                {list?.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>}
            </div>
          </div>;
        })}
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>닫기</Button>
        <Button disabled={!choices || saving} onClick={() => void save()}>{saving ? "저장 중" : "저장"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { DEFAULT_SETTINGS, parseOrchestrator, type AgentKind, type Project, type ProjectSettings } from "../../../shared/types";
import { api, cn } from "../lib/utils";
import { useStore } from "../store";
import { defaultEffortForModel, EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label, Switch } from "./ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit an existing project; omitted = create. */
  project?: Project;
}

export function ProjectDialog({ open, onOpenChange, project }: Props) {
  const createProject = useStore((s) => s.createProject);
  const updateProject = useStore((s) => s.updateProject);
  const createChat = useStore((s) => s.createChat);
  const models = useStore((s) => s.models);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setFolder(project?.folder ?? "");
    setSettings(project ? { ...DEFAULT_SETTINGS, ...project.settings } : DEFAULT_SETTINGS);
  }, [open]);

  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const setModel = (modelKey: keyof ProjectSettings, effortKey: keyof ProjectSettings, agent: AgentKind, worker: boolean, value: string) => {
    set(modelKey, value as ProjectSettings[typeof modelKey]);
    set(effortKey, defaultEffortForModel(models, agent, worker ? value : parseOrchestrator(value).model, worker) as ProjectSettings[typeof effortKey]);
  };

  const browse = async () => {
    const f = await api.pickFolder();
    if (!f) return;
    setFolder(f);
    if (!name.trim()) setName(f.split(/[\\/]/).filter(Boolean).pop() ?? "");
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (project) {
        const saved = await updateProject(project.id, { name: name.trim() || project.name, folder, settings });
        if (saved) onOpenChange(false);
      } else {
        const p = await createProject({ name: name.trim(), folder, settings });
        if (p) {
          onOpenChange(false);
          await createChat(p.id);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={project ? "프로젝트 설정" : "새 프로젝트"}
        description={project ? "모델 변경은 다음 지시부터 적용됩니다." : "작업할 폴더와 네 역할의 모델을 고르세요."}
        className="w-[min(1000px,calc(100vw-40px))]"
      >
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder) void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="proj-folder">작업 폴더</Label>
            <div className="flex gap-2">
              <Input id="proj-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="D:\\Projects\\my-app" className="font-mono text-[12.5px]" />
              <Button type="button" variant="outline" onClick={browse}>
                <FolderOpen /> 찾아보기
              </Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="proj-name">이름</Label>
            <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="폴더 이름을 그대로 씁니다" />
          </div>

          <div className="grid gap-3 rounded-lg border p-3.5">
            <div className="text-[12px] font-medium text-muted-foreground">모델</div>
            <ModelRow label="마스터" hint="지시를 받아 팀을 꾸리고 일을 나눕니다 (승인 설정에 따라 파일 수정·명령 실행)">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["claude", "codex"]}
                  value={settings.orchestratorModel}
                  onChange={(v) => setModel("orchestratorModel", "orchestratorEffort", parseOrchestrator(v).agent, false, v)}
                  ariaLabel="마스터 모델"
                  className="min-w-0"
                />
                {(() => {
                  const orch = parseOrchestrator(settings.orchestratorModel);
                  return (
                    <EffortPicker
                      agent={orch.agent}
                      model={orch.model}
                      value={settings.orchestratorEffort ?? "xhigh"}
                      onChange={(v) => set("orchestratorEffort", v)}
                      ariaLabel="마스터 추론 수준"
                    />
                  );
                })()}
              </div>
            </ModelRow>
            <ModelRow label="클로드 작업자" hint="클로드 N호 (Claude Code)">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["claude"]}
                  value={settings.claudeModel}
                  onChange={(v) => setModel("claudeModel", "claudeEffort", "claude", true, v)}
                  ariaLabel="Claude 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="claude" model={settings.claudeModel} worker value={settings.claudeEffort ?? "auto"} onChange={(v) => set("claudeEffort", v)} ariaLabel="Claude 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="지피티 작업자" hint="지피티 N호 (Codex)">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["codex"]}
                  value={settings.codexModel}
                  onChange={(v) => setModel("codexModel", "codexEffort", "codex", true, v)}
                  ariaLabel="GPT 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="codex" model={settings.codexModel} worker value={settings.codexEffort ?? "auto"} onChange={(v) => set("codexEffort", v)} ariaLabel="GPT 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="제미나이 작업자" hint="제미나이 N호 (Antigravity)">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["gemini"]}
                  value={settings.geminiModel}
                  onChange={(v) => setModel("geminiModel", "geminiEffort", "gemini", true, v)}
                  ariaLabel="Gemini 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="gemini" model={settings.geminiModel} worker value={settings.geminiEffort ?? "auto"} onChange={(v) => set("geminiEffort", v)} ariaLabel="Gemini 작업자 추론 수준" />
              </div>
            </ModelRow>
          </div>

          <div className="grid gap-3 rounded-lg border p-3.5">
            <div>
              <div className="text-[12px] font-medium text-muted-foreground">작업자 배정 참고</div>
              <div className="text-[11.5px] text-muted-foreground">마스터가 작업을 나눌 때 각 작업자의 강점과 주의점을 참고합니다.</div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="grid content-start gap-2 rounded-md border p-2.5">
                <div className="text-[13px] font-medium">클로드 작업자</div>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">잘 맡는 작업</span>
                  <textarea
                    rows={4}
                    value={settings.claudeStrengths}
                    onChange={(e) => set("claudeStrengths", e.target.value)}
                    aria-label="클로드가 잘 맡는 작업"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">주의할 점</span>
                  <textarea
                    rows={4}
                    value={settings.claudeCautions}
                    onChange={(e) => set("claudeCautions", e.target.value)}
                    aria-label="클로드 작업자 주의점"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
              </div>
              <div className="grid content-start gap-2 rounded-md border p-2.5">
                <div className="text-[13px] font-medium">지피티 작업자</div>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">잘 맡는 작업</span>
                  <textarea
                    rows={4}
                    value={settings.gptStrengths}
                    onChange={(e) => set("gptStrengths", e.target.value)}
                    aria-label="지피티가 잘 맡는 작업"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">주의할 점</span>
                  <textarea
                    rows={4}
                    value={settings.gptCautions}
                    onChange={(e) => set("gptCautions", e.target.value)}
                    aria-label="지피티 작업자 주의점"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
              </div>
              <div className="grid content-start gap-2 rounded-md border p-2.5">
                <div className="text-[13px] font-medium">제미나이 작업자</div>
                <div className="text-[11.5px] leading-snug text-muted-foreground">웹·CLI 모두 문장 다듬기·캐릭터 대사·문서 본문 등 글쓰기 전용입니다. 로컬 파일 반영은 CLI Claude/GPT가 맡습니다.</div>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">잘 맡는 작업</span>
                  <textarea
                    rows={4}
                    value={settings.geminiStrengths}
                    onChange={(e) => set("geminiStrengths", e.target.value)}
                    aria-label="제미나이가 잘 맡는 작업"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">주의할 점</span>
                  <textarea
                    rows={4}
                    value={settings.geminiCautions}
                    onChange={(e) => set("geminiCautions", e.target.value)}
                    aria-label="제미나이 작업자 주의점"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border p-3.5">
            <div className="text-[12px] font-medium text-muted-foreground">승인</div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-medium">작업자 승인 요청</div>
                <div className="text-[12px] text-muted-foreground">
                  {settings.approvalMode === "orchestrator"
                    ? "마스터가 판단해 자동으로 허용·거부하고, 애매하거나 고위험이면 물어봅니다"
                    : "작업자가 파일을 고치거나 명령을 실행할 때마다 직접 승인합니다"}
                </div>
              </div>
              <Segmented
                value={settings.approvalMode}
                onChange={(v) => set("approvalMode", v)}
                options={[
                  { value: "orchestrator", label: "마스터 판단" },
                  { value: "user", label: "직접 승인" },
                ]}
                ariaLabel="승인 방식"
              />
            </div>
            {settings.approvalMode === "orchestrator" && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[13px] font-medium">고위험 요청도 마스터에 맡기기</div>
                  <div className="text-[12px] text-muted-foreground">작업 폴더 밖 쓰기, 재귀 삭제, git push, 비밀 파일, 시스템 변경, 업로드. 끄면 이런 요청은 직접 확인합니다</div>
                </div>
                <Switch checked={settings.delegateHighRisk} onChange={(v) => set("delegateHighRisk", v)} label="고위험 요청도 맡기기" />
              </div>
            )}
          </div>

          <div className="grid gap-3 rounded-lg border p-3.5">
            <div className="text-[12px] font-medium text-muted-foreground">협업 규칙</div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-medium">코드 변경 후 교차 리뷰</div>
                <div className="text-[12px] text-muted-foreground">구현한 작업자와 다른 작업자가 끝내기 전에 리뷰합니다</div>
              </div>
              <Switch checked={settings.reviewGate} onChange={(v) => set("reviewGate", v)} label="교차 리뷰" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <NumberField label="동시 클로드 작업자" suffix="명" value={settings.maxClaudeWorkers} onChange={(v) => set("maxClaudeWorkers", v)} min={1} max={6} />
              <NumberField label="동시 지피티 작업자" suffix="명" value={settings.maxGptWorkers} onChange={(v) => set("maxGptWorkers", v)} min={1} max={6} />
              <NumberField label="동시 제미나이 작업자 (0=사용 안 함)" suffix="명" value={settings.maxGeminiWorkers} onChange={(v) => set("maxGeminiWorkers", v)} min={0} max={6} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="지시당 맡기기(기본)" suffix="회" value={settings.maxConsults} onChange={(v) => set("maxConsults", v)} min={1} max={30} />
              <NumberField label="리뷰 왕복" suffix="회" value={settings.maxReviews} onChange={(v) => set("maxReviews", v)} min={0} max={10} />
            </div>
            <div className="text-[12px] text-muted-foreground">작업 시간은 무제한입니다. 필요하면 중지 버튼으로 멈출 수 있습니다.</div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={!folder || busy}>
              {project ? "저장" : "만들기"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "default",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
  size?: "default" | "sm";
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 font-medium whitespace-nowrap transition-colors",
            size === "sm" ? "h-6 text-[12px]" : "h-7 text-[12.5px]",
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-3">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[11.5px] leading-snug text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}

function NumberField({ label, suffix, value, onChange, min, max }: { label: string; suffix: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <label className="grid gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
          className="pr-8"
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

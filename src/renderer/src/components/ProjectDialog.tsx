import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { APPROVAL_MODE_LABEL, DEFAULT_SETTINGS, MAX_CONSULTS, MAX_REVIEWS, parseOrchestrator, type AgentKind, type Project, type ProjectSettings } from "../../../shared/types";
import { api, cn } from "../lib/utils";
import { useStore } from "../store";
import { defaultEffortForModel, EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { Button, Dialog, DialogContent, DialogFooter, Input, Label, Switch } from "./ui";

const APPROVAL_MODES = ["orchestrator-all", "orchestrator", "user"] as const;
type ApprovalModeChoice = (typeof APPROVAL_MODES)[number];

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

  const selectedApprovalMode: ApprovalModeChoice = settings.approvalMode === "orchestrator" && settings.delegateHighRisk ? "orchestrator-all" : settings.approvalMode;
  const setApprovalMode = (mode: ApprovalModeChoice) => {
    set("approvalMode", mode);
    set("delegateHighRisk", mode === "orchestrator-all");
  };

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
                  agents={["claude", "codex", "gemini", "grok", "deepseek"]}
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
                      value={settings.orchestratorEffort ?? "auto"}
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
                  ariaLabel="클로드 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="claude" model={settings.claudeModel} worker value={settings.claudeEffort ?? "auto"} onChange={(v) => set("claudeEffort", v)} ariaLabel="클로드 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="지피티 작업자" hint="지피티 N호 (Codex)">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["codex"]}
                  value={settings.codexModel}
                  onChange={(v) => setModel("codexModel", "codexEffort", "codex", true, v)}
                  ariaLabel="지피티 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="codex" model={settings.codexModel} worker value={settings.codexEffort ?? "auto"} onChange={(v) => set("codexEffort", v)} ariaLabel="지피티 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="제미나이 작업자" hint="Antigravity CLI / 제미나이 웹">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker
                  agents={["gemini"]}
                  value={settings.geminiModel}
                  onChange={(v) => setModel("geminiModel", "geminiEffort", "gemini", true, v)}
                  ariaLabel="제미나이 모델"
                  className="min-w-0"
                />
                <EffortPicker agent="gemini" model={settings.geminiModel} worker value={settings.geminiEffort ?? "auto"} onChange={(v) => set("geminiEffort", v)} ariaLabel="제미나이 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="그록 작업자" hint="Grok CLI">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker agents={["grok"]} value={settings.grokModel} onChange={v => setModel("grokModel", "grokEffort", "grok", true, v)} ariaLabel="그록 모델" />
                <EffortPicker agent="grok" model={settings.grokModel} worker value={settings.grokEffort} onChange={v => set("grokEffort", v)} ariaLabel="그록 작업자 추론 수준" />
              </div>
            </ModelRow>
            <ModelRow label="딥시크 작업자" hint="DeepSeek API">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <ModelPicker agents={["deepseek"]} value={settings.deepseekModel} onChange={v => setModel("deepseekModel", "deepseekEffort", "deepseek", true, v)} ariaLabel="딥시크 모델" />
                <EffortPicker agent="deepseek" model={settings.deepseekModel} worker value={settings.deepseekEffort} onChange={v => set("deepseekEffort", v)} ariaLabel="딥시크 작업자 추론 수준" />
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
                <div className="text-[11.5px] leading-snug text-muted-foreground">글쓰기를 우선 배정하며 명시적으로 지정한 코드·이미지 작업도 수행합니다. 제미나이 웹은 로컬 도구를 사용할 수 없습니다.</div>
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
              <div className="grid content-start gap-2 rounded-md border p-2.5">
                <div className="text-[13px] font-medium">그록 작업자</div>
                <div className="text-[11.5px] leading-snug text-muted-foreground">공식 Grok CLI의 계정·모델과 도구를 사용합니다.</div>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">잘 맡는 작업</span>
                  <textarea
                    rows={4}
                    value={settings.grokStrengths}
                    onChange={(e) => set("grokStrengths", e.target.value)}
                    aria-label="그록이 잘 맡는 작업"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">주의할 점</span>
                  <textarea
                    rows={4}
                    value={settings.grokCautions}
                    onChange={(e) => set("grokCautions", e.target.value)}
                    aria-label="그록 작업자 주의점"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
              </div>
              <div className="grid content-start gap-2 rounded-md border p-2.5">
                <div className="text-[13px] font-medium">딥시크 작업자</div>
                <div className="text-[11.5px] leading-snug text-muted-foreground">DeepSeek API를 사용합니다. API 사용량에 따라 과금될 수 있으며, 잔여 한도는 표시하지 않습니다.</div>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">잘 맡는 작업</span>
                  <textarea
                    rows={4}
                    value={settings.deepseekStrengths}
                    onChange={(e) => set("deepseekStrengths", e.target.value)}
                    aria-label="딥시크가 잘 맡는 작업"
                    className="min-h-24 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[11.5px] text-muted-foreground">주의할 점</span>
                  <textarea
                    rows={4}
                    value={settings.deepseekCautions}
                    onChange={(e) => set("deepseekCautions", e.target.value)}
                    aria-label="딥시크 작업자 주의점"
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
                  {selectedApprovalMode === "orchestrator-all"
                    ? "고위험도 마스터에게 위임합니다. 명시적 거부, 작업 범위, 계획 모드 제한은 유지합니다."
                    : selectedApprovalMode === "orchestrator"
                      ? "마스터가 판단하고, 고위험하거나 불확실한 요청은 관리자에게 확인합니다."
                      : "작업자가 파일을 고치거나 명령을 실행할 때마다 관리자가 직접 승인합니다."}
                </div>
              </div>
              <Segmented
                value={selectedApprovalMode}
                onChange={setApprovalMode}
                options={APPROVAL_MODES.map((value) => ({ value, label: APPROVAL_MODE_LABEL[value] }))}
                ariaLabel="승인 방식"
              />
            </div>
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
              <NumberField label="동시 그록 작업자 (0=사용 안 함)" suffix="명" value={settings.maxGrokWorkers} onChange={(v) => set("maxGrokWorkers", v)} min={0} max={6} />
              <NumberField label="동시 딥시크 작업자 (0=사용 안 함)" suffix="명" value={settings.maxDeepseekWorkers} onChange={(v) => set("maxDeepseekWorkers", v)} min={0} max={6} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="지시당 배정 한도" suffix="회" value={settings.maxConsults} onChange={(v) => set("maxConsults", v)} min={1} max={MAX_CONSULTS} />
              <NumberField label="리뷰 왕복" suffix="회" value={settings.maxReviews} onChange={(v) => set("maxReviews", v)} min={0} max={MAX_REVIEWS} />
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

import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { DEFAULT_SETTINGS, type Project, type ProjectSettings } from "../../../shared/types";
import { api, cn } from "../lib/utils";
import { useStore } from "../store";
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
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setFolder(project?.folder ?? "");
    setSettings(project?.settings ?? DEFAULT_SETTINGS);
  }, [open, project]);

  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const browse = async () => {
    const f = await api.pickFolder();
    if (!f) return;
    setFolder(f);
    if (!name.trim()) setName(f.split(/[\\/]/).filter(Boolean).pop() ?? "");
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (project) {
        await updateProject(project.id, { name: name.trim() || project.name, folder, settings });
        onOpenChange(false);
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
        description={project ? "모델 변경은 다음 지시부터 적용됩니다." : "작업할 폴더와 세 역할의 모델을 고르세요."}
        className="w-[600px]"
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
            <ModelRow label="오케스트레이터" hint="지시를 받아 계획하고 일을 나눕니다 (읽기 전용)">
              <ModelPicker agents={["claude", "codex"]} value={settings.orchestratorModel} onChange={(v) => set("orchestratorModel", v as ProjectSettings["orchestratorModel"])} ariaLabel="오케스트레이터 모델" />
            </ModelRow>
            <ModelRow label="Claude 작업자" hint="Claude Code로 구현·리뷰">
              <ModelPicker agents={["claude"]} value={settings.claudeModel} onChange={(v) => set("claudeModel", v)} ariaLabel="Claude 모델" />
            </ModelRow>
            <ModelRow label="GPT 작업자" hint="Codex로 구현·리뷰">
              <ModelPicker agents={["codex"]} value={settings.codexModel} onChange={(v) => set("codexModel", v)} ariaLabel="GPT 모델" />
            </ModelRow>
          </div>

          <div className="grid gap-3 rounded-lg border p-3.5">
            <div className="text-[12px] font-medium text-muted-foreground">승인</div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-medium">작업자 승인 요청</div>
                <div className="text-[12px] text-muted-foreground">
                  {settings.approvalMode === "orchestrator"
                    ? "오케스트레이터가 판단해 자동으로 허용·거부하고, 애매하거나 고위험이면 물어봅니다"
                    : "작업자가 파일을 고치거나 명령을 실행할 때마다 직접 승인합니다"}
                </div>
              </div>
              <Segmented
                value={settings.approvalMode}
                onChange={(v) => set("approvalMode", v)}
                options={[
                  { value: "orchestrator", label: "오케스트레이터 판단" },
                  { value: "user", label: "직접 승인" },
                ]}
                ariaLabel="승인 방식"
              />
            </div>
            {settings.approvalMode === "orchestrator" && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[13px] font-medium">고위험 요청도 오케스트레이터에 맡기기</div>
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
              <NumberField label="지시당 협의" suffix="회" value={settings.maxConsults} onChange={(v) => set("maxConsults", v)} min={1} max={30} />
              <NumberField label="리뷰 왕복" suffix="회" value={settings.maxReviews} onChange={(v) => set("maxReviews", v)} min={0} max={10} />
              <NumberField label="지시당 시간" suffix="분" value={settings.maxMinutes} onChange={(v) => set("maxMinutes", v)} min={5} max={600} />
            </div>
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

// Projects sheet: list, create under an allowed root (D1), rename, archive, allowed settings (D3 for approval).
// Remote users never see or choose folder paths and cannot delete projects (D2).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, FolderPlus, MessageSquarePlus, Settings2 } from "lucide-react";
import {
  REMOTE_LIMITS, type RemoteChatResponse, type RemoteProject, type RemoteProjectPatch, type RemoteProjectResponse,
  type RemoteProjectSettings, type RemoteProjectsResponse,
} from "../../../shared/remote-web";
import { APPROVAL_MODE_LABEL, MAX_CONSULTS, MAX_REVIEWS, type ApprovalMode } from "../../../shared/types";
import { cn } from "../lib/utils";
import { AuthError, postConfirmed, request, url } from "./api";
import { D3_NOTICE } from "./ChatSettings";
import { APPROVAL_MODES, approvalHelp, folderNameProblem, projectApprovalMode } from "./logic";
import { MODEL_SLOTS, ModelSlotRow, useModels } from "./models";
import { askConfirm, Btn, ErrorLine, errorText, FIELD, Modal } from "./ui";

/** Projects and allowed roots; `reload` is also called on projects:updated. */
export function useProjects(onError: (e: unknown) => void) {
  const [data, setData] = useState<RemoteProjectsResponse>({ projects: [], roots: [] });
  const reload = useCallback(() => request<RemoteProjectsResponse>(url("/api/projects")).then(setData).catch(onError), [onError]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...data, reload };
}

export function ProjectsSheet({ data, onClose, onChanged, onOpenChat, onAuthError }: {
  data: RemoteProjectsResponse; onClose: () => void; onChanged: () => void; onOpenChat: (chatId: number) => void; onAuthError: (e: unknown) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try { await work(); onChanged(); } catch (e) { if (e instanceof AuthError) onAuthError(e); else setError(errorText(e)); } finally { setPending(false); }
  };
  const newChat = (projectId: number) => act(async () => {
    const { chat } = await request<RemoteChatResponse>(url("/api/chats"), { projectId });
    onOpenChat(chat.id);
  });
  const archive = (p: RemoteProject) => act(() => request<RemoteProjectResponse>(url("/api/projects/:id/update", p.id), { archived: !p.archived } satisfies RemoteProjectPatch));
  const shown = data.projects.filter(p => showArchived || !p.archived);
  const project = data.projects.find(p => p.id === editing);
  if (project) return <ProjectSettingsSheet project={project} onClose={() => { setEditing(null); onChanged(); }} onAuthError={onAuthError} />;
  return (
    <Modal title="프로젝트" onClose={onClose} wide>
      <div className="grid gap-4">
        <CreateProject roots={data.roots} onCreated={onChanged} onAuthError={onAuthError} />
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> 보관된 프로젝트도 보기</label>
        <ErrorLine error={error} />
        <ul className="grid gap-2">
          {shown.map(p => (
            <li key={p.id} className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2", p.archived && "opacity-70")}>
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}{p.archived && <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">(보관됨)</span>}</span>
              {!p.archived && <Btn variant="outline" disabled={pending} onClick={() => void newChat(p.id)}><MessageSquarePlus /> 새 채팅</Btn>}
              <Btn variant="ghost" disabled={pending} onClick={() => setEditing(p.id)} aria-label={`${p.name} 설정`}><Settings2 /></Btn>
              <Btn variant="ghost" disabled={pending} onClick={() => void archive(p)} aria-label={p.archived ? `${p.name} 보관 해제` : `${p.name} 보관`}>{p.archived ? <ArchiveRestore /> : <Archive />}</Btn>
            </li>
          ))}
          {!shown.length && <li className="text-[13px] text-muted-foreground">프로젝트가 없습니다.</li>}
        </ul>
        <p className="text-[12px] text-muted-foreground">프로젝트 삭제와 폴더 변경은 PC 앱에서만 할 수 있습니다.</p>
      </div>
    </Modal>
  );
}

/** D1: a new folder directly under one of the roots the desktop allows. */
function CreateProject({ roots, onCreated, onAuthError }: { roots: RemoteProjectsResponse["roots"]; onCreated: () => void; onAuthError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [rootId, setRootId] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<string>();
  if (!roots.length) return <p className="text-[12.5px] text-muted-foreground">새 프로젝트를 만들 수 있는 폴더가 지정되지 않았습니다. PC 앱의 원격 웹 접속 설정에서 허용 폴더를 추가하세요.</p>;
  if (!open) return <Btn className="justify-self-start" onClick={() => { setOpen(true); setRootId(roots[0].id); setCreated(undefined); }}><FolderPlus /> 새 프로젝트</Btn>;
  const folderName = folderTouched ? folder : name.trim();
  const problem = folderNameProblem(folderName);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || problem) return;
    setPending(true);
    setError(undefined);
    try {
      const { project } = await request<RemoteProjectResponse>(url("/api/projects"), { name: name.trim(), rootId, folderName });
      setCreated(`'${project.name}' 프로젝트를 만들었습니다.`);
      setOpen(false); setName(""); setFolder(""); setFolderTouched(false);
      onCreated();
    } catch (err) { if (err instanceof AuthError) onAuthError(err); else setError(errorText(err)); }
    finally { setPending(false); }
  };
  const root = roots.find(r => r.id === rootId);
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-lg border p-3">
      <h3 className="text-[13px] font-medium">새 프로젝트</h3>
      {created && <div role="status" className="text-[12.5px] text-success">{created}</div>}
      <label htmlFor="project-name" className="text-[12.5px]">이름</label>
      <input id="project-name" value={name} maxLength={REMOTE_LIMITS.title} onChange={e => setName(e.target.value)} className={FIELD} autoFocus />
      <label htmlFor="project-root" className="text-[12.5px]">만들 위치</label>
      <select id="project-root" value={rootId} onChange={e => setRootId(e.target.value)} className={FIELD}>
        {roots.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      <label htmlFor="project-folder" className="text-[12.5px]">새 폴더 이름</label>
      <input id="project-folder" value={folderName} maxLength={REMOTE_LIMITS.folderName} autoCapitalize="none" spellCheck={false}
        onChange={e => { setFolder(e.target.value); setFolderTouched(true); }} className={FIELD} />
      <p className="text-[12px] text-muted-foreground">{root?.label} 아래에 새 폴더를 만듭니다. 이미 있는 폴더는 쓸 수 없습니다.</p>
      {folderName && problem && <ErrorLine error={problem} />}
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <Btn variant="outline" onClick={() => setOpen(false)}>취소</Btn>
        <Btn type="submit" disabled={pending || !name.trim() || !!problem}>만들기</Btn>
      </div>
    </form>
  );
}

const TEXT_FIELDS = [
  ["claudeStrengths", "클로드 강점"], ["claudeCautions", "클로드 주의"], ["gptStrengths", "지피티 강점"], ["gptCautions", "지피티 주의"],
  ["geminiStrengths", "제미나이 강점"], ["geminiCautions", "제미나이 주의"], ["grokStrengths", "그록 강점"], ["grokCautions", "그록 주의"],
  ["deepseekStrengths", "딥시크 강점"], ["deepseekCautions", "딥시크 주의"],
] as const satisfies readonly (readonly [keyof RemoteProjectSettings, string])[];
const NUMBER_FIELDS = [
  ["maxClaudeWorkers", "동시 클로드 작업자", 1, 6], ["maxGptWorkers", "동시 지피티 작업자", 1, 6],
  ["maxGeminiWorkers", "동시 제미나이 작업자 (0=사용 안 함)", 0, 6], ["maxGrokWorkers", "동시 그록 작업자 (0=사용 안 함)", 0, 6],
  ["maxDeepseekWorkers", "동시 딥시크 작업자 (0=사용 안 함)", 0, 6],
  ["maxConsults", "지시당 배정 한도", 1, MAX_CONSULTS], ["maxReviews", "리뷰 왕복", 0, MAX_REVIEWS],
] as const satisfies readonly (readonly [keyof RemoteProjectSettings, string, number, number])[];

/** Only changed fields are sent; raising approval autonomy asks for confirmation (server 428). */
function ProjectSettingsSheet({ project, onClose, onAuthError }: { project: RemoteProject; onClose: () => void; onAuthError: (e: unknown) => void }) {
  const models = useModels();
  const [name, setName] = useState(project.name);
  const [draft, setDraft] = useState<RemoteProjectSettings>(project.settings);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const set = <K extends keyof RemoteProjectSettings>(key: K, value: RemoteProjectSettings[K]) => setDraft(d => ({ ...d, [key]: value }));
  const changed = (Object.keys(draft) as (keyof RemoteProjectSettings)[]).filter(k => draft[k] !== project.settings[k]);
  const dirty = changed.length > 0 || name.trim() !== project.name;
  const mode = projectApprovalMode(draft);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: RemoteProjectPatch = {};
    if (name.trim() && name.trim() !== project.name) body.name = name.trim();
    if (changed.length) body.settings = Object.fromEntries(changed.map(k => [k, draft[k]])) as Partial<RemoteProjectSettings>;
    setPending(true);
    setError(undefined);
    try {
      const done = await postConfirmed<RemoteProjectResponse>(url("/api/projects/:id/update", project.id), body as Record<string, unknown>, m => askConfirm(`${D3_NOTICE}\n\n${m}`));
      if (done) onClose();
    } catch (err) { if (err instanceof AuthError) onAuthError(err); else setError(errorText(err)); }
    finally { setPending(false); }
  };
  return (
    <Modal title={`프로젝트 설정 · ${project.name}`} onClose={onClose} wide>
      <form onSubmit={save} className="grid gap-5">
        <div className="grid gap-1.5">
          <label htmlFor="ps-name" className="text-[13px] font-medium">이름</label>
          <input id="ps-name" value={name} maxLength={REMOTE_LIMITS.title} onChange={e => setName(e.target.value)} className={FIELD} />
        </div>
        <section className="grid gap-1.5">
          <label htmlFor="ps-approval" className="text-[13px] font-medium">승인 방식</label>
          <select id="ps-approval" value={mode} className={FIELD} onChange={e => {
            const m = e.target.value as ApprovalMode;
            setDraft(d => ({ ...d, approvalMode: m, delegateHighRisk: m === "orchestrator-all" }));
          }}>
            {APPROVAL_MODES.map(m => <option key={m} value={m}>{APPROVAL_MODE_LABEL[m]}</option>)}
          </select>
          <p className="text-[12px] text-muted-foreground">{approvalHelp(mode)}</p>
        </section>
        <section className="grid gap-3">
          <h3 className="text-[13px] font-medium">모델·추론 수준</h3>
          {!models ? <p className="text-[12.5px] text-muted-foreground">모델 목록을 불러오는 중…</p> : (
            <div className="grid gap-4 sm:grid-cols-2">
              {MODEL_SLOTS.map(s => (
                <ModelSlotRow key={s.slot} models={models} slot={s.slot} label={s.label} worker={s.worker} allowInherit={false}
                  value={draft[`${s.slot}Model`]} inheritedValue={draft[`${s.slot}Model`]} effort={draft[`${s.slot}Effort`]} inheritedEffort={draft[`${s.slot}Effort`]}
                  onModel={v => setDraft(d => ({ ...d, [`${s.slot}Model`]: v ?? "", [`${s.slot}Effort`]: "auto" }))}
                  onEffort={v => setDraft(d => ({ ...d, [`${s.slot}Effort`]: v ?? "auto" }))} />
              ))}
            </div>
          )}
        </section>
        <section className="grid gap-2">
          <h3 className="text-[13px] font-medium">작업 한도</h3>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.reviewGate} onChange={e => set("reviewGate", e.target.checked)} /> 코드 변경을 마치기 전에 리뷰 받기</label>
          <div className="grid gap-2 sm:grid-cols-2">
            {NUMBER_FIELDS.map(([key, label, min, max]) => (
              <label key={key} className="grid gap-1 text-[12.5px]">{label}
                <input type="number" inputMode="numeric" min={min} max={max} value={draft[key]} className={FIELD}
                  onChange={e => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) set(key, Math.min(max, Math.max(min, n))); }} />
              </label>
            ))}
          </div>
        </section>
        <details>
          <summary className="cursor-pointer text-[13px] font-medium">작업자 강점·주의 문구</summary>
          <div className="mt-2 grid gap-2">
            {TEXT_FIELDS.map(([key, label]) => (
              <label key={key} className="grid gap-1 text-[12.5px]">{label}
                <textarea rows={3} value={draft[key]} onChange={e => set(key, e.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
              </label>
            ))}
          </div>
        </details>
        <ErrorLine error={error} />
        <div className="sticky bottom-0 flex justify-end gap-2 bg-background py-2">
          <Btn variant="outline" onClick={onClose}>닫기</Btn>
          <Btn type="submit" disabled={pending || !dirty || !name.trim()}>저장</Btn>
        </div>
      </form>
    </Modal>
  );
}

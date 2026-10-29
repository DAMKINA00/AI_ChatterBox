// Chat sheet: rename, archive, per-chat models/efforts, approval mode (D3) and delete (D8).
import { useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { REMOTE_LIMITS, type RemoteChatPatch, type RemoteChatResponse, type RemoteProject } from "../../../shared/remote-web";
import { APPROVAL_MODE_LABEL, type ApprovalMode, type Chat } from "../../../shared/types";
import { AuthError, postConfirmed, request, url } from "./api";
import { APPROVAL_MODES, approvalHelp, projectApprovalMode } from "./logic";
import { MODEL_SLOTS, ModelSlotRow, useModels } from "./models";
import { askConfirm, Btn, ErrorLine, errorText, FIELD, Modal } from "./ui";

const busyStatus = (s: Chat["status"]) => s === "working" || s === "approval" || s === "pausing" || s === "paused";
export const D3_NOTICE = "원격에서 마스터의 자율성을 높입니다. 작업자의 요청을 마스터가 더 많이 직접 승인하게 됩니다. 이 변경은 앱의 원격 변경 기록에 남습니다.";

export function ChatSettings({ chat, project, onClose, onDeleted, onAuthError }: {
  chat: Chat; project?: RemoteProject; onClose: () => void; onDeleted: () => void; onAuthError: (e: unknown) => void;
}) {
  const models = useModels();
  const [title, setTitle] = useState(chat.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try { await work(); if (done) setNotice(done); }
    catch (e) { if (e instanceof AuthError) onAuthError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  };
  const patch = (body: RemoteChatPatch, done?: string) =>
    run(() => postConfirmed<RemoteChatResponse>(url("/api/chats/:id/update", chat.id), body as Record<string, unknown>, m => askConfirm(`${D3_NOTICE}\n\n${m}`))
      .then(r => { if (!r) throw new Error("변경을 취소했습니다."); }), done);

  const rename = (e: FormEvent) => {
    e.preventDefault();
    const next = title.trim();
    if (next && next !== chat.title) void patch({ title: next }, "이름을 바꿨습니다.");
  };
  const projectMode = project ? projectApprovalMode(project.settings) : null;

  return (
    <Modal title="채팅 설정" onClose={onClose} wide>
      <div className="grid gap-5">
        <form onSubmit={rename} className="grid gap-1.5">
          <label htmlFor="chat-title" className="text-[13px] font-medium">이름</label>
          <div className="flex gap-2">
            <input id="chat-title" value={title} maxLength={REMOTE_LIMITS.title} onChange={e => setTitle(e.target.value)} className={FIELD} />
            <Btn type="submit" disabled={pending || !title.trim() || title.trim() === chat.title}>저장</Btn>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="outline" disabled={pending} onClick={() => void patch({ archived: !chat.archived }, chat.archived ? "보관을 해제했습니다." : "보관했습니다.")}>
            {chat.archived ? <><ArchiveRestore /> 보관 해제</> : <><Archive /> 보관</>}
          </Btn>
        </div>

        <section className="grid gap-1.5">
          <label htmlFor="chat-approval" className="text-[13px] font-medium">승인 방식</label>
          <select id="chat-approval" disabled={pending} className={FIELD} value={chat.approvalModeOverride ?? ""}
            onChange={e => void patch({ approvalModeOverride: (e.target.value || null) as ApprovalMode | null }, "승인 방식을 바꿨습니다.")}>
            <option value="">프로젝트 값 사용{projectMode ? ` (${APPROVAL_MODE_LABEL[projectMode]})` : ""}</option>
            {APPROVAL_MODES.map(m => <option key={m} value={m}>{APPROVAL_MODE_LABEL[m]}</option>)}
          </select>
          <p className="text-[12px] text-muted-foreground">{approvalHelp(chat.approvalModeOverride ?? projectMode ?? "orchestrator")}</p>
        </section>

        <section className="grid gap-3">
          <h3 className="text-[13px] font-medium">모델·추론 수준 <span className="font-normal text-muted-foreground">(이 채팅만)</span></h3>
          {!models || !project ? <p className="text-[12.5px] text-muted-foreground">모델 목록을 불러오는 중…</p> : (
            <div className="grid gap-4 sm:grid-cols-2">
              {MODEL_SLOTS.map(s => (
                <ModelSlotRow key={s.slot} models={models} slot={s.slot} label={s.label} worker={s.worker} allowInherit disabled={pending}
                  value={chat[`${s.slot}ModelOverride`]} inheritedValue={project.settings[`${s.slot}Model`]}
                  effort={chat[`${s.slot}EffortOverride`]} inheritedEffort={project.settings[`${s.slot}Effort`]}
                  onModel={v => void patch({ [`${s.slot}ModelOverride`]: v, [`${s.slot}EffortOverride`]: v === null ? null : "auto" } as RemoteChatPatch, `${s.label} 모델을 바꿨습니다.`)}
                  onEffort={v => void patch({ [`${s.slot}EffortOverride`]: v } as RemoteChatPatch, `${s.label} 추론 수준을 바꿨습니다.`)} />
              ))}
            </div>
          )}
        </section>

        <ErrorLine error={error} />
        {notice && <div role="status" className="text-[12.5px] text-success">{notice}</div>}

        <DeleteChat chat={chat} onDeleted={onDeleted} onAuthError={onAuthError} />
      </div>
    </Modal>
  );
}

/** D8: the exact title must be typed; running chats must be stopped first (the server answers 409). */
function DeleteChat({ chat, onDeleted, onAuthError }: { chat: Chat; onDeleted: () => void; onAuthError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = busyStatus(chat.status);
  const remove = async () => {
    setPending(true);
    setError(undefined);
    try { await request(url("/api/chats/:id/delete", chat.id), { confirm: typed }); onDeleted(); }
    catch (e) { if (e instanceof AuthError) onAuthError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  };
  return (
    <section className="grid gap-2 rounded-lg border border-destructive/40 p-3">
      <h3 className="text-[13px] font-medium text-destructive">채팅 삭제</h3>
      {busy ? <p className="text-[12.5px] text-muted-foreground">작업 중인 채팅은 삭제할 수 없습니다. 먼저 중지하세요.</p>
        : !open ? <Btn variant="outline" className="justify-self-start text-destructive" onClick={() => setOpen(true)}><Trash2 /> 삭제…</Btn>
          : <>
            <p className="text-[12.5px]">대화 기록이 모두 지워지며 되돌릴 수 없습니다. 원격 웹으로 올린 첨부 파일도 보낸 것까지 함께 지워집니다(데스크톱에서 붙인 첨부 파일은 남습니다). 확인을 위해 채팅 이름 <b className="break-all">{chat.title}</b> 을(를) 그대로 입력하세요.</p>
            <input aria-label="삭제 확인용 채팅 이름" value={typed} onChange={e => setTyped(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} className={FIELD} />
            <div className="flex gap-2">
              <Btn variant="outline" onClick={() => { setOpen(false); setTyped(""); }}>취소</Btn>
              <Btn variant="destructive" disabled={pending || typed !== chat.title} onClick={() => void remove()}><Trash2 /> 영구 삭제</Btn>
            </div>
          </>}
      <ErrorLine error={error} />
    </section>
  );
}

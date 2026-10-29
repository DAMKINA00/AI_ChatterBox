// Instruction box: now/next delivery, slash commands (/plan /goal /review /compact /stop) and uploads (D4).
import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, SquareSlash, X } from "lucide-react";
import { REMOTE_LIMITS, type RemoteAttachmentList, type RemoteAttachmentRemove, type RemoteAttachmentResponse, type RemoteSendRequest, type RemoteUpload } from "../../../shared/remote-web";
import type { Chat } from "../../../shared/types";
import { AuthError, request, url } from "./api";
import { ATTACHMENT_ACCEPT, attachmentMime, attachmentProblem, COMMAND_HELP, formatBytes, parseSlash, toBase64 } from "./logic";
import { Btn, ErrorLine, errorText } from "./ui";

const ACCEPT = ATTACHMENT_ACCEPT;
const busyStatus = (s: Chat["status"]) => s === "working" || s === "approval" || s === "pausing" || s === "paused";

// One instance per chat (ChatPane is keyed by chat id).
export function Composer({ chat, onError }: { chat: Chat; onError: (e: unknown) => void }) {
  const [text, setText] = useState("");
  /** Unsent uploads as the server lists them ({id, uuid} each); refreshed after every change instead of tracked here. */
  const [attachments, setAttachments] = useState<RemoteUpload[]>([]);
  const [uploading, setUploading] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const listed = useRef(0);
  const busy = busyStatus(chat.status);
  const paused = chat.status === "paused";

  const fail = (e: unknown) => { if (e instanceof AuthError) onError(e); else setError(errorText(e)); };
  /** Only the latest listing is applied, so an older answer cannot hide a newer upload. */
  const refresh = async () => {
    const n = ++listed.current;
    try {
      const { attachments } = await request<RemoteAttachmentList>(url("/api/chats/:id/attachments", chat.id));
      if (n === listed.current) setAttachments(attachments);
    } catch (e) { if (n === listed.current) fail(e); }
  };
  useEffect(() => { void refresh(); }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(undefined);
    let count = attachments.length;
    for (const file of Array.from(files)) {
      const problem = attachmentProblem(file, count);
      if (problem) { setError(problem); continue; }
      count++;
      setUploading(n => n + 1);
      try {
        const data = toBase64(new Uint8Array(await file.arrayBuffer()));
        const { attachment } = await request<RemoteAttachmentResponse>(url("/api/chats/:id/attachments", chat.id), { name: file.name, mime: attachmentMime(file.name, file.type), data });
        setAttachments(list => [...list, attachment]);
      } catch (e) { count--; fail(e); }
      finally { setUploading(n => n - 1); }
    }
    await refresh();
  };
  const removeAttachment = async (a: RemoteUpload) => {
    const body: RemoteAttachmentRemove = { uuid: a.uuid };
    try { await request(url("/api/attachments/:id/remove", a.id), body); setAttachments(list => list.filter(x => x.uuid !== a.uuid)); }
    catch (e) { fail(e); }
    await refresh();
  };

  const send = async (delivery: "now" | "next") => {
    const slash = attachments.length ? null : parseSlash(text);
    if (slash?.kind === "error") { setError(slash.message); return; }
    if (!text.trim() && !attachments.length) return;
    setPending(true);
    setError(undefined);
    try {
      if (slash?.kind === "stop") await request(url("/api/chats/:id/stop", chat.id), {});
      else if (slash?.kind === "command") await request(url("/api/chats/:id/command", chat.id), { name: slash.name, arg: slash.arg });
      else {
        const body: RemoteSendRequest = { text, delivery, ...(attachments.length ? { attachments: attachments.map(({ id, uuid }) => ({ id, uuid })) } : {}) };
        try { await request(url("/api/chats/:id/send", chat.id), body); }
        finally { if (attachments.length) await refresh(); } // 409: removed or replaced meanwhile; the text is kept for a retry
      }
      setText("");
    } catch (e) { fail(e); }
    finally { setPending(false); }
  };

  const pick = (name: string, needsArg?: boolean, hasArgs?: boolean) => {
    setMenu(false);
    if (!needsArg && !hasArgs) { void (async () => { setPending(true); try { await request(url("/api/chats/:id/command", chat.id), { name, arg: "" }); } catch (e) { fail(e); } finally { setPending(false); } })(); return; }
    setText(`/${name} `);
    box.current?.focus();
  };

  const canSend = (!!text.trim() || attachments.length > 0) && !pending && !uploading && text.length <= REMOTE_LIMITS.text;
  return (
    <div className="border-t bg-background px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto grid max-w-3xl gap-2">
        <ErrorLine error={error} />
        {menu && (
          <ul className="grid gap-1 rounded-lg border bg-card p-1" aria-label="명령">
            {COMMAND_HELP.map(c => (
              <li key={c.name}><button type="button" className="flex w-full flex-wrap items-baseline gap-x-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-accent" onClick={() => pick(c.name, c.needsArg, !!c.args)}>
                <span className="font-mono font-medium">/{c.name}</span>{c.args && <span className="font-mono text-[11.5px] text-muted-foreground">{c.args}</span>}<span className="text-[12px] text-muted-foreground">{c.desc}</span>
              </button></li>
            ))}
          </ul>
        )}
        {(attachments.length > 0 || uploading > 0) && (
          <ul className="flex flex-wrap gap-1.5" aria-label="보낼 첨부">
            {attachments.map(a => (
              <li key={a.uuid} className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-[12px]">
                <span className="min-w-0 truncate">{a.name}</span><span className="shrink-0 text-muted-foreground">{formatBytes(a.size)}</span>
                <button type="button" className="rounded p-1 hover:bg-accent" aria-label={`${a.name} 첨부 제거`} onClick={() => void removeAttachment(a)}><X className="size-3.5" /></button>
              </li>
            ))}
            {uploading > 0 && <li className="px-2 py-1 text-[12px] text-muted-foreground">올리는 중… ({uploading})</li>}
          </ul>
        )}
        <textarea ref={box} value={text} onChange={e => setText(e.target.value)} rows={3} aria-label="지시 입력" maxLength={REMOTE_LIMITS.text}
          placeholder={paused ? "추가 지시는 재개할 때 전달 (/ 로 명령)" : busy ? "작업 중 추가 지시 (Ctrl+Enter 즉시 전달)" : "새 지시 (Ctrl+Enter 보내기 · / 로 명령)"}
          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (canSend) void send("now"); } }}
          className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={e => { void upload(e.target.files); e.target.value = ""; }} />
          <Btn variant="ghost" onClick={() => fileInput.current?.click()} aria-label="파일 첨부" disabled={attachments.length >= REMOTE_LIMITS.attachmentsPendingPerChat}><Paperclip /></Btn>
          <Btn variant="ghost" onClick={() => setMenu(v => !v)} aria-label="명령" aria-expanded={menu}><SquareSlash /></Btn>
          <div className="flex-1" />
          {busy ? <>
            <Btn variant="outline" disabled={!canSend} onClick={() => void send("next")}>다음 순서 예약</Btn>
            <Btn disabled={!canSend} onClick={() => void send("now")}><Send /> 즉시 전달</Btn>
          </> : <Btn disabled={!canSend} onClick={() => void send("now")}><Send /> 보내기</Btn>}
        </div>
      </div>
    </div>
  );
}

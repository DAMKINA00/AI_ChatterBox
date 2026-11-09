import { useContext, useState } from "react";
import { ChevronRight, Loader2, Split } from "lucide-react";
import type { Chat, ChatForkOptions } from "../../../shared/types";
import { FORK_NOT_COPIED, FORK_NOTE, FORK_RANGE_LABEL, forkOriginText, forkPreview } from "../lib/fork";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import type { Item } from "../timeline";
import { ChatSearchQuery } from "./ChatSearch";
import { Markdown } from "./Markdown";
import { AttachmentChip } from "./Items";
import { Button, Dialog, DialogContent, DialogFooter } from "./ui";

/** Message action: fork the conversation at this message. Shown on hover/focus like the copy button. */
export function ForkMessageButton({ chatId, eventId, preview, className }: { chatId: number; eventId: number; preview: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-chat-search-ignore
        className={cn("inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-sm hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", className)}
        aria-label="이 메시지에서 대화 분기"
        title="이 메시지에서 대화 분기"
        data-testid="fork-message"
        onClick={() => setOpen(true)}
      >
        <Split className="size-3" /> 분기
      </button>
      {open && <ForkDialog chatId={chatId} eventId={eventId} preview={preview} onClose={() => setOpen(false)} />}
    </>
  );
}

function ForkDialog({ chatId, eventId, preview, onClose }: { chatId: number; eventId: number; preview: string; onClose: () => void }) {
  const forkChat = useStore((s) => s.forkChat);
  const [range, setRange] = useState<ChatForkOptions["range"]>("through");
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const chat = await forkChat(chatId, { eventId, range, includeAttachments });
    setBusy(false);
    if (chat) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent title="대화 분기" description={FORK_NOTE} data-testid="fork-dialog">
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-[12.5px]">
          <div className="mb-0.5 text-[11px] text-muted-foreground">기준 메시지 #{eventId}</div>
          <div className="line-clamp-3 break-words whitespace-pre-wrap">{preview || "(첨부만 있는 메시지)"}</div>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[12.5px] font-medium">가져올 범위</legend>
          {(["through", "from"] as const).map((value) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-[13px]">
              <input type="radio" name="fork-range" value={value} checked={range === value} onChange={() => setRange(value)} data-testid={`fork-range-${value}`} />
              {FORK_RANGE_LABEL[value]}
            </label>
          ))}
        </fieldset>
        <label className="flex cursor-pointer items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={includeAttachments} onChange={(e) => setIncludeAttachments(e.target.checked)} data-testid="fork-attachments" />
          <span>
            첨부 파일 포함
            <span className="block text-[11.5px] text-muted-foreground">포함하면 새 채팅에 독립 사본으로 복사합니다. 제외하면 첨부 내용은 새 대화에 전달되지 않습니다.</span>
          </span>
        </label>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{FORK_NOT_COPIED}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>취소</Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="fork-submit">
            {busy ? <Loader2 className="animate-spin" /> : <Split />} 새 채팅으로 분기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Origin of a forked chat. The source may be deleted later; its title/id stay shown. */
export function ForkOrigin({ chat }: { chat: Chat }) {
  const exists = useStore((s) => !!chat.fork && s.chats.some((c) => c.id === chat.fork!.sourceChatId));
  const select = useStore((s) => s.select);
  if (!chat.fork) return null;
  const fork = chat.fork;
  return (
    <div className="mx-auto mt-3 flex w-[min(860px,calc(100%-32px))] flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed px-3.5 py-2 text-[12px]" data-testid="fork-origin">
      <Split className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words">{forkOriginText(fork)}</span>
      <span className="text-[11.5px] text-muted-foreground">작업 폴더는 원본과 공유</span>
      {exists ? (
        <Button size="xs" variant="ghost" onClick={() => void select({ chatId: fork.sourceChatId })} data-testid="fork-open-source">원본 열기</Button>
      ) : (
        <span className="text-[11.5px] text-muted-foreground" data-testid="fork-source-missing">원본 없음(삭제됨)</span>
      )}
    </div>
  );
}

/** Read-only transcript the fork started from; collapsed by default, opened while searching. */
export function ForkContextCard({ item }: { item: Extract<Item, { kind: "fork" }> }) {
  const [open, setOpen] = useState(false);
  const searching = !!useContext(ChatSearchQuery).trim();
  const shown = open || searching;
  return (
    <div className="overflow-hidden rounded-xl border border-dashed bg-card" data-testid="fork-context">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/60" aria-expanded={shown} disabled={searching} onClick={() => setOpen(!open)} data-testid="fork-context-toggle">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", shown && "rotate-90")} />
        <Split className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[12.5px] font-medium">분기 원문</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">읽기 전용{item.attachments.length ? ` · 첨부 ${item.attachments.length}개` : ""}</span>
        {!shown && <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{forkPreview(item.text)}</span>}
      </button>
      {shown && (
        <div className="space-y-2 border-t p-3">
          <div data-chat-search-text className="max-h-[60vh] overflow-y-auto"><Markdown text={item.text} className="text-[12.5px]" /></div>
          {item.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="fork-context-attachments">
              {item.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

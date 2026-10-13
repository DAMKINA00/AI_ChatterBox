import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ImagePlus, Loader2, Paperclip, SendHorizontal, Square, Workflow } from "lucide-react";
import { parseOrchestrator, ROLE_LABEL, CONSULT_KIND_LABEL, type AttachmentRef, type Chat, type NodeId, type Project } from "../../../shared/types";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { buildItems } from "../timeline";
import { AttachmentChip, ItemList, RoleDot } from "./Items";
import { ModelPicker, useModelLabel } from "./ModelPicker";
import { Badge, Button, Kbd, Tooltip } from "./ui";
import { StatusIcon } from "./Sidebar";

export function ChatView({ chat, project, node }: { chat: Chat; project: Project; node?: NodeId }) {
  const events = useStore((s) => s.events[chat.id]);
  const consults = useStore((s) => s.consults[chat.id]);
  const busy = chat.status === "working" || chat.status === "approval";
  const items = useMemo(() => buildItems(events ?? [], node, busy), [events, node, busy]);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);

  const nodeLabel = useMemo(() => {
    if (!node) return null;
    if (node.startsWith("consult:")) {
      const c = consults?.find((x) => x.id === Number(node.slice(8)));
      return c ? `협의 ${c.seq} · ${ROLE_LABEL[c.toRole]} ${CONSULT_KIND_LABEL[c.kind]}` : "협의";
    }
    return `${ROLE_LABEL[node as "orch"]} 대화`;
  }, [node, consults]);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles([...e.dataTransfer.files]);
      }}
    >
      <ChatHeader chat={chat} project={project} nodeLabel={nodeLabel} busy={busy} />
      <Timeline items={items} chatId={chat.id} busy={busy} empty={!events?.length} loading={!events} />
      {node && node !== "orch" ? (
        <div className="border-t px-6 py-2.5 text-center text-[12px] text-muted-foreground">
          {nodeLabel} 기록입니다. 지시는{" "}
          <button className="text-primary hover:underline" onClick={() => void useStore.getState().select({ chatId: chat.id })}>
            채팅 화면
          </button>
          에서 보내세요.
        </div>
      ) : (
        <Composer ref={composer} chat={chat} busy={busy} />
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-primary/8 text-primary">
          <ImagePlus className="size-8" />
          <div className="text-[14px] font-medium">여기에 놓아 첨부</div>
        </div>
      )}
    </div>
  );
}

function ChatHeader({ chat, project, nodeLabel, busy }: { chat: Chat; project: Project; nodeLabel: string | null; busy: boolean }) {
  const updateChat = useStore((s) => s.updateChat);
  const toast = useStore((s) => s.toast);
  const label = useModelLabel();
  const orch = parseOrchestrator(project.settings.orchestratorModel);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <StatusIcon status={chat.status} unread={false} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[14px] font-semibold">
            <span className="truncate" data-testid="chat-title">
              {chat.title}
            </span>
            {nodeLabel && <span className="shrink-0 font-normal text-muted-foreground">· {nodeLabel}</span>}
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground" title={project.folder}>
            {project.name} · {project.folder}
          </div>
        </div>
      </div>
      <Tooltip content="오케스트레이터 모델은 프로젝트 설정에서 바꿉니다">
        <Badge className="h-7 gap-1.5 px-2 text-[12px] font-normal" data-testid="orch-badge">
          <RoleDot role="orch" />
          오케스트레이터 · {label(orch.agent, orch.model)}
        </Badge>
      </Tooltip>
      <div className="flex items-center gap-1.5">
        <RoleDot role="claude" />
        <ModelPicker
          compact
          agents={["claude"]}
          ariaLabel="이 채팅의 Claude 모델"
          value={chat.claudeModelOverride ?? project.settings.claudeModel}
          inherited={chat.claudeModelOverride === null}
          onChange={(v) => void updateChat(chat.id, { claudeModelOverride: v })}
          onReset={() => void updateChat(chat.id, { claudeModelOverride: null })}
          resetLabel={`프로젝트 값 사용 (${label("claude", project.settings.claudeModel)})`}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <RoleDot role="gpt" />
        <ModelPicker
          compact
          agents={["codex"]}
          ariaLabel="이 채팅의 GPT 모델"
          value={chat.codexModelOverride ?? project.settings.codexModel}
          inherited={chat.codexModelOverride === null}
          onChange={(v) => void updateChat(chat.id, { codexModelOverride: v })}
          onReset={() => void updateChat(chat.id, { codexModelOverride: null })}
          resetLabel={`프로젝트 값 사용 (${label("codex", project.settings.codexModel)})`}
        />
      </div>
      {busy && (
        <Button
          size="sm"
          variant="destructive"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            try {
              await api.stop(chat.id);
            } catch (e) {
              toast(errorMessage(e));
              setStopping(false);
            }
          }}
          data-testid="stop"
        >
          {stopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
          {stopping ? "중지하는 중" : "중지"}
        </Button>
      )}
    </header>
  );
}

function Timeline({ items, chatId, busy, empty, loading }: { items: ReturnType<typeof buildItems>; chatId: number; busy: boolean; empty: boolean; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatId]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        className="h-full overflow-y-auto"
        data-testid="timeline"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div className="mx-auto max-w-[860px] px-6 py-6">
          {loading ? (
            <div className="flex justify-center py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : empty ? (
            <EmptyChat />
          ) : (
            <ItemList items={items} chatId={chatId} />
          )}
          {busy && (
            <div className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground" data-testid="working">
              <Loader2 className="size-3.5 animate-spin" /> 작업 중…
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <Button
          variant="secondary"
          size="icon-sm"
          className="absolute right-6 bottom-3 rounded-full border shadow-md"
          aria-label="맨 아래로"
          onClick={() => {
            const el = ref.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-claude to-gpt text-white shadow">
        <Workflow className="size-6" />
      </div>
      <div className="text-[15px] font-semibold">무엇을 할까요?</div>
      <div className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
        지시를 보내면 오케스트레이터가 계획을 세우고 Claude와 GPT에게 구현과 리뷰를 나눠 맡깁니다. 이미지는 붙여넣기(Ctrl+V)나 끌어다 놓기로 첨부할 수 있어요.
      </div>
    </div>
  );
}

// ---------- Composer
export interface ComposerHandle {
  addFiles(files: File[]): void;
}

/** Unsent text and attachments survive switching chats. */
const drafts = new Map<number, { text: string; attachments: AttachmentRef[] }>();


const Composer = forwardRef<ComposerHandle, { chat: Chat; busy: boolean }>(function Composer({ chat, busy }, ref) {
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState(() => drafts.get(chat.id)?.text ?? "");
  const [attachments, setAttachments] = useState<AttachmentRef[]>(() => drafts.get(chat.id)?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    drafts.set(chat.id, { text, attachments });
  }, [chat.id, text, attachments]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(240, Math.max(44, el.scrollHeight)) + "px";
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, [chat.id]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setUploading((n) => n + files.length);
      try {
        for (const f of files) {
          const path = api.pathForFile(f);
          const added = path
            ? await api.attachFromPaths(chat.id, [path])
            : [await api.attachFromBytes(chat.id, f.name || "clipboard.png", f.type, new Uint8Array(await f.arrayBuffer()))];
          setAttachments((a) => [...a, ...added]);
        }
      } catch (e) {
        toast(`첨부하지 못했습니다: ${errorMessage(e)}`);
      } finally {
        setUploading((n) => n - files.length);
      }
    },
    [chat.id, toast],
  );

  useImperativeHandle(ref, () => ({ addFiles: (f) => void addFiles(f) }), [addFiles]);

  const send = async () => {
    const t = text.trim();
    if ((!t && !attachments.length) || sending || uploading) return;
    setSending(true);
    try {
      await api.send(
        chat.id,
        t,
        attachments.map((a) => a.id),
      );
      setText("");
      setAttachments([]);
      drafts.delete(chat.id);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const canSend = (!!text.trim() || attachments.length > 0) && !sending && !uploading;

  return (
    <div className="px-4 pt-1 pb-4">
      <div className="mx-auto max-w-[860px] rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/60">
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="pending-attachments">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                a={a}
                onRemove={() => {
                  setAttachments((list) => list.filter((x) => x.id !== a.id));
                  void api.removeAttachment(a.id);
                }}
              />
            ))}
            {uploading > 0 && (
              <div className="flex size-16 items-center justify-center rounded-lg border">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          aria-label="메시지 입력"
          placeholder={busy ? "추가 지시를 보내면 다음 단계에 오케스트레이터에게 전달됩니다" : "지시를 입력하세요"}
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-relaxed outline-none select-text placeholder:text-muted-foreground"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Tooltip content="파일 첨부">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="파일 첨부"
              onClick={async () => {
                try {
                  const added = await api.pickAttachments(chat.id);
                  setAttachments((a) => [...a, ...added]);
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              <Paperclip />
            </Button>
          </Tooltip>
          <span className="ml-1 hidden text-[11.5px] text-muted-foreground sm:inline">
            <Kbd>Enter</Kbd> 보내기 · <Kbd>Shift+Enter</Kbd> 줄바꿈 · <Kbd>Ctrl+V</Kbd> 이미지 붙여넣기
          </span>
          <div className="flex-1" />
          <Button size="sm" onClick={() => void send()} disabled={!canSend} aria-label="보내기" data-testid="send" className={cn("rounded-full px-3.5")}>
            {sending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
            {busy ? "추가 지시" : "보내기"}
          </Button>
        </div>
      </div>
    </div>
  );
});

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Hand,
  KeyRound,
  Loader2,
  MessageCircleQuestion,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { CONSULT_KIND_LABEL, MASTER_LABEL, roleName, roleTone, type AgentExpression, type AttachmentRef, type Role } from "../../../shared/types";
import { api, cn, errorMessage, formatBytes } from "../lib/utils";
import { useStore } from "../store";
import type { Item } from "../timeline";
import { Markdown, CopyButton } from "./Markdown";
import { FileLink } from "./FileLink";
import { DiffList, Stats } from "./DiffView";
import { AgentAvatar, type AvatarSize } from "./AgentAvatar";
import { Badge, Button, Input } from "./ui";

export type Tone = "orch" | "claude" | "gpt" | "gemini";
const TONE_TEXT: Record<Tone, string> = { orch: "text-orch", claude: "text-claude", gpt: "text-gpt", gemini: "text-gemini" };
const TONE_BG: Record<Tone, string> = { orch: "bg-orch", claude: "bg-claude", gpt: "bg-gpt", gemini: "bg-gemini" };

export function RoleDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", TONE_BG[tone], className)} />;
}

/** Name + color of a role in a chat: 마스터, 클로드 2호, 지피티 1호 … */
export function useRole(chatId: number, role: Role | null | undefined) {
  const agents = useStore((s) => s.agents[chatId]);
  return { name: roleName(role, agents), tone: roleTone(role, agents) as Tone };
}

export function RoleName({ chatId, role, size = 24, expression }: { chatId: number; role: Role; size?: AvatarSize; expression?: AgentExpression | string | null }) {
  const { name, tone } = useRole(chatId, role);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap", TONE_TEXT[tone])} data-testid="role-name">
      <AgentAvatar kind={tone} expression={expression} size={size} alt={`${name} 캐릭터`} />
      <RoleDot tone={tone} />
      {name}
    </span>
  );
}

export function AttachmentChip({ a, onRemove }: { a: AttachmentRef; onRemove?: () => void }) {
  const isImage = a.mime.startsWith("image/");
  return (
    <div
      className="group relative flex items-center gap-2 overflow-hidden rounded-lg border bg-card text-[12px]"
      title={`${a.name} · ${formatBytes(a.size)}`}
      data-testid="attachment"
    >
      {isImage ? (
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={() => void api.openPath(a.path).catch((e) => useStore.getState().toast(errorMessage(e)))} className="block shrink-0" aria-label={`${a.name} 열기`}>
            <img src={`cbx://attachment/${a.id}`} alt={a.name} className="size-16 object-cover" draggable={false} />
          </button>
          <div className="min-w-0 py-2 pr-3">
            <FileLink href={a.path}>{a.name}</FileLink>
            <div className="text-[11px] text-muted-foreground">{formatBytes(a.size)}</div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 py-2 pr-3 pl-2.5 text-left">
          <FileText className="size-4 text-muted-foreground" />
          <span className="max-w-40 truncate"><FileLink href={a.path}>{a.name}</FileLink></span>
          <span className="text-muted-foreground">{formatBytes(a.size)}</span>
        </div>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`${a.name} 첨부 삭제`}
          className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export function ItemList({ items, chatId, nested = false }: { items: Item[]; chatId: number; nested?: boolean }) {
  return (
    <div className={cn("flex flex-col", nested ? "gap-2.5" : "gap-4")}>
      {items.map((it) => (
        <ItemView key={it.key} item={it} chatId={chatId} nested={nested} />
      ))}
    </div>
  );
}

function ItemView({ item, chatId, nested }: { item: Item; chatId: number; nested: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
          {item.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {item.attachments.map((a) => (
                <AttachmentChip key={a.id} a={a} />
              ))}
            </div>
          )}
          {item.queued && <span className="text-[11px] text-muted-foreground">작업 중 추가 지시</span>}
          {item.text && (
            <div className="max-w-[78%] rounded-2xl rounded-br-md bg-user-bubble px-3.5 py-2 whitespace-pre-wrap text-white select-text">
              {item.text}
            </div>
          )}
        </div>
      );
    case "message":
      return (
        <div className="flex flex-col gap-1" data-testid="agent-message" data-role={item.role} data-expression={item.expression}>
          <RoleName chatId={chatId} role={item.role} size={36} expression={item.expression} />
          <div className={cn("group relative", nested ? "" : "pl-3.5")}>
            <Markdown text={item.text} />
            {item.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse-dot rounded-sm bg-primary align-text-bottom" />}
            {!item.streaming && (
              <CopyButton text={item.text} className="absolute -top-6 right-0 opacity-0 group-hover:opacity-100" label="메시지 복사" />
            )}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} nested={nested} />;
    case "files":
      return (
        <div className={cn("space-y-1.5", !nested && "pl-3.5")}>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <FileText className="size-3.5" />
            파일 변경 {item.files.length}개 {!item.ok && <Badge className="border-destructive/40 text-destructive">적용 안 됨</Badge>}
          </div>
          <DiffList files={item.files} />
        </div>
      );
    case "approval":
      return <ApprovalCard item={item} chatId={chatId} />;
    case "auto":
      return <AutoApproval item={item} chatId={chatId} />;
    case "consult":
      return <ConsultCard item={item} chatId={chatId} />;
    case "image":
      return <ImageCard item={item} chatId={chatId} />;
    case "ask":
      return <AskCard item={item} chatId={chatId} />;
    case "notice":
      return <Notice tone={item.tone}>{item.text}</Notice>;
  }
}

export function Notice({ tone, children }: { tone: "error" | "auth" | "info"; children: ReactNode }) {
  if (tone === "info")
    return (
      <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {children}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] select-text",
        tone === "auth" ? "border-warning/40 bg-warning/10" : "border-destructive/40 bg-destructive/10",
      )}
    >
      {tone === "auth" ? <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div className="min-w-0 break-words whitespace-pre-wrap">{children}</div>
    </div>
  );
}

function ImageCard({ item, chatId }: { item: Extract<Item, { kind: "image" }>; chatId: number }) {
  return (
    <div className="space-y-2 rounded-lg border bg-card px-3 py-2" data-testid="image-generation" data-role={item.role} data-status={item.status}>
      <div className="flex items-center gap-2 text-[12.5px]">
        <RoleName chatId={chatId} role={item.role} size={24} />
        <span className="font-medium">이미지 생성</span>
        <span className={cn("ml-auto flex items-center gap-1 text-[12px]", item.status === "done" ? "text-success" : item.status === "error" ? "text-destructive" : "text-primary")}>
          {item.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : item.status === "done" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          {item.status === "running" ? "생성 중" : item.status === "done" ? "완료" : "오류"}
        </span>
      </div>
      {item.prompt && <Markdown text={item.prompt} className="text-[12px] text-muted-foreground" />}
      {item.error && <div className="text-[12.5px] text-destructive select-text">{item.error}</div>}
      {item.attachment && <AttachmentChip a={item.attachment} />}
    </div>
  );
}

function ToolCard({ item, nested }: { item: Extract<Item, { kind: "tool" }>; nested: boolean }) {
  const [open, setOpen] = useState(false);
  const state = !item.result ? "running" : item.result.ok ? "ok" : "fail";
  const shell = item.name === "Bash" || item.name === "PowerShell" || item.name === "명령";
  const brief = item.input.split("\n").find((l) => l.trim() && l.trim() !== "{") ?? "";
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", !nested && "ml-3.5")} data-testid="tool-card">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/60" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {shell ? <Terminal className="size-3.5 shrink-0 text-muted-foreground" /> : <Wrench className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 text-[12.5px] font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{brief.trim()}</span>
        {item.diffs?.[0] && <Stats diff={item.diffs.map((d) => d.diff).join("\n")} />}
        {state === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {state === "ok" && <Check className="size-3.5 shrink-0 text-success" />}
        {state === "fail" && <X className="size-3.5 shrink-0 text-destructive" />}
      </button>
      {open && (
        <div className="space-y-2 border-t p-2.5">
          {item.diffs?.length ? (
            <DiffList files={item.diffs} defaultOpen />
          ) : (
            <pre className="max-h-64 overflow-auto rounded-md bg-code-bg p-2.5 font-mono text-[12px] whitespace-pre-wrap select-text">{item.input}</pre>
          )}
          {item.result && (
            <div className="relative">
              <pre
                className={cn(
                  "max-h-72 overflow-auto rounded-md bg-code-bg p-2.5 font-mono text-[12px] whitespace-pre-wrap select-text",
                  !item.result.ok && "text-destructive",
                )}
              >
                {item.result.output || "(출력 없음)"}
              </pre>
              {item.result.output && <CopyButton text={item.result.output} className="absolute top-1 right-1" />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, chatId }: { item: Extract<Item, { kind: "approval" }>; chatId: number }) {
  const { request: r, decision } = item;
  const [busy, setBusy] = useState(false);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const masterView = !selection?.node || selection.node === "orch";
  const toast = useStore((s) => s.toast);
  const answer = async (d: "once" | "chat" | "deny") => {
    setBusy(true);
    try {
      await api.answerApproval(chatId, r.id, d);
    } catch (e) {
      toast(errorMessage(e));
      setBusy(false);
    }
  };
  const status =
    decision === "once" ? "이번만 허용함" : decision === "chat" ? "이 채팅 동안 허용함" : decision === "deny" ? "거부함" : decision === "expired" ? "만료됨" : decision === "auto" ? "자동 허용" : null;
  const high = r.risk === "high";
  return (
    <div
      data-testid="approval"
      data-state={status ? "done" : "pending"}
      data-request-role={r.role}
      className={cn(
        "space-y-2.5 rounded-xl border p-3",
        status ? "bg-card/60 opacity-80" : high ? "border-destructive/50 bg-destructive/8" : "border-warning/50 bg-warning/8",
      )}
    >
      <div className="flex items-center gap-2">
        {high ? <ShieldAlert className="size-4 text-destructive" /> : <Hand className="size-4 text-warning" />}
        <span className="text-[13px] font-semibold">승인 요청</span>
        <RoleName chatId={chatId} role="orch" size={24} />
        <Badge className="font-mono">{r.title}</Badge>
        {high && <Badge className="border-destructive/40 text-destructive">위험 · {r.riskReason}</Badge>}
        {status && (
          <span className="ml-auto flex items-center gap-1 text-[12px] text-muted-foreground">
            {decision === "deny" || decision === "expired" ? <X className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
            {status}
          </span>
        )}
      </div>
      {r.role !== "orch" && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="approval-source">
          <span>마스터가 전달한 작업자 요청</span>
          <RoleName chatId={chatId} role={r.role} size={24} />
        </div>
      )}
      {r.judgeReason && (
        <div className="flex items-start gap-1.5 rounded-md bg-orch/10 px-2.5 py-1.5 text-[12.5px] select-text" data-testid="judge-reason">
          <RoleDot tone="orch" className="mt-1.5" />
          {r.judgeReason}
        </div>
      )}
      {r.reason && <div className="text-[12.5px] text-muted-foreground select-text">{r.reason}</div>}
      {r.diffs?.length ? (
        <DiffList files={r.diffs} defaultOpen={!status} />
      ) : (
        <pre className="max-h-56 overflow-auto rounded-md bg-code-bg p-2.5 font-mono text-[12px] whitespace-pre-wrap select-text">{r.detail}</pre>
      )}
      {!status && !masterView && (
        <Button size="sm" onClick={() => void select({ chatId, node: "orch" })} data-testid="approval-open-master">마스터 대화에서 확인</Button>
      )}
      {!status && masterView && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => answer("once")} disabled={busy} data-testid="approve-once">
            이번만 허용
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => answer("chat")}
            disabled={busy || high}
            title={high ? "위험한 작업은 매번 확인합니다" : "이 채팅에서 같은 종류의 요청을 자동으로 허용합니다"}
            data-testid="approve-chat"
          >
            이 채팅 동안 허용
          </Button>
          <Button size="sm" variant="outline" onClick={() => answer("deny")} disabled={busy} data-testid="approve-deny">
            거부
          </Button>
        </div>
      )}
    </div>
  );
}

/** An approval the orchestrator answered: one compact line, details on click. */
function AutoApproval({ item, chatId }: { item: Extract<Item, { kind: "auto" }>; chatId: number }) {
  const who = useRole(chatId, item.request.role).name;
  const [open, setOpen] = useState(false);
  const r = item.request;
  const allowed = item.decision === "allow";
  const brief = r.detail.split("\n").find((l) => l.trim() && l.trim() !== "{")?.trim() ?? "";
  return (
    <div className="text-[12px]" data-testid="auto-approval" data-decision={item.decision}>
      <button
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-accent/60"
        onClick={() => setOpen(!open)}
      >
        {allowed ? <ShieldCheck className="size-3.5 shrink-0 text-success" /> : <X className="size-3.5 shrink-0 text-destructive" />}
        <span className={cn("shrink-0 font-medium", allowed ? "text-success" : "text-destructive")}>
          {MASTER_LABEL} {allowed ? "승인" : "거부"}
        </span>
        <span className="shrink-0">· {who} · {r.title}</span>
        <span className="min-w-0 truncate font-mono">{brief}</span>
        <span className="min-w-0 shrink truncate">— {item.reason}</span>
      </button>
      {open && (
        <div className="mt-1 ml-6 space-y-1.5">
          {r.diffs?.length ? (
            <DiffList files={r.diffs} />
          ) : (
            <pre className="max-h-48 overflow-auto rounded-md bg-code-bg p-2 font-mono text-[12px] whitespace-pre-wrap select-text">{r.detail}</pre>
          )}
          {r.riskReason && <div className="text-muted-foreground">자동 분류: {r.riskReason}</div>}
        </div>
      )}
    </div>
  );
}

function ConsultTargetName({ chatId, role }: { chatId: number; role: Role }) {
  return <>{useRole(chatId, role).name}</>;
}

const STATUS_LABEL = { running: "진행 중", done: "완료", error: "오류", stopped: "중지됨", limited: "한도 도달" } as const;

function ConsultCard({ item, chatId }: { item: Extract<Item, { kind: "consult" }>; chatId: number }) {
  const [expanded, setExpanded] = useState(false);
  const select = useStore((s) => s.select);
  const requestBrief = item.request.split("\n").find((line) => line.trim())?.trim() ?? "(요청 내용 없음)";
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-testid="consult-card" data-status={item.status}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          data-testid="consult-request-toggle"
          aria-expanded={expanded}
          aria-label={`요청 ${expanded ? "접기" : "펼치기"}`}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
          <RoleName chatId={chatId} role={item.from} size={24} />
          <ArrowRight className="size-3.5 text-muted-foreground" />
          <RoleName chatId={chatId} role={item.to} size={24} />
          <Badge>{CONSULT_KIND_LABEL[item.consultKind]}</Badge>
          {item.scope && item.scope.length > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={item.scope.join(", ")}>
              {item.scope.join(", ").slice(0, 40)}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-muted-foreground">요청</span>
          <span data-testid="consult-request-brief" className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
            {requestBrief}
          </span>
          {item.attachments.length > 0 && <span className="shrink-0 text-[11px] text-muted-foreground">첨부 {item.attachments.length}개</span>}
        </button>
        {item.files && item.files.length > 0 && <Badge>파일 {item.files.length}개</Badge>}
        <span className={cn("flex items-center gap-1 text-[12px]", item.status === "done" ? "text-success" : item.status === "running" ? "text-primary" : "text-muted-foreground")}>
          {item.status === "running" ? <Loader2 className="size-3.5 animate-spin" /> : item.status === "done" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          {STATUS_LABEL[item.status]}
        </span>
        <Button variant="ghost" size="xs" onClick={() => select({ chatId, node: `consult:${item.consultId}` })}>
          열기
        </Button>
      </div>
      {item.reason && (
        <div className="border-t px-3 py-1.5 text-[11.5px] text-muted-foreground select-text" data-testid="consult-reason">
          배정 이유 · {item.reason}
        </div>
      )}
      {item.status !== "running" && item.summary?.trim() && (
        <div className="border-t px-3 py-2 text-[12px]" data-testid="consult-summary">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">결과 요약</div>
          <Markdown text={item.summary} className="text-[12.5px]" />
        </div>
      )}
      {expanded && (
        <div className="border-t bg-background/40 p-3" data-testid="consult-request-details">
          <div className="rounded-lg border bg-card px-3 py-2">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">요청</div>
            <div data-testid="consult-request-body">
              <Markdown text={item.request} className="text-[13px]" />
            </div>
            {item.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="consult-request-attachments">
                {item.attachments.map((a) => (
                  <AttachmentChip key={a.id} a={a} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {item.children.length > 0 ? (
        <div className="border-t p-3" data-testid="consult-progress">
          <ItemList items={item.children} chatId={chatId} nested />
        </div>
      ) : (
        item.status === "running" && (
          <div className="flex items-center gap-2 border-t p-3 text-[12px] text-muted-foreground" data-testid="consult-progress">
            <Loader2 className="size-3.5 animate-spin" /> <ConsultTargetName chatId={chatId} role={item.to} /> 작업 시작 중…
          </div>
        )
      )}
      {item.files && item.files.length > 0 && (
        <div className="border-t px-3 py-2 text-[12px] text-muted-foreground">
          변경한 파일: <span className="font-mono">{item.files.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function AskCard({ item, chatId }: { item: Extract<Item, { kind: "ask" }>; chatId: number }) {
  const [text, setText] = useState("");
  const toast = useStore((s) => s.toast);
  const answer = (a: string) => api.answerAskUser(chatId, item.id, a).catch((e) => toast(errorMessage(e)));
  return (
    <div className="space-y-2.5 rounded-xl border border-primary/40 bg-primary/6 p-3" data-testid="ask-card">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <MessageCircleQuestion className="size-4 text-primary" />
        마스터의 질문
      </div>
      <Markdown text={item.question} />
      {item.answer !== undefined ? (
        <div className="text-[12.5px] text-muted-foreground">
          답변: <span className="text-foreground">{item.answer}</span>
        </div>
      ) : (
        <>
          {item.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {item.options.map((o) => (
                <Button key={o} size="sm" variant="secondary" onClick={() => answer(o)}>
                  {o}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void answer(text.trim());
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="직접 답하기" className="h-8" />
            <Button size="sm" type="submit" disabled={!text.trim()}>
              답하기
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Check, ChevronDown, CircleAlert, History, ImagePlus, Loader2, Paperclip, Pause, Play, RotateCcw, SendHorizontal, ShieldCheck, Workflow, X } from "lucide-react";
import {
  APPROVAL_MODE_LABEL,
  AGENT_LABEL,
  GEMINI_WEB_MODEL,
  parseOrchestrator,
  roleName,
  MASTER_LABEL,
  CONSULT_KIND_LABEL,
  type AgentExpression,
  type AgentKind,
  type ApprovalMode,
  type AttachmentRef,
  type Chat,
  type ChatAgent,
  type Consult,
  type NodeId,
  type Project,
  type Role,
  type TimelineEvent,
} from "../../../shared/types";
import { api, cn, errorMessage } from "../lib/utils";
import { useStore } from "../store";
import { buildItems, createTimelineBuilder, latestExpression, planOf } from "../timeline";
import { GoalBar, PlanPanel } from "./PlanGoal";
import { SLASH_COMMANDS, StatusDialog, type SlashCommand } from "./Commands";
import { AttachmentChip, ItemList } from "./Items";
import { AgentAvatar } from "./AgentAvatar";
import { AgentUsage } from "./AgentUsage";
import { defaultEffortForModel, EffortPicker, effortLabel } from "./EffortPicker";
import { ModelPicker, useModelLabel } from "./ModelPicker";
import { formatElapsed, latestInstructionAt } from "../lib/time";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Tooltip,
} from "./ui";
import { StatusIcon } from "./Sidebar";

export function ChatView({ chat, project, node }: { chat: Chat; project: Project; node?: NodeId }) {
  const events = useStore((s) => s.events[chat.id]);
  const consults = useStore((s) => s.consults[chat.id]);
  const busy = chat.status === "working" || chat.status === "approval";
  const buildTimeline = useMemo(() => createTimelineBuilder(), [chat.id]);
  const items = useMemo(() => buildTimeline(events ?? [], node, busy), [buildTimeline, events, node, busy]);
  const instructionAt = useMemo(() => latestInstructionAt(events ?? [], chat.createdAt), [events, chat.createdAt]);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const plan = useMemo(() => planOf(events ?? []), [events]);

  const agents = useStore((s) => s.agents[chat.id]);
  const nodeLabel = useMemo(() => {
    if (!node) return null;
    if (node.startsWith("consult:")) {
      const c = consults?.find((x) => x.id === Number(node.slice(8)));
      return c ? `협의 ${c.seq} · ${roleName(c.fromRole, agents)} → ${roleName(c.toRole, agents)} · ${CONSULT_KIND_LABEL[c.kind]}` : "협의";
    }
    return node === "orch" ? `${MASTER_LABEL} 대화` : roleName(node as "orch", agents);
  }, [node, consults, agents]);

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
      <ChatHeader chat={chat} project={project} nodeLabel={nodeLabel} masterExpression={latestExpression(events ?? [], "orch")} />
      <TeamChips chat={chat} />
      {!node && <GoalBar chat={chat} />}
      {!node && plan && <PlanPanel chat={chat} plan={plan} onRevise={() => composer.current?.setText("/plan 수정: ")} />}
      <Timeline items={items} chatId={chat.id} busy={busy} instructionAt={instructionAt} empty={!events?.length} loading={!events} masterView={!node || node === "orch"} />
      {chat.status === "interrupted" && <InterruptedBanner chat={chat} />}
      {node && node !== "orch" ? (
        <div className="border-t px-6 py-2.5 text-center text-[12px] text-muted-foreground">
          {nodeLabel} 기록입니다. 지시는{" "}
          <button className="text-primary hover:underline" onClick={() => void useStore.getState().select({ chatId: chat.id })}>
            채팅 화면
          </button>
          에서 보내세요.
        </div>
      ) : (
        <Composer ref={composer} chat={chat} project={project} busy={busy} />
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

function ProviderControls({ agent, web = false, apiProvider = agent === "deepseek", master = false, children }: { agent: AgentKind; web?: boolean; apiProvider?: boolean; master?: boolean; children: ReactNode }) {
  const cli = useStore(s => s.cli.find(c => c.agent === agent));
  const refresh = useStore(s => s.refreshCli);
  const [checking, setChecking] = useState(false);
  const inactive = !web && !apiProvider && cli?.authStatus !== "authenticated";
  const status = !cli?.path ? "CLI 미설치" : cli.authStatus === "required" ? "로그인 필요" : "로그인 확인 필요";
  return <div className="flex shrink-0 flex-nowrap items-center gap-1.5" data-testid={master ? "orch-badge" : "provider-controls"} data-provider={agent} data-state={web ? "web" : apiProvider ? "api" : inactive ? "inactive" : "ready"}>
    <div className={cn("flex min-w-0 items-center gap-1.5", inactive && "opacity-45 grayscale")}>{children}</div>
    {inactive && <button type="button" disabled={checking} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" aria-label={`${master ? "마스터 " : ""}${AGENT_LABEL[agent]} 로그인 상태 다시 확인`} title="로그인이 확인되지 않았습니다. 로그인 후 눌러서 다시 확인하세요. 모델 설정은 변경할 수 있습니다." onClick={async () => {
      setChecking(true);
      try { await refresh(); } catch (error) { useStore.getState().toast(errorMessage(error)); }
      finally { setChecking(false); }
    }}>{checking ? "확인 중…" : status}</button>}
  </div>;
}

function ChatHeader({ chat, project, nodeLabel, masterExpression }: { chat: Chat; project: Project; nodeLabel: string | null; masterExpression: AgentExpression }) {
  const updateChat = useStore((s) => s.updateChat);
  const models = useStore((s) => s.models);
  const label = useModelLabel();
  const orch = parseOrchestrator(chat.orchestratorModelOverride ?? project.settings.orchestratorModel);
  const projectOrch = parseOrchestrator(project.settings.orchestratorModel);
  const orchEffort = chat.orchestratorEffortOverride ?? project.settings.orchestratorEffort ?? "xhigh";
  const claudeModel = chat.claudeModelOverride ?? project.settings.claudeModel;
  const codexModel = chat.codexModelOverride ?? project.settings.codexModel;
  const grokModel = chat.grokModelOverride ?? project.settings.grokModel;
  const grokEffort = chat.grokEffortOverride ?? project.settings.grokEffort;
  const deepseekModel = chat.deepseekModelOverride ?? project.settings.deepseekModel;
  const deepseekEffort = chat.deepseekEffortOverride ?? project.settings.deepseekEffort;
  const geminiModel = chat.geminiModelOverride ?? project.settings.geminiModel;
  const claudeEffort = chat.claudeEffortOverride ?? project.settings.claudeEffort ?? "auto";
  const codexEffort = chat.codexEffortOverride ?? project.settings.codexEffort ?? "auto";
  const geminiEffort = chat.geminiEffortOverride ?? project.settings.geminiEffort ?? "auto";
  return (
    <header className="flex w-full min-w-0 max-w-full flex-col gap-1.5 overflow-hidden border-b px-4 py-2">
      <div className="flex w-full min-w-0 max-w-full items-start gap-2" data-testid="chat-header-title-row">
        <StatusIcon status={chat.status} unread={false} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[14px] font-semibold">
            <span className="min-w-0 break-words" data-testid="chat-title">
              {chat.title}
            </span>
            {nodeLabel && <span className="shrink-0 font-normal text-muted-foreground">· {nodeLabel}</span>}
          </div>
        </div>
        <div className="max-w-[35%] truncate text-[11.5px] text-muted-foreground" title={`${project.name} · ${project.folder}`}>
          {project.name} · {project.folder}
        </div>
      </div>
      <div className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-x-auto whitespace-nowrap" data-testid="chat-header-master-row">
        <ProviderControls agent={orch.agent} master>
          <AgentAvatar kind="orch" expression={masterExpression} size={24} alt="마스터 캐릭터" />
          <span className="text-[12px] text-muted-foreground">마스터</span>
          <ModelPicker
            compact
            agents={["claude", "codex", "gemini", "grok", "deepseek"]}
            ariaLabel="이 채팅의 마스터 모델"
            value={chat.orchestratorModelOverride ?? project.settings.orchestratorModel}
            inherited={chat.orchestratorModelOverride === null}
            onChange={(v) => {
              const next = parseOrchestrator(v);
              void updateChat(chat.id, {
                orchestratorModelOverride: v as Project["settings"]["orchestratorModel"],
                orchestratorEffortOverride: defaultEffortForModel(models, next.agent, next.model, false),
              });
            }}
            onReset={() => void updateChat(chat.id, { orchestratorModelOverride: null })}
            resetLabel={`프로젝트 값 사용 (${AGENT_LABEL[projectOrch.agent]} · ${label(projectOrch.agent, projectOrch.model)})`}
          />
          <EffortPicker
            compact
            agent={orch.agent}
            model={orch.model}
            value={orchEffort}
            inherited={chat.orchestratorEffortOverride === null}
            onChange={(v) => void updateChat(chat.id, { orchestratorEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { orchestratorEffortOverride: null })}
            resetLabel={`프로젝트 값 사용 (${effortLabel(project.settings.orchestratorEffort ?? "xhigh")})`}
            ariaLabel="이 채팅의 마스터 추론 수준"
          />
        </ProviderControls>
        <ApprovalModePicker chat={chat} project={project} />
      </div>
      <div className="flex w-full min-w-0 max-w-full items-center gap-3 overflow-x-auto whitespace-nowrap" data-testid="chat-header-agents-row">
        <ProviderControls agent="claude">
          <AgentAvatar kind="claude" size={24} alt="클로드 캐릭터" />
          <span className="text-[12px] text-muted-foreground">클로드</span>
          <ModelPicker
            compact
            agents={["claude"]}
            ariaLabel="이 채팅의 클로드 모델"
            value={claudeModel}
            inherited={chat.claudeModelOverride === null}
            onChange={(v) => void updateChat(chat.id, { claudeModelOverride: v, claudeEffortOverride: defaultEffortForModel(models, "claude", v, true) })}
            onReset={() => void updateChat(chat.id, { claudeModelOverride: null })}
            resetLabel={`프로젝트 값 사용 (${label("claude", project.settings.claudeModel)})`}
          />
          <EffortPicker
            compact
            agent="claude"
            model={claudeModel}
            worker
            value={claudeEffort}
            inherited={chat.claudeEffortOverride === null}
            onChange={(v) => void updateChat(chat.id, { claudeEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { claudeEffortOverride: null })}
            resetLabel={`프로젝트 값 사용 (${effortLabel(project.settings.claudeEffort ?? "auto")})`}
            ariaLabel="이 채팅의 클로드 추론 수준"
          />
        </ProviderControls>
        <ProviderControls agent="codex">
          <AgentAvatar kind="gpt" size={24} alt="지피티 캐릭터" />
          <span className="text-[12px] text-muted-foreground">지피티</span>
          <ModelPicker
            compact
            agents={["codex"]}
            ariaLabel="이 채팅의 지피티 모델"
            value={codexModel}
            inherited={chat.codexModelOverride === null}
            onChange={(v) => void updateChat(chat.id, { codexModelOverride: v, codexEffortOverride: defaultEffortForModel(models, "codex", v, true) })}
            onReset={() => void updateChat(chat.id, { codexModelOverride: null })}
            resetLabel={`프로젝트 값 사용 (${label("codex", project.settings.codexModel)})`}
          />
          <EffortPicker
            compact
            agent="codex"
            model={codexModel}
            worker
            value={codexEffort}
            inherited={chat.codexEffortOverride === null}
            onChange={(v) => void updateChat(chat.id, { codexEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { codexEffortOverride: null })}
            resetLabel={`프로젝트 값 사용 (${effortLabel(project.settings.codexEffort ?? "auto")})`}
            ariaLabel="이 채팅의 지피티 추론 수준"
          />
        </ProviderControls>
        <ProviderControls agent="gemini" web={geminiModel === GEMINI_WEB_MODEL}>
          <AgentAvatar kind="gemini" size={24} alt="제미나이 캐릭터" />
          <span className="text-[12px] text-muted-foreground">제미나이</span>
          <ModelPicker
            compact
            agents={["gemini"]}
            ariaLabel="이 채팅의 제미나이 모델"
            value={geminiModel}
            inherited={chat.geminiModelOverride === null}
            onChange={(v) => void updateChat(chat.id, { geminiModelOverride: v, geminiEffortOverride: defaultEffortForModel(models, "gemini", v, true) })}
            onReset={() => void updateChat(chat.id, { geminiModelOverride: null })}
            resetLabel={`프로젝트 값 사용 (${label("gemini", project.settings.geminiModel)})`}
          />
          <EffortPicker
            compact
            agent="gemini"
            model={geminiModel}
            worker
            value={geminiEffort}
            inherited={chat.geminiEffortOverride === null}
            onChange={(v) => void updateChat(chat.id, { geminiEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { geminiEffortOverride: null })}
            resetLabel={`프로젝트 값 사용 (${effortLabel(project.settings.geminiEffort ?? "auto")})`}
            ariaLabel="이 채팅의 제미나이 추론 수준"
          />
        </ProviderControls>
        <ProviderControls agent="grok">
          <AgentAvatar kind="grok" size={24} alt="그록 캐릭터" />
          <span className="text-[12px] text-muted-foreground">그록</span>
          <ModelPicker compact agents={["grok"]} ariaLabel="이 채팅의 그록 모델" value={grokModel}
            inherited={chat.grokModelOverride === null}
            onChange={v => void updateChat(chat.id, { grokModelOverride: v, grokEffortOverride: defaultEffortForModel(models, "grok", v, true) })}
            onReset={() => void updateChat(chat.id, { grokModelOverride: null })} />
          <EffortPicker compact agent="grok" model={grokModel} worker value={grokEffort} ariaLabel="이 채팅의 그록 추론 수준"
            inherited={chat.grokEffortOverride === null} onChange={v => void updateChat(chat.id, { grokEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { grokEffortOverride: null })} />
        </ProviderControls>
        <ProviderControls agent="deepseek" apiProvider>
          <AgentAvatar kind="deepseek" size={24} alt="딥시크 캐릭터" />
          <span className="text-[12px] text-muted-foreground">딥시크</span>
          <ModelPicker compact agents={["deepseek"]} ariaLabel="이 채팅의 딥시크 모델" value={deepseekModel}
            inherited={chat.deepseekModelOverride === null}
            onChange={v => void updateChat(chat.id, { deepseekModelOverride: v, deepseekEffortOverride: defaultEffortForModel(models, "deepseek", v, true) })}
            onReset={() => void updateChat(chat.id, { deepseekModelOverride: null })}
            resetLabel={`프로젝트 값 사용 (${label("deepseek", project.settings.deepseekModel)})`} />
          <EffortPicker compact agent="deepseek" model={deepseekModel} worker value={deepseekEffort} ariaLabel="이 채팅의 딥시크 추론 수준"
            inherited={chat.deepseekEffortOverride === null} onChange={v => void updateChat(chat.id, { deepseekEffortOverride: v })}
            onReset={() => void updateChat(chat.id, { deepseekEffortOverride: null })} />
        </ProviderControls>
      </div>
    </header>
  );
}

/** The chat's workers with their state; more workers use quota faster. */
function TeamChips({ chat }: { chat: Chat }) {
  const agents = useStore((s) => s.agents[chat.id]);
  const consults = useStore((s) => s.consults[chat.id]);
  const events = useStore((s) => s.events[chat.id]);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const ordered = useMemo(
    () =>
      [...(agents ?? [])].sort((a, b) => {
        const status = (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1);
        return status || a.createdAt - b.createdAt || a.id - b.id;
      }),
    [agents],
  );
  const active = ordered.filter((a) => a.status === "active");
  const released = ordered.filter((a) => a.status === "released");
  return (
    <div className="border-b px-4 py-2" data-testid={ordered.length > 0 ? "team-chips" : undefined}>
      {ordered.length > 0 && (
        <Tooltip content="작업자가 많을수록 사용량이 빨리 줄어요">
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap">
            {active.map((a) => (
              <WorkerChip
                key={a.id}
                agent={a}
                selected={selection?.chatId === chat.id && selection.node === a.key}
                status={workerStatus(a.key, events, consults)}
                expression={latestExpression(events ?? [], a.key)}
                onSelect={() => void select({ chatId: chat.id, node: a.key })}
              />
            ))}
            {released.length > 0 && (
              <div className="ml-1 flex items-center gap-1.5 border-l pl-2 text-[11px] text-muted-foreground" data-testid="released-workers">
                <span>해제됨</span>
                {released.map((a) => (
                  <WorkerChip
                    key={a.id}
                    agent={a}
                    selected={selection?.chatId === chat.id && selection.node === a.key}
                    status={workerStatus(a.key, events, consults)}
                    expression={latestExpression(events ?? [], a.key)}
                    onSelect={() => void select({ chatId: chat.id, node: a.key })}
                  />
                ))}
              </div>
            )}
          </div>
        </Tooltip>
      )}
      <div className={cn("flex items-center gap-x-3 overflow-x-auto whitespace-nowrap", ordered.length > 0 && "mt-2 border-t pt-1.5")} data-testid="agent-usage-list">
        <AgentUsage events={events ?? []} role="orch" label={MASTER_LABEL} />
        {ordered.map((agent) => (
          <span key={agent.id} className={cn("shrink-0", agent.status === "released" && "opacity-50 grayscale")}>
            <AgentUsage events={events ?? []} role={agent.key} label={agent.nickname} />
          </span>
        ))}
      </div>
    </div>
  );
}

type WorkerStatus = "working" | "approval" | "error" | "idle";

const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = { working: "작업 중", approval: "승인 대기", error: "오류", idle: "대기" };

function workerStatus(role: Role, events: TimelineEvent[] | undefined, consults: Consult[] | undefined): WorkerStatus {
  const pending = new Set<string>();
  let state: WorkerStatus = "idle";
  for (const e of events ?? []) {
    if (e.event.type === "approval_request" && e.event.request.role === role) pending.add(e.event.request.id);
    else if (e.event.type === "approval_resolved") pending.delete(e.event.id);
    if (e.role !== role) continue;
    switch (e.event.type) {
      case "error":
        state = "error";
        break;
      case "turn_end":
        state = e.event.interrupted || e.event.ok ? "idle" : "error";
        break;
      case "text_delta":
      case "tool_call":
      case "tool_result":
      case "file_change":
      case "consult_start":
        state = "working";
        break;
      case "approval_resolved":
        state = "working";
        break;
    }
  }
  if (pending.size) return "approval";
  if (consults?.some((c) => c.toRole === role && c.status === "running")) return "working";
  const latestConsult = consults
    ?.filter((c) => c.toRole === role)
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    .at(-1);
  if (latestConsult?.status === "error") return "error";
  return state;
}

function WorkerChip({
  agent,
  selected,
  status,
  expression,
  onSelect,
}: {
  agent: ChatAgent;
  selected: boolean;
  status: WorkerStatus;
  expression: AgentExpression;
  onSelect: () => void;
}) {
  const released = agent.status === "released";
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors",
        selected ? "border-primary bg-primary/10 text-foreground" : status === "working" ? "border-primary/40 bg-primary/8" : "text-muted-foreground",
        released && "text-muted-foreground opacity-60 grayscale",
      )}
      data-testid="team-chip"
      data-state={status}
      data-role={agent.key}
      data-selected={selected}
      aria-pressed={selected}
      aria-label={`${agent.nickname} ${WORKER_STATUS_LABEL[status]} 기록 열기`}
      onClick={onSelect}
    >
      <AgentAvatar kind={agent.kind} expression={expression} size={32} alt={`${agent.nickname} 캐릭터`} className={released ? "grayscale" : undefined} />
      <span>{agent.nickname}</span>
      <Badge className={cn("h-5 px-1.5 text-[10px] font-normal", status === "working" && "border-primary/30 text-primary", status === "approval" && "border-warning/40 text-warning", status === "error" && "border-destructive/40 text-destructive")}>
        {status === "working" && <Loader2 className="size-3 animate-spin" />}
        {status === "approval" && <ShieldCheck className="size-3" />}
        {status === "error" && <CircleAlert className="size-3" />}
        {WORKER_STATUS_LABEL[status]}
      </Badge>
    </button>
  );
}

function ApprovalModePicker({ chat, project }: { chat: Chat; project: Project }) {
  const updateChat = useStore((s) => s.updateChat);
  const mode: ApprovalMode = chat.approvalModeOverride ?? project.settings.approvalMode;
  const inherited = chat.approvalModeOverride === null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" aria-label="이 채팅의 승인 방식" className="font-normal">
          <ShieldCheck className="text-muted-foreground" />
          {mode === "orchestrator" ? "자동 승인" : "직접 승인"}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {!inherited && (
          <>
            <DropdownMenuItem onSelect={() => void updateChat(chat.id, { approvalModeOverride: null })}>
              <RotateCcw />
              프로젝트 값 사용 ({APPROVAL_MODE_LABEL[project.settings.approvalMode]})
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {(["orchestrator", "user"] as const).map((m) => (
          <DropdownMenuCheckItem key={m} checked={mode === m} onSelect={() => void updateChat(chat.id, { approvalModeOverride: m })}>
            {APPROVAL_MODE_LABEL[m]}
          </DropdownMenuCheckItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The app was quit or crashed mid-run: offer to continue. */
function InterruptedBanner({ chat }: { chat: Chat }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto mb-2 flex w-[min(860px,calc(100%-32px))] items-center gap-3 rounded-xl border border-warning/50 bg-warning/10 px-3.5 py-2.5" data-testid="interrupted">
      <History className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-medium">중단됨</div>
        <div className="text-[12px] text-muted-foreground">이전 실행이 앱 종료로 중단됐습니다. 이어서 진행하면 마스터가 작업 폴더 상태를 확인하고 남은 작업을 마칩니다.</div>
      </div>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.resume(chat.id);
          } catch (e) {
            toast(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
        data-testid="resume"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />} 이어서 진행
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="중단 표시 닫기" onClick={() => void api.dismissInterrupted(chat.id)}>
        <X />
      </Button>
    </div>
  );
}

function Timeline({ items, chatId, busy, instructionAt, empty, loading, masterView }: { items: ReturnType<typeof buildItems>; chatId: number; busy: boolean; instructionAt: number; empty: boolean; loading: boolean; masterView: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const [now, setNow] = useState(() => Date.now());
  const { history, pending } = useMemo(() => masterView ? {
    history: items.filter(item => item.kind !== "approval" || !!item.decision),
    pending: items.filter(item => item.kind === "approval" && !item.decision),
  } : { history: items, pending: [] }, [items, masterView]);

  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, instructionAt]);

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
            <ItemList items={history} chatId={chatId} />
          )}
          {busy && (
            <div className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground" data-testid="working">
              <Loader2 className="size-3.5 animate-spin" /> 작업 중… · {formatElapsed(now - instructionAt)}
            </div>
          )}
          {pending.length > 0 && (
            <div className="mt-4" data-testid="pending-approvals" aria-label="승인 대기 요청">
              <ItemList items={pending} chatId={chatId} />
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
      <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-claude via-gemini to-gpt text-white shadow">
        <Workflow className="size-6" />
      </div>
      <div className="text-[15px] font-semibold">무엇을 할까요?</div>
      <div className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
        지시를 보내면 마스터가 계획을 세우고, 일의 양에 맞춰 클로드·지피티·제미나이·그록·딥시크 작업자를 꾸려 구현과 리뷰를 나눠 맡깁니다. 이미지는 붙여넣기(Ctrl+V)나 끌어다 놓기로 첨부할 수 있어요.
      </div>
    </div>
  );
}

// ---------- Composer
export interface ComposerHandle {
  addFiles(files: File[]): void;
  setText(text: string): void;
}

/** Unsent text and attachments survive switching chats. */
const drafts = new Map<number, { text: string; attachments: AttachmentRef[] }>();


const Composer = forwardRef<ComposerHandle, { chat: Chat; project: Project; busy: boolean }>(function Composer({ chat, project, busy }, ref) {
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState(() => drafts.get(chat.id)?.text ?? "");
  const [attachments, setAttachments] = useState<AttachmentRef[]>(() => drafts.get(chat.id)?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [pausePending, setPausePending] = useState<"pause" | "resume" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const paused = chat.status === "paused";
  const pausing = chat.status === "pausing";
  const pauseInFlight = pausing || !!pausePending;

  useEffect(() => {
    setPausePending(null);
  }, [chat.id]);
  useEffect(() => {
    if (!busy && !pausing) setPausePending(null);
  }, [busy, pausing]);
  useEffect(() => {
    if (busy && pausePending === "resume") setPausePending(null);
  }, [busy, pausePending]);

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

  useImperativeHandle(
    ref,
    () => ({
      addFiles: (f) => void addFiles(f),
      setText: (t) => {
        setText(t);
        setTimeout(() => {
          area.current?.focus();
          area.current?.setSelectionRange(t.length, t.length);
        }, 0);
      },
    }),
    [addFiles],
  );

  // ---- slash commands
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const menu = slashQuery !== undefined && !menuClosed ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery.toLowerCase())) : [];
  useEffect(() => {
    setMenuIndex(0);
    if (!text.startsWith("/")) setMenuClosed(false);
  }, [slashQuery, text]);

  const runCommand = async (name: string, arg: string) => {
    const known = SLASH_COMMANDS.find((c) => c.name === name);
    if (!known) {
      toast(`알 수 없는 명령: /${name}`);
      return;
    }
    if (known.needsArg && !arg.trim()) {
      toast(`/${name} 뒤에 ${known.args}을(를) 적어 주세요.`);
      return;
    }
    setText("");
    setMenuClosed(false);
    if (name === "status" || name === "model") return setStatusOpen(true);
    if (name === "new") {
      await useStore.getState().createChat(chat.projectId);
      return;
    }
    try {
      await api.command(chat.id, name, arg.trim());
    } catch (e) {
      toast(errorMessage(e));
      setText(`/${name}${arg ? " " + arg : ""}`);
    }
  };

  const pickCommand = (c: SlashCommand) => {
    if (c.args) setText(`/${c.name} `);
    else void runCommand(c.name, "");
  };

  const send = async (delivery: "now" | "next" = "now") => {
    if (pauseInFlight) return;
    const t = text.trim();
    // "/name arg" → command (attachments are not used by commands).
    const cmd = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(t);
    if (cmd) return void runCommand(cmd[1].toLowerCase(), cmd[2] ?? "");
    if ((!t && !attachments.length) || sending || uploading) return;
    setSending(true);
    try {
      await api.send(
        chat.id,
        t,
        attachments.map((a) => a.id),
        delivery,
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

  const canSend = (!!text.trim() || attachments.length > 0) && !sending && !uploading && !pauseInFlight;

  const requestPause = async () => {
    if (pauseInFlight || !busy) return;
    setPausePending("pause");
    try {
      await api.pause(chat.id);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setPausePending(null);
    }
  };

  const requestResume = async () => {
    if (pauseInFlight || !paused) return;
    setPausePending("resume");
    try {
      await api.resume(chat.id);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setPausePending(null);
    }
  };

  return (
    <div className="px-4 pt-1 pb-4">
      <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} chat={chat} project={project} />
      <div className="relative mx-auto max-w-[860px] rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/60">
        {menu.length > 0 && (
          <div role="listbox" aria-label="명령" className="absolute bottom-full left-0 z-30 mb-2 w-96 overflow-hidden rounded-xl border bg-card p-1 shadow-xl" data-testid="slash-menu">
            {menu.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === menuIndex}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickCommand(c);
                }}
                className={cn("flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left", i === menuIndex && "bg-accent")}
              >
                <span className="font-mono text-[13px] font-semibold">/{c.name}</span>
                {c.args && <span className="font-mono text-[11.5px] text-muted-foreground">{c.args}</span>}
                <span className="ml-auto truncate text-[12px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
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
          placeholder={paused ? "추가 지시는 재시작할 때 전달" : busy ? "추가 지시를 입력하세요. Enter 즉시 전달 · Alt+Enter 다음 단계 전달" : "지시를 입력하세요. Enter 즉시 전달 (/ 로 명령)"}
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
            if (menu.length && !e.nativeEvent.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(menu[Math.min(menuIndex, menu.length - 1)]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMenuClosed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(busy && e.altKey && !e.ctrlKey && !e.metaKey ? "next" : "now");
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
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
          <span className="ml-1 hidden text-[11.5px] text-muted-foreground xl:inline">
            <Kbd>Enter</Kbd> {paused ? "지시 보관" : "즉시 전달"} · {busy && <><Kbd>Alt+Enter</Kbd> 다음 단계 · </>}
            <Kbd>Shift+Enter</Kbd> 줄바꿈 · <Kbd>Ctrl+V</Kbd> 이미지 붙여넣기
          </span>
          <div className="flex-1" />
          {pauseInFlight ? (
            <Button size="icon-sm" variant="ghost" disabled aria-label={pausePending === "resume" ? "재시작하는 중" : "일시 중지하는 중"} data-testid="pause">
              <Loader2 className="animate-spin" />
            </Button>
          ) : paused ? (
            <Tooltip content="재시작">
              <Button size="icon-sm" variant="ghost" onClick={() => void requestResume()} aria-label="재시작" data-testid="resume">
                <Play />
              </Button>
            </Tooltip>
          ) : busy ? (
            <Tooltip content="일시 중지">
              <Button size="icon-sm" variant="ghost" onClick={() => void requestPause()} aria-label="일시 중지" data-testid="pause">
                <Pause />
              </Button>
            </Tooltip>
          ) : null}
          {busy && <Button size="sm" variant="outline" onClick={() => void send("next")} disabled={!canSend} aria-label="다음 단계로 전달" title="Alt+Enter" data-testid="send-next" className="rounded-full px-3.5">다음 단계 전달</Button>}
          <Button size="sm" onClick={() => void send()} disabled={!canSend} aria-label={paused ? "지시 보관" : busy ? "마스터에게 즉시 전달" : "보내기"} title="Enter" data-testid="send" className={cn("rounded-full px-3.5")}>
            {sending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
            {paused ? "지시 보관" : busy ? "즉시 전달" : "보내기"}
          </Button>
        </div>
      </div>
    </div>
  );
});

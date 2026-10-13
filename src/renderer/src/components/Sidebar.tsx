import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  FolderClosed,
  History,
  Hand,
  Loader2,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { CONSULT_KIND_LABEL, ROLE_LABEL, type Chat, type ChatStatus, type NodeId, type Project, type Role } from "../../../shared/types";
import { api, cn, timeAgo } from "../lib/utils";
import { useStore } from "../store";
import { ProjectDialog } from "./ProjectDialog";
import { RoleDot } from "./Items";
import { UsageBar } from "./Usage";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tooltip,
} from "./ui";

export function StatusIcon({ status, unread }: { status: ChatStatus; unread?: boolean }) {
  switch (status) {
    case "working":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-label="작업 중" />;
    case "approval":
      return <Hand className="size-3.5 shrink-0 animate-pulse-dot text-warning" aria-label="승인 필요" />;
    case "error":
      return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="오류" />;
    case "interrupted":
      return <History className="size-3.5 shrink-0 text-warning" aria-label="중단됨" />;
    case "done":
      return unread ? (
        <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="새 결과" />
      ) : (
        <Check className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="완료" />
      );
    default:
      return <MessageSquare className="size-3.5 shrink-0 text-muted-foreground/70" />;
  }
}

type MenuAction = { label: string; icon: React.ElementType; onSelect: () => void; destructive?: boolean; separatorBefore?: boolean };

function ItemMenus({ actions, children }: { actions: MenuAction[]; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((a) => (
          <div key={a.label}>
            {a.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem onSelect={a.onSelect} destructive={a.destructive}>
              <a.icon />
              {a.label}
            </ContextMenuItem>
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MoreMenu({ actions, label }: { actions: MenuAction[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={label}
          className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus:opacity-100 data-[state=open]:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {actions.map((a) => (
          <div key={a.label}>
            {a.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={a.onSelect} destructive={a.destructive}>
              <a.icon />
              {a.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar({ onNewProject }: { onNewProject: () => void }) {
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [showArchived, setShowArchived] = useState(false);
  const [editProject, setEditProject] = useState<Project | undefined>();
  const [rename, setRename] = useState<{ kind: "chat" | "project"; id: number; title: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void> } | null>(null);

  const q = search.trim().toLowerCase();
  // Message-content matches come from the main process (debounced).
  const [contentHits, setContentHits] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!q) return setContentHits(new Set());
    const t = setTimeout(() => void api.searchChats(q).then((ids) => setContentHits(new Set(ids))), 200);
    return () => clearTimeout(t);
  }, [q]);
  const visibleProjects = projects.filter((p) => showArchived || !p.archived);
  const working = chats.filter((c) => c.status === "working" || c.status === "approval");

  return (
    <aside className="flex h-full min-h-0 flex-col border-r bg-sidebar" data-testid="sidebar">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-claude to-gpt text-white shadow-sm">
          <Workflow className="size-4" />
        </div>
        <div className="flex-1 text-[14px] font-semibold tracking-tight">AI_ChatterBox</div>
        <Tooltip content={theme === "dark" ? "라이트 테마" : "다크 테마"}>
          <Button variant="ghost" size="icon-sm" aria-label="테마 전환" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <Tooltip content="새 프로젝트">
          <Button variant="ghost" size="icon-sm" aria-label="새 프로젝트" onClick={onNewProject}>
            <Plus />
          </Button>
        </Tooltip>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="채팅·메시지 검색"
            aria-label="채팅 검색"
            className="h-8 bg-background pl-8 text-[13px]"
          />
          {search && (
            <button className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground" onClick={() => setSearch("")} aria-label="검색 지우기">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="프로젝트와 채팅">
        {visibleProjects.length === 0 && (
          <div className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
            프로젝트가 없습니다.
            <Button variant="link" size="sm" onClick={onNewProject} className="mx-auto mt-1 block">
              새 프로젝트 만들기
            </Button>
          </div>
        )}
        {visibleProjects.map((p) => (
          <ProjectNode
            key={p.id}
            project={p}
            chats={chats.filter((c) => c.projectId === p.id && (showArchived || !c.archived))}
            query={q}
            hits={contentHits}
            onEdit={() => setEditProject(p)}
            onRename={(kind, id, title) => setRename({ kind, id, title })}
            onConfirm={setConfirm}
          />
        ))}
      </nav>

      <div className="space-y-2 border-t px-3 py-2.5">
        {working.length > 0 ? (
          <div className="space-y-1">
            {working.slice(0, 3).map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-[12px]">
                <StatusIcon status={c.status} />
                <span className="truncate">{c.title}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{c.status === "approval" ? "승인 대기" : "작업 중"}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground">진행 중인 작업 없음</div>
        )}
        <UsageBar />
        <button className="text-[11.5px] text-muted-foreground hover:text-foreground" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "보관된 항목 숨기기" : "보관된 항목 보기"}
        </button>
      </div>

      <ProjectDialog open={!!editProject} onOpenChange={(o) => !o && setEditProject(undefined)} project={editProject} />
      <RenameDialog value={rename} onClose={() => setRename(null)} />
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        {confirm && (
          <DialogContent title={confirm.title} description={confirm.body} className="w-[420px]">
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                취소
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  await confirm.run();
                  setConfirm(null);
                }}
              >
                삭제
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </aside>
  );
}

function ProjectNode({
  project,
  chats,
  query,
  hits,
  onEdit,
  onRename,
  onConfirm,
}: {
  project: Project;
  chats: Chat[];
  query: string;
  hits: Set<number>;
  onEdit: () => void;
  onRename: (kind: "chat" | "project", id: number, title: string) => void;
  onConfirm: (c: { title: string; body: string; run: () => Promise<void> }) => void;
}) {
  const expanded = useStore((s) => s.expanded[`p${project.id}`] ?? true);
  const toggle = useStore((s) => s.toggle);
  const createChat = useStore((s) => s.createChat);
  const updateProject = useStore((s) => s.updateProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const shown = query
    ? chats.filter((c) => c.title.toLowerCase().includes(query) || hits.has(c.id) || project.name.toLowerCase().includes(query))
    : chats;
  if (query && shown.length === 0) return null;
  const open = expanded || !!query;

  const actions: MenuAction[] = [
    { label: "새 채팅", icon: Plus, onSelect: () => void createChat(project.id) },
    { label: "프로젝트 설정", icon: Settings2, onSelect: onEdit },
    { label: "이름 변경", icon: Pencil, onSelect: () => onRename("project", project.id, project.name) },
    { label: "폴더 열기", icon: FolderOpen, onSelect: () => void api.openPath(project.folder) },
    {
      label: project.archived ? "보관 해제" : "보관",
      icon: project.archived ? ArchiveRestore : Archive,
      onSelect: () => void updateProject(project.id, { archived: !project.archived }),
      separatorBefore: true,
    },
    {
      label: "삭제",
      icon: Trash2,
      destructive: true,
      onSelect: () =>
        onConfirm({
          title: `"${project.name}" 프로젝트를 삭제할까요?`,
          body: "앱에 저장된 채팅 기록이 모두 지워집니다. 작업 폴더의 파일과 CLI의 원본 기록은 그대로 남습니다.",
          run: () => deleteProject(project.id),
        }),
    },
  ];

  return (
    <div className="mb-1" data-testid="project-node">
      <ItemMenus actions={actions}>
        <div
          className={cn("group flex h-8 cursor-default items-center gap-1 rounded-md pr-1 pl-1 hover:bg-accent/70", project.archived && "opacity-60")}
          onClick={() => toggle(`p${project.id}`, !open)}
          title={project.folder}
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          {open ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <FolderClosed className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
          <MoreMenu actions={actions} label={`${project.name} 메뉴`} />
          <Tooltip content="새 채팅">
            <button
              aria-label={`${project.name}에 새 채팅`}
              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void createChat(project.id);
              }}
            >
              <Plus className="size-4" />
            </button>
          </Tooltip>
        </div>
      </ItemMenus>
      {open && (
        <div className="ml-3 border-l pl-1.5">
          {shown.map((c) => (
            <ChatNode key={c.id} chat={c} onRename={onRename} onConfirm={onConfirm} />
          ))}
          {!query && (
            <button
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              onClick={() => void createChat(project.id)}
            >
              <Plus className="size-3.5" /> 새 채팅
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChatNode({
  chat,
  onRename,
  onConfirm,
}: {
  chat: Chat;
  onRename: (kind: "chat" | "project", id: number, title: string) => void;
  onConfirm: (c: { title: string; body: string; run: () => Promise<void> }) => void;
}) {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const expanded = useStore((s) => !!s.expanded[`c${chat.id}`]);
  const toggle = useStore((s) => s.toggle);
  const updateChat = useStore((s) => s.updateChat);
  const deleteChat = useStore((s) => s.deleteChat);
  const consults = useStore((s) => s.consults[chat.id]);
  const active = selection?.chatId === chat.id && !selection.node;

  // Load consults lazily for the tree.
  useEffect(() => {
    if (expanded && !consults) void api.listConsults(chat.id).then((list) => useStore.setState((s) => ({ consults: { ...s.consults, [chat.id]: list } })));
  }, [expanded, consults, chat.id]);

  const roles = useMemo(() => {
    const r: Role[] = ["orch"];
    if (chat.claudeSessionId || consults?.some((c) => c.toRole === "claude")) r.push("claude");
    if (chat.codexThreadId || consults?.some((c) => c.toRole === "gpt")) r.push("gpt");
    return r;
  }, [chat.claudeSessionId, chat.codexThreadId, consults]);

  const actions: MenuAction[] = [
    { label: "이름 변경", icon: Pencil, onSelect: () => onRename("chat", chat.id, chat.title) },
    {
      label: chat.archived ? "보관 해제" : "보관",
      icon: chat.archived ? ArchiveRestore : Archive,
      onSelect: () => void updateChat(chat.id, { archived: !chat.archived }),
    },
    {
      label: "삭제",
      icon: Trash2,
      destructive: true,
      separatorBefore: true,
      onSelect: () =>
        onConfirm({
          title: `"${chat.title}" 채팅을 삭제할까요?`,
          body: "앱에 저장된 기록과 첨부 파일 목록이 지워집니다. 작업 폴더의 파일은 그대로 남습니다.",
          run: () => deleteChat(chat.id),
        }),
    },
  ];

  return (
    <div data-testid="chat-node" data-chat-id={chat.id}>
      <ItemMenus actions={actions}>
        <div
          role="treeitem"
          aria-selected={active}
          className={cn(
            "group flex h-8 cursor-default items-center gap-1.5 rounded-md pr-1 pl-1 text-[13px]",
            active ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60",
            chat.archived && "opacity-60",
          )}
          onClick={() => void select({ chatId: chat.id })}
        >
          <button
            aria-label={expanded ? "접기" : "펼치기"}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              toggle(`c${chat.id}`);
            }}
          >
            <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
          </button>
          <StatusIcon status={chat.status} unread={chat.unread} />
          <span className={cn("min-w-0 flex-1 truncate", chat.unread && "font-semibold")}>{chat.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground group-hover:hidden">{timeAgo(chat.lastActiveAt)}</span>
          <span className="hidden group-hover:block">
            <MoreMenu actions={actions} label={`${chat.title} 메뉴`} />
          </span>
        </div>
      </ItemMenus>
      {expanded && (
        <div className="ml-4 border-l py-0.5 pl-1.5">
          {roles.map((r) => (
            <NodeRow key={r} chatId={chat.id} node={r} label={`${ROLE_LABEL[r]} 대화`} icon={<RoleDot role={r} />} />
          ))}
          {consults?.map((c) => (
            <NodeRow
              key={c.id}
              chatId={chat.id}
              node={`consult:${c.id}`}
              label={`협의 ${c.seq} · ${ROLE_LABEL[c.toRole]} ${CONSULT_KIND_LABEL[c.kind]}`}
              icon={
                c.status === "running" ? (
                  <Loader2 className="size-3 animate-spin text-primary" />
                ) : c.status === "done" ? (
                  <Check className="size-3 text-success" />
                ) : (
                  <CircleAlert className="size-3 text-muted-foreground" />
                )
              }
            />
          ))}
          {roles.length === 1 && !consults?.length && (
            <div className="flex h-6 items-center gap-1.5 px-2 text-[11.5px] text-muted-foreground">
              <Bot className="size-3" /> 아직 협의 없음
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({ chatId, node, label, icon }: { chatId: number; node: NodeId; label: string; icon: React.ReactNode }) {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const active = selection?.chatId === chatId && selection.node === node;
  return (
    <button
      data-testid="tree-node"
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      onClick={() => void select({ chatId, node })}
    >
      <span className="flex w-3 justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function RenameDialog({ value, onClose }: { value: { kind: "chat" | "project"; id: number; title: string } | null; onClose: () => void }) {
  const [text, setText] = useState("");
  const updateChat = useStore((s) => s.updateChat);
  const updateProject = useStore((s) => s.updateProject);
  useEffect(() => setText(value?.title ?? ""), [value]);
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      {value && (
        <DialogContent title={value.kind === "chat" ? "채팅 이름 변경" : "프로젝트 이름 변경"} className="w-[420px]">
          <form
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              if (value.kind === "chat") await updateChat(value.id, { title: text.trim() });
              else await updateProject(value.id, { name: text.trim() });
              onClose();
            }}
          >
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="새 이름" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                취소
              </Button>
              <Button type="submit" disabled={!text.trim()}>
                저장
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

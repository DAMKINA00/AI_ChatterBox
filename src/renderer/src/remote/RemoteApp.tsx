// Remote web UI served by src/main/remote-web.ts: chats (create, rename, archive, delete, search), live
// timeline, instructions and commands, approvals, uploads, projects, usage and the page theme.
// Reuses the desktop timeline fold (buildItems/planOf/appendEvent); Markdown is rendered without raw HTML.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft, BarChart3, Flag, FolderKanban, LoaderCircle, LogOut, Monitor, Moon, Pause, Play,
  Plus, Search, Settings2, Square, Sun, Users, X,
} from "lucide-react";
import { REMOTE_EVENTS, REMOTE_LIMITS, type RemoteChatResponse, type RemoteSearchResponse } from "../../../shared/remote-web";
import { CONSULT_KIND_LABEL, roleName, type AttachmentRef, type Chat, type ChatAgent, type ChatStatus, type Consult, type ConsultStatus, type TimelineEvent } from "../../../shared/types";
import { buildItems, planOf, type Item } from "../timeline";
import { forkEventId } from "../lib/fork";
import { consultCardReview, consultCardStatus } from "../lib/review-summary";
import { cn } from "../lib/utils";
import { AuthError, request, setCsrf, url } from "./api";
import { ChatSettings } from "./ChatSettings";
import { Composer } from "./Composer";
import { chatGroups, formatBytes, INLINE_IMAGE, nextTheme, THEME_LABEL, withoutDeleted, type ProjectRef } from "./logic";
import { ProjectsSheet, useProjects } from "./Projects";
import { applyChatUpdate, applyMessage, mergeChats, mergeSnapshot, type Detail, type StreamMessage } from "./stream";
import { useTheme } from "./theme";
import { Btn, Card, Clip, ConfirmHost, errorText, FIELD, Md } from "./ui";
import { UsageSheet } from "./Usage";
import { consultCardDomId, ForkAction, ForkContext, ForkOriginBar, PlanSteps, ReviewBlock, ReviewTotalsLine, RunStatsSheet } from "./Improvements";

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "대기", working: "작업 중", approval: "승인 대기", pausing: "일시정지 중", paused: "일시정지", done: "완료", error: "오류", interrupted: "중단됨",
};
const CONSULT_STATUS_LABEL: Record<ConsultStatus, string> = { running: "진행 중", done: "완료", error: "오류", stopped: "중지", limited: "한도 도달" };
const DECISION_LABEL: Record<string, string> = { once: "한 번 허용함", chat: "이 채팅에서 허용함", deny: "거부함", auto: "자동 처리됨", expired: "만료됨" };
const busyStatus = (s: ChatStatus) => s === "working" || s === "approval" || s === "pausing" || s === "paused";



export function RemoteApp() {
  const [auth, setAuth] = useState<"checking" | "login" | "ok">("checking");
  useEffect(() => {
    request<{ csrf: string }>("/api/session").then(s => { setCsrf(s.csrf); setAuth("ok"); }).catch(() => setAuth("login"));
  }, []);
  if (auth === "checking") return <div className="flex h-dvh items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  if (auth === "login") return <Login onDone={() => setAuth("ok")} />;
  return <Workspace onLoggedOut={() => { setCsrf(""); setAuth("login"); }} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [configured, setConfigured] = useState<"local" | "synology-dsm">();
  const [emergency, setEmergency] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => { request<{ provider: "local" | "synology-dsm" }>("/api/auth-info").then(r => setConfigured(r.provider)).catch(() => setConfigured("local")); }, []);
  const nas = configured === "synology-dsm" && !emergency;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const { csrf } = await request<{ csrf: string }>("/api/login", nas ? { provider: "synology-dsm", username, password, otp } : { provider: "local", password });
      setCsrf(csrf);
      setPassword("");
      setOtp("");
      onDone();
    } catch (err) { setError(errorText(err)); }
    finally { setPending(false); }
  };
  if (!configured) return <div className="flex h-dvh items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="grid w-full max-w-sm gap-3 rounded-xl border bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold">AI ChatterBox 원격 접속</h1>
        <p className="text-[12.5px] text-muted-foreground">{nas ? "NAS(Synology DSM) 계정으로 로그인합니다." : configured === "synology-dsm" ? "비상용 로컬 비밀번호로 로그인합니다." : "원격 접속 비밀번호를 입력하세요."}</p>
        {nas && <>
          <label htmlFor="remote-username" className="text-[13px] font-medium">NAS 아이디</label>
          <input id="remote-username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={username} onChange={e => setUsername(e.target.value)} className={FIELD} />
        </>}
        <label htmlFor="remote-password" className="text-[13px] font-medium">{nas ? "NAS 비밀번호" : "비밀번호"}</label>
        <input id="remote-password" type="password" autoComplete="current-password" autoFocus={!nas} value={password} onChange={e => setPassword(e.target.value)} className={FIELD} />
        {nas && <>
          <label htmlFor="remote-otp" className="text-[13px] font-medium">2단계 인증 코드 <span className="font-normal text-muted-foreground">(사용 중이면)</span></label>
          <input id="remote-otp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ""))} className={FIELD} />
        </>}
        {error && <div role="alert" className="text-[13px] text-destructive">{error}</div>}
        <Btn type="submit" disabled={pending || !password || (nas && !username)}>{pending ? <LoaderCircle className="animate-spin" /> : null} 로그인</Btn>
        {configured === "synology-dsm" && (
          <button type="button" className="text-[12px] text-muted-foreground underline underline-offset-2" onClick={() => { setEmergency(v => !v); setError(undefined); }}>
            {emergency ? "NAS 계정으로 로그인" : "NAS에 연결할 수 없을 때: 비상용 로컬 비밀번호로 로그인"}
          </button>
        )}
      </form>
    </main>
  );
}

function Workspace({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [selected, setSelected] = useState<number | null>(() => Number(/^#chat=(\d+)$/.exec(location.hash)?.[1]) || null);
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [sheet, setSheet] = useState<"projects" | "usage" | "chat" | null>(null);
  const [theme, setTheme] = useTheme();
  // seq each held chat object came from; older snapshots never undo newer chat:updated messages.
  const versions = useRef(new Map<number, number>()).current;
  // Chats the server deleted; ids are never reused, so older snapshots cannot bring them back.
  const deleted = useRef(new Set<number>()).current;
  const fail = useCallback((e: unknown) => { if (e instanceof AuthError) onLoggedOut(); else setError(errorText(e)); }, [onLoggedOut]);
  const projectData = useProjects(fail);
  const reloadProjects = projectData.reload;
  const loadChats = useCallback(() => request<{ seq: number; chats: Chat[]; projects: ProjectRef[] }>(url("/api/chats")).then(r => {
    setChats(list => withoutDeleted(mergeChats(list, versions, r.chats, r.seq), deleted));
    setProjects(r.projects);
  }).catch(fail), [fail, versions, deleted]);

  useEffect(() => { void loadChats(); }, [loadChats]);
  useEffect(() => {
    history.replaceState(null, "", selected ? `#chat=${selected}` : location.pathname);
    setDetail(undefined);
    let closed = false;
    // Messages that arrive while a snapshot loads wait here and are replayed on top of it (see stream.ts).
    let buffer: StreamMessage[] | null = null;
    let latest = 0;
    const loadDetail = (id: number) => {
      buffer = [];
      const attempt = ++latest;
      request<Detail & { seq: number; chat: Chat }>(url("/api/chats/:id", id)).then(r => {
        // A reconnect started a newer snapshot; that one owns the buffer.
        if (closed || attempt !== latest) return;
        setDetail(mergeSnapshot(r, buffer ?? [], id));
        buffer = null;
        setChats(list => withoutDeleted(mergeChats(list, versions, [r.chat], r.seq, true), deleted));
      }).catch(e => { if (attempt === latest) buffer = null; fail(e); });
    };
    const source = new EventSource(selected ? `${url("/api/stream")}?chat=${selected}` : url("/api/stream"));
    // Every (re)connect reloads the snapshots so nothing missed while offline stays missing.
    source.onopen = () => { setError(undefined); void loadChats(); void reloadProjects(); if (selected) loadDetail(selected); };
    source.onerror = () => { void request(url("/api/session")).catch(fail); };
    source.addEventListener(REMOTE_EVENTS.chatUpdated, e => {
      const [chat] = JSON.parse((e as MessageEvent).data) as [Chat];
      if (deleted.has(chat.id)) return;
      setChats(list => applyChatUpdate(list, versions, chat, Number((e as MessageEvent).lastEventId)));
    });
    source.addEventListener(REMOTE_EVENTS.chatDeleted, e => {
      const [id] = JSON.parse((e as MessageEvent).data) as [number];
      deleted.add(id);
      setChats(list => withoutDeleted(list, deleted));
      if (id === selected) { setSelected(null); setSheet(s => (s === "chat" ? null : s)); }
    });
    source.addEventListener(REMOTE_EVENTS.projectsUpdated, () => { void reloadProjects(); void loadChats(); });
    for (const channel of [REMOTE_EVENTS.chatEvent, REMOTE_EVENTS.agentsUpdated, REMOTE_EVENTS.consultUpdated]) source.addEventListener(channel, e => {
      const message: StreamMessage = { seq: Number((e as MessageEvent).lastEventId), channel, args: JSON.parse((e as MessageEvent).data) };
      if (buffer) buffer.push(message);
      else if (selected) setDetail(d => (d ? applyMessage(d, selected, message) : d));
    });
    return () => { closed = true; source.close(); };
  }, [selected, loadChats, reloadProjects, fail, versions, deleted]);

  const chat = chats.find(c => c.id === selected);
  // Opening a chat marks it read (the desktop does the same on select); replies that arrive while it is open too.
  useEffect(() => {
    if (chat?.unread) void request(url("/api/chats/:id/viewed", chat.id), {}).catch(fail);
  }, [chat?.id, chat?.unread, fail]);

  const logout = async () => {
    await request(url("/api/logout"), {}).catch(() => undefined);
    onLoggedOut();
  };
  const newChat = async (projectId: number) => {
    try { const r = await request<RemoteChatResponse>(url("/api/chats"), { projectId }); setSelected(r.chat.id); void loadChats(); }
    catch (e) { fail(e); }
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className={cn("flex w-full flex-col border-r bg-sidebar md:w-[320px] md:shrink-0", selected && "hidden md:flex")}>
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <div className="min-w-0 flex-1 truncate font-semibold">AI ChatterBox</div>
          <Btn variant="ghost" onClick={() => setTheme(nextTheme(theme))} aria-label={`테마: ${THEME_LABEL[theme]} (눌러서 변경)`} title={`테마: ${THEME_LABEL[theme]}`}><ThemeIcon /></Btn>
          <Btn variant="ghost" onClick={() => setSheet("projects")} aria-label="프로젝트" title="프로젝트"><FolderKanban /></Btn>
          <Btn variant="ghost" onClick={() => setSheet("usage")} aria-label="사용량" title="사용량"><BarChart3 /></Btn>
          <Btn variant="ghost" onClick={() => void logout()} aria-label="로그아웃" title="로그아웃"><LogOut /></Btn>
        </div>
        {error && <div role="alert" className="flex items-start gap-2 border-b px-4 py-2 text-[12.5px] text-destructive"><span className="flex-1">{error}</span><button type="button" aria-label="오류 닫기" onClick={() => setError(undefined)}><X className="size-3.5" /></button></div>}
        <ChatList chats={chats} projects={projects} selected={selected} onSelect={setSelected} onNewChat={id => void newChat(id)} onError={fail} />
      </aside>
      <main className={cn("min-w-0 flex-1", !selected && "hidden md:block")}>
        {chat ? <ChatPane key={chat.id} chat={chat} detail={detail} sourceExists={!!chat.fork && chats.some(c => c.id === chat.fork!.sourceChatId)}
          onOpenChat={id => { setSelected(id); void loadChats(); }} onBack={() => setSelected(null)} onSettings={() => setSheet("chat")} onError={fail} />
          : <div className="flex h-full items-center justify-center text-muted-foreground">채팅을 선택하세요.</div>}
      </main>
      {sheet === "chat" && chat && <ChatSettings chat={chat} project={projectData.projects.find(p => p.id === chat.projectId)} onClose={() => setSheet(null)}
        onDeleted={() => { deleted.add(chat.id); setChats(list => withoutDeleted(list, deleted)); setSheet(null); setSelected(null); }} onAuthError={fail} />}
      {sheet === "projects" && <ProjectsSheet data={projectData} onClose={() => setSheet(null)} onChanged={() => { void reloadProjects(); void loadChats(); }}
        onOpenChat={id => { setSheet(null); setSelected(id); void loadChats(); }} onAuthError={fail} />}
      {sheet === "usage" && <UsageSheet onClose={() => setSheet(null)} onAuthError={fail} />}
      <ConfirmHost />
    </div>
  );
}

function ChatList({ chats, projects, selected, onSelect, onNewChat, onError }: {
  chats: Chat[]; projects: ProjectRef[]; selected: number | null; onSelect: (id: number) => void; onNewChat: (projectId: number) => void; onError: (e: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<number> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      request<RemoteSearchResponse>(url("/api/search", undefined, { q: q.slice(0, REMOTE_LIMITS.search) }))
        .then(r => { if (alive) setMatches(new Set(r.chatIds)); }).catch(onError);
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, onError]);
  // Search covers archived chats too, so their matches are listed.
  const groups = chatGroups(chats, projects, showArchived || !!matches, matches);
  return (
    <>
      <div className="grid gap-1.5 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={query} maxLength={REMOTE_LIMITS.search} onChange={e => setQuery(e.target.value)} placeholder="채팅 검색 (제목·내용)" aria-label="채팅 검색" className={cn(FIELD, "h-9 pl-8 text-[13.5px]")} />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> 보관된 채팅 보기</label>
      </div>
      {!groups.length ? <div className="p-4 text-[13px] text-muted-foreground">{matches ? "검색 결과가 없습니다." : "표시할 채팅이 없습니다."}</div> : (
        <nav className="flex-1 overflow-y-auto p-2" aria-label="채팅 목록">
          {groups.map(({ project, chats }) => (
            <section key={project.id} className="mb-3">
              <div className="flex items-center gap-1 px-2">
                <h2 className="min-w-0 flex-1 truncate py-1 text-[11.5px] font-medium text-muted-foreground">{project.name}{project.archived ? " (보관됨)" : ""}</h2>
                {!project.archived && <button type="button" onClick={() => onNewChat(project.id)} aria-label={`${project.name}에 새 채팅`} title="새 채팅" className="rounded p-1.5 text-muted-foreground hover:bg-accent"><Plus className="size-4" /></button>}
              </div>
              {chats.map(c => (
                <button key={c.id} type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selected}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-[13.5px] hover:bg-accent", c.id === selected && "bg-accent", c.archived && "opacity-60")}>
                  {c.unread ? <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label="읽지 않음" /> : <span className="size-2 shrink-0" />}
                  <span className={cn("min-w-0 flex-1 truncate", c.unread && "font-semibold")}>{c.title}</span>
                  <StatusBadge status={c.status} />
                </button>
              ))}
              {!chats.length && <div className="px-2 py-1.5 text-[12px] text-muted-foreground">채팅 없음</div>}
            </section>
          ))}
        </nav>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: ChatStatus }) {
  return <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
    status === "working" && "border-primary/50 text-primary", (status === "approval" || status === "interrupted") && "border-warning/60 text-warning",
    status === "error" && "border-destructive/50 text-destructive", status === "done" && "text-success")}>{STATUS_LABEL[status]}</span>;
}

function ChatPane({ chat, detail, sourceExists, onOpenChat, onBack, onSettings, onError }: { chat: Chat; detail?: Detail; sourceExists: boolean; onOpenChat: (id: number) => void; onBack: () => void; onSettings: () => void; onError: (e: unknown) => void }) {
  const [statsOpen, setStatsOpen] = useState(false);
  const live = chat.status === "working" || chat.status === "approval";
  const items = useMemo(() => (detail ? buildItems(detail.events, undefined, live) : []), [detail, live]);
  const plan = useMemo(() => (detail ? planOf(detail.events) : null), [detail]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [items]);
  const [pending, setPending] = useState(false);
  const act = async (path: string, body: unknown = {}) => {
    setPending(true);
    try { await request(path, body); } catch (e) { onError(e); } finally { setPending(false); }
  };
  const command = (name: string, arg = "") => act(url("/api/chats/:id/command", chat.id), { name, arg });
  const agents = detail?.agents ?? [];
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1.5 border-b px-2 py-2 md:px-3">
        <Btn variant="ghost" className="md:hidden" onClick={onBack} aria-label="채팅 목록"><ArrowLeft /></Btn>
        <h1 className="min-w-0 flex-1 truncate font-semibold">{chat.title}{chat.archived && <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">(보관됨)</span>}</h1>
        <StatusBadge status={chat.status} />
        {live && <Btn variant="ghost" disabled={pending} onClick={() => void act(url("/api/chats/:id/pause", chat.id))} aria-label="일시정지" title="일시정지"><Pause /></Btn>}
        {chat.status === "pausing" && <Btn variant="ghost" disabled aria-label="일시정지하는 중"><LoaderCircle className="animate-spin" /></Btn>}
        {chat.status === "paused" && <Btn variant="ghost" disabled={pending} onClick={() => void act(url("/api/chats/:id/resume", chat.id))} aria-label="재개" title="재개"><Play /></Btn>}
        {busyStatus(chat.status) && <Btn variant="destructive" disabled={pending} onClick={() => void act(url("/api/chats/:id/stop", chat.id))} aria-label="중지"><Square /><span className="hidden sm:inline">중지</span></Btn>}
        <Btn variant="ghost" disabled={!detail} onClick={() => setStatsOpen(true)} aria-label="실행 통계" title="실행 통계"><BarChart3 /></Btn>
        <Btn variant="ghost" onClick={onSettings} aria-label="채팅 설정" title="채팅 설정"><Settings2 /></Btn>
      </header>
      {statsOpen && detail && <RunStatsSheet chat={chat} events={detail.events} agents={agents} consults={detail.consults} onClose={() => setStatsOpen(false)} />}
      <ForkOriginBar chat={chat} exists={sourceExists} onOpen={onOpenChat} />
      {chat.status === "interrupted" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/50 bg-warning/10 px-3 py-2 text-[13px] md:px-6">
          <span className="min-w-0 flex-1">앱이 종료되어 작업이 중단되었습니다.</span>
          <Btn disabled={pending} onClick={() => void act(url("/api/chats/:id/resume", chat.id))}><Play /> 이어서 진행</Btn>
          <Btn variant="ghost" disabled={pending} onClick={() => void act(url("/api/chats/:id/dismiss-interrupted", chat.id))} aria-label="중단 알림 닫기"><X /></Btn>
        </div>
      )}
      <GoalBar chat={chat} pending={pending} onClear={() => void command("goal", "clear")} />
      <TeamPanel chat={chat} agents={agents} consults={detail?.consults ?? []} events={detail?.events ?? []} items={items} plan={plan} pending={pending} onPlan={name => void command(name)} />
      <div ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
        {!detail ? <div className="flex justify-center p-6 text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
          : <div className="mx-auto grid max-w-3xl gap-3">{items.map(item => <ItemView key={item.key} item={item} chat={chat} agents={agents} consults={detail?.consults ?? []} live={live} onError={onError} onForked={c => onOpenChat(c.id)} />)}</div>}
      </div>
      <Composer chat={chat} onError={onError} />
    </div>
  );
}

const GOAL_LABEL = { active: "진행 중", complete: "완료", blocked: "막힘", paused: "멈춤" } as const;

function GoalBar({ chat, pending, onClear }: { chat: Chat; pending: boolean; onClear: () => void }) {
  const g = chat.goal;
  if (!g) return null;
  return (
    <div className="flex items-start gap-2 border-b bg-primary/5 px-3 py-2 text-[12.5px] md:px-6">
      <Flag className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div><span className="font-medium">목표</span> · {GOAL_LABEL[g.status]} · {g.turns}번째 진행</div>
        <div className="break-words">{g.objective}</div>
        {g.progress && <div className="text-muted-foreground">{g.progress}</div>}
      </div>
      <Btn variant="ghost" disabled={pending} onClick={onClear} aria-label="목표 지우기" title="목표 지우기"><X /></Btn>
    </div>
  );
}

/** Attachments of a sent instruction: images inline, other files as downloads (served by the remote server). */
function AttachmentLinks({ chatId, attachments }: { chatId: number; attachments: Pick<AttachmentRef, "id" | "name" | "mime" | "size">[] }) {
  return (
    <div className="mt-1.5 grid gap-1.5">
      {attachments.map(a => {
        // ?chat= lets the server check the attachment belongs to this chat.
        const href = url("/api/attachments/:id", a.id, { chat: String(chatId) });
        return INLINE_IMAGE.test(a.mime)
          ? <a key={a.id} href={href} target="_blank" rel="noopener noreferrer"><img src={href} alt={a.name} loading="lazy" className="max-h-48 max-w-full rounded-md border bg-background object-contain" /></a>
          : <a key={a.id} href={href} download={a.name} className="text-[12px] underline underline-offset-2">{a.name} ({formatBytes(a.size)})</a>;
      })}
    </div>
  );
}

function TeamPanel({ chat, agents, consults, events, items, plan, pending, onPlan }: {
  chat: Chat; agents: ChatAgent[]; consults: Consult[]; events: TimelineEvent[]; items: Item[]; plan: ReturnType<typeof planOf>; pending: boolean; onPlan: (name: "plan-run" | "plan-cancel") => void;
}) {
  const active = agents.filter(a => a.status === "active");
  const running = consults.filter(c => c.status === "running");
  const shownPlan = plan?.state === "cancelled" ? null : plan;
  const proposed = shownPlan?.state === "proposed";
  const reviews = consults.filter(c => c.kind === "review").length;
  if (!active.length && !shownPlan && !reviews) return null;
  return (
    <details className="border-b bg-muted/30 px-3 py-2 text-[12.5px] md:px-6" open={proposed || (!!shownPlan && busyStatus(chat.status))}>
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <Users className="size-4" /> 작업자 {active.length}명{running.length ? ` · ${running.length}건 진행 중` : ""}{reviews ? ` · 리뷰 ${reviews}건` : ""}{shownPlan ? ` · ${proposed ? "계획 승인 대기" : "체크리스트"} ${shownPlan.steps.filter(s => s.status === "completed").length}/${shownPlan.steps.length}` : ""}
      </summary>
      <div className="mt-2 grid gap-2">
        {active.length > 0 && <ul className="grid gap-1">
          {active.map(a => {
            const work = running.find(c => c.toRole === a.key);
            return <li key={a.id} className="flex gap-2"><span className="font-medium">{a.nickname}</span><span className="min-w-0 truncate text-muted-foreground">{work ? `${CONSULT_KIND_LABEL[work.kind]} 진행 중 · ${work.request.slice(0, 80)}` : `대기 · ${a.job}`}</span></li>;
          })}
        </ul>}
        {shownPlan?.explanation && <div className="text-muted-foreground">{shownPlan.explanation}</div>}
        {shownPlan && <PlanSteps plan={shownPlan} consults={consults} items={items} />}
        <ReviewTotalsLine consults={consults} events={events} />
        {proposed && <div className="flex flex-wrap gap-2">
          <Btn disabled={pending} onClick={() => onPlan("plan-run")}><Play /> 계획 실행</Btn>
          <Btn variant="outline" disabled={pending} onClick={() => onPlan("plan-cancel")}><X /> 계획 취소</Btn>
          <span className="self-center text-[12px] text-muted-foreground">수정하려면 아래에 지시를 보내세요.</span>
        </div>}
      </div>
    </details>
  );
}

function ItemView({ item, chat, agents, consults, live, onError, onForked, nested = false }: { item: Item; chat: Chat; agents: ChatAgent[]; consults: Consult[]; live: boolean; onError: (e: unknown) => void; onForked: (chat: Chat) => void; nested?: boolean }) {
  const forkId = nested ? undefined : forkEventId(item);
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto grid max-w-[85%] justify-items-end gap-1">
          <div className="rounded-2xl bg-user-bubble px-3.5 py-2 text-[14px] whitespace-pre-wrap text-primary-foreground">
            {item.queued && <div className="mb-1 text-[11px] opacity-80">{item.delivery === "next" ? "다음 순서 예약" : "작업 중 추가 지시"}</div>}
            {item.text}
            {item.attachments.length > 0 && <AttachmentLinks chatId={chat.id} attachments={item.attachments} />}
          </div>
          {forkId && <ForkAction chat={chat} eventId={forkId} preview={item.text} onForked={onForked} onError={onError} />}
        </div>
      );
    case "message":
      return <div>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <span>{roleName(item.role, agents)}{item.streaming ? " · 작성 중…" : ""}</span>
          {forkId && <ForkAction chat={chat} eventId={forkId} preview={item.text} onForked={onForked} onError={onError} />}
        </div>
        <Md text={item.text} />
      </div>;
    case "fork":
      return <ForkContext item={item} />;
    case "tool":
      return (
        <details className="rounded-md border px-2.5 py-1.5 text-[12.5px]">
          <summary className="cursor-pointer truncate"><span className="text-muted-foreground">{roleName(item.role, agents)} · </span>{item.name}{item.result ? (item.result.ok ? " ✓" : " ✗") : " …"}</summary>
          <div className="mt-2 grid gap-2"><Clip text={item.input} />{item.result && <Clip text={item.result.output} />}</div>
        </details>
      );
    case "files":
      return <Card className="text-[12.5px]"><div className="mb-1 font-medium">{roleName(item.role, agents)} 파일 변경{item.ok ? "" : " (실패)"}</div><ul className="grid gap-0.5 font-mono text-[11.5px]">{item.files.map(f => <li key={f.path} className="break-all">{f.kind} {f.path}{f.movePath ? ` → ${f.movePath}` : ""}</li>)}</ul></Card>;
    case "approval":
      return <Approval item={item} chat={chat} agents={agents} live={live} onError={onError} />;
    case "auto":
      return <div className="text-[12px] text-muted-foreground">{roleName(item.request.role, agents)} · {item.request.title} → 마스터가 {item.decision === "allow" ? "허용" : "거부"}{item.reused ? " (기존 결정)" : ""} · {item.reason}</div>;
    case "consult": {
      const consult = consults.find(c => c.id === item.consultId);
      const status = consultCardStatus(item, consult);
      return (
        <div id={consultCardDomId(item.consultId)} tabIndex={-1} data-testid="remote-consult-card" data-status={status} className="rounded-lg outline-none focus:ring-2 focus:ring-primary">
        <Card>
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="font-medium">{roleName(item.from, agents)} → {roleName(item.to, agents)}</span>
            <span className="rounded border px-1.5 text-[11px]">{CONSULT_KIND_LABEL[item.consultKind]}</span>
            <span data-testid="remote-consult-status" className={cn("text-[11.5px]", status === "running" ? "text-primary" : status === "done" ? "text-success" : "text-destructive")}>{CONSULT_STATUS_LABEL[status]}</span>
          </div>
          <details className="mt-1.5 text-[12.5px]"><summary className="cursor-pointer text-muted-foreground">요청 내용</summary><div className="mt-1.5"><Md text={item.request} /></div></details>
          {item.summary && <div className="mt-2 border-t pt-2"><Md text={item.summary} /></div>}
          {item.consultKind === "review" && <ReviewBlock {...consultCardReview(item, consult)} />}
          {item.children.length > 0 && (
            <details className="mt-2 text-[12.5px]" open={status === "running"}>
              <summary className="cursor-pointer text-muted-foreground">작업 과정 {item.children.length}개</summary>
              <div className="mt-2 grid gap-2 border-l pl-3">{item.children.map(child => <ItemView key={child.key} item={child} chat={chat} agents={agents} consults={consults} live={live} onError={onError} onForked={onForked} nested />)}</div>
            </details>
          )}
        </Card>
        </div>
      );
    }
    case "image":
      return <div className="text-[12.5px] text-muted-foreground">{roleName(item.role, agents)} · 이미지 생성 {item.status === "running" ? "중" : item.status === "done" ? "완료 (앱에서 확인)" : `실패 ${item.error ?? ""}`}</div>;
    case "ask":
      return <Ask item={item} chat={chat} live={live} onError={onError} />;
    case "peer":
      return <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[12.5px]"><span className="font-medium">{roleName(item.from, agents)} → {roleName(item.to, agents)}</span> <span className="whitespace-pre-wrap text-muted-foreground">{item.text}</span></div>;
    case "notice":
      return <div className={cn("text-[12.5px]", item.tone === "info" ? "text-muted-foreground" : "text-destructive")}>{item.text}</div>;
    case "artifacts":
      return <Card className="text-[12.5px]"><div className="mb-1 font-medium">산출물</div><ul className="font-mono text-[11.5px]">{item.paths.map(p => <li key={p} className="break-all">{p}</li>)}</ul></Card>;
  }
}

function Approval({ item, chat, agents, live, onError }: { item: Extract<Item, { kind: "approval" }>; chat: Chat; agents: ChatAgent[]; live: boolean; onError: (e: unknown) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const { request: r } = item;
  const answer = async (decision: "once" | "chat" | "deny") => {
    setPending(true);
    setError(undefined);
    try { await request(`/api/chats/${chat.id}/approve`, { approvalId: r.id, decision }); }
    catch (e) { if (e instanceof AuthError) onError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  };
  const open = !item.decision && live;
  return (
    <Card className={cn(open && "border-warning/60")}>
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        <span className="font-medium">승인 요청 · {roleName(r.role, agents)}</span>
        <span className={cn("rounded border px-1.5 text-[11px]", r.risk === "high" ? "border-destructive/50 text-destructive" : "text-muted-foreground")}>{r.risk === "high" ? "고위험" : "일반"}</span>
        <span>{r.title}</span>
      </div>
      <div className="mt-2"><Clip text={r.detail} /></div>
      {(r.reason || r.riskReason || r.judgeReason) && <div className="mt-1.5 grid gap-0.5 text-[12px] text-muted-foreground">
        {r.reason && <div>사유: {r.reason}</div>}{r.riskReason && <div>위험: {r.riskReason}</div>}{r.judgeReason && <div>마스터: {r.judgeReason}</div>}
      </div>}
      {r.diffs?.length ? <ul className="mt-1.5 font-mono text-[11.5px]">{r.diffs.map(d => <li key={d.path} className="break-all">{d.kind} {d.path}</li>)}</ul> : null}
      {open ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Btn disabled={pending} onClick={() => void answer("once")}>한 번 허용</Btn>
          {r.risk !== "high" && <Btn variant="outline" disabled={pending} onClick={() => void answer("chat")}>이 채팅에서 허용</Btn>}
          <Btn variant="destructive" disabled={pending} onClick={() => void answer("deny")}>거부</Btn>
        </div>
      ) : <div className="mt-2 text-[12px] text-muted-foreground">{DECISION_LABEL[item.decision ?? "expired"]}</div>}
      {error && <div role="alert" className="mt-1.5 text-[12px] text-destructive">{error}</div>}
    </Card>
  );
}

function Ask({ item, chat, live, onError }: { item: Extract<Item, { kind: "ask" }>; chat: Chat; live: boolean; onError: (e: unknown) => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (answer: string) => {
    setPending(true);
    setError(undefined);
    try { await request(`/api/chats/${chat.id}/answer`, { askId: item.id, answer }); setText(""); }
    catch (e) { if (e instanceof AuthError) onError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  };
  const open = item.answer === undefined && live;
  return (
    <Card className={cn(open && "border-warning/60")}>
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">마스터의 질문</div>
      <Md text={item.question} />
      {item.answer !== undefined ? <div className="mt-2 text-[13px]"><span className="text-muted-foreground">답변 · </span>{item.answer}</div>
        : open ? (
          <div className="mt-2.5 grid gap-2">
            {item.options.length > 0 && <div className="flex flex-wrap gap-2">{item.options.map(o => <Btn key={o} variant="outline" disabled={pending} onClick={() => void send(o)}>{o}</Btn>)}</div>}
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (text.trim()) void send(text); }}>
              <input value={text} onChange={e => setText(e.target.value)} placeholder="직접 답변" aria-label="직접 답변" className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-[13.5px] outline-none" />
              <Btn type="submit" disabled={pending || !text.trim()}>답변</Btn>
            </form>
          </div>
        ) : <div className="mt-2 text-[12px] text-muted-foreground">답변하지 않은 채 종료됨</div>}
      {error && <div role="alert" className="mt-1.5 text-[12px] text-destructive">{error}</div>}
    </Card>
  );
}

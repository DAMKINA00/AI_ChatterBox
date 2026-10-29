// Remote web UI served by src/main/remote-web.ts: chat list, live timeline, extra instructions, approvals.
// Reuses the desktop timeline fold (buildItems/planOf/appendEvent); Markdown is rendered without raw HTML.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Circle, CircleCheck, CircleDot, LoaderCircle, LogOut, Send, Square, Users } from "lucide-react";
import { CONSULT_KIND_LABEL, roleName, type Chat, type ChatAgent, type ChatStatus, type Consult, type ConsultStatus } from "../../../shared/types";
import { buildItems, planOf, type Item } from "../timeline";
import { cn } from "../lib/utils";
import { AuthError, request, setCsrf } from "./api";
import { applyChatUpdate, applyMessage, mergeChats, mergeSnapshot, type Detail, type StreamMessage } from "./stream";

interface ProjectRef { id: number; name: string; archived: boolean }

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "대기", working: "작업 중", approval: "승인 대기", pausing: "일시정지 중", paused: "일시정지", done: "완료", error: "오류", interrupted: "중단됨",
};
const CONSULT_STATUS_LABEL: Record<ConsultStatus, string> = { running: "진행 중", done: "완료", error: "오류", stopped: "중지", limited: "한도 도달" };
const DECISION_LABEL: Record<string, string> = { once: "한 번 허용함", chat: "이 채팅에서 허용함", deny: "거부함", auto: "자동 처리됨", expired: "만료됨" };
const busyStatus = (s: ChatStatus) => s === "working" || s === "approval" || s === "pausing" || s === "paused";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Btn({ className, variant = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "destructive" | "ghost" }) {
  return <button type="button" className={cn(
    "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-45 [&_svg]:size-4",
    variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
    variant === "outline" && "border hover:bg-accent",
    variant === "destructive" && "bg-destructive text-white hover:bg-destructive/90",
    variant === "ghost" && "hover:bg-accent",
    className,
  )} {...props} />;
}

function Md({ text }: { text: string }) {
  return (
    <div className="prose-chat break-words text-[14px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          // External images would leak the page to third parties; show the alt text instead.
          img: ({ alt, src }) => <span className="text-muted-foreground">[이미지: {alt || src}]</span>,
          table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded-lg border bg-code-bg p-3 font-mono text-[12.5px]">{children}</pre>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}

export function RemoteApp() {
  const [auth, setAuth] = useState<"checking" | "login" | "ok">("checking");
  useEffect(() => {
    request<{ csrf: string }>("/api/session").then(s => { setCsrf(s.csrf); setAuth("ok"); }).catch(() => setAuth("login"));
  }, []);
  if (auth === "checking") return <div className="flex h-dvh items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  if (auth === "login") return <Login onDone={() => setAuth("ok")} />;
  return <Workspace onLoggedOut={() => { setCsrf(""); setAuth("login"); }} />;
}

const FIELD = "h-10 rounded-md border border-input bg-transparent px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

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
  // seq each held chat object came from; older snapshots never undo newer chat:updated messages.
  const versions = useRef(new Map<number, number>()).current;
  const fail = useCallback((e: unknown) => { if (e instanceof AuthError) onLoggedOut(); else setError(errorText(e)); }, [onLoggedOut]);
  const loadChats = useCallback(() => request<{ seq: number; chats: Chat[]; projects: ProjectRef[] }>("/api/chats").then(r => {
    setChats(list => mergeChats(list, versions, r.chats, r.seq));
    setProjects(r.projects);
  }).catch(fail), [fail, versions]);

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
      request<Detail & { seq: number; chat: Chat }>(`/api/chats/${id}`).then(r => {
        // A reconnect started a newer snapshot; that one owns the buffer.
        if (closed || attempt !== latest) return;
        setDetail(mergeSnapshot(r, buffer ?? [], id));
        buffer = null;
        setChats(list => mergeChats(list, versions, [r.chat], r.seq, true));
      }).catch(e => { if (attempt === latest) buffer = null; fail(e); });
    };
    const source = new EventSource(selected ? `/api/stream?chat=${selected}` : "/api/stream");
    // Every (re)connect reloads the snapshot so nothing missed while offline stays missing.
    source.onopen = () => { setError(undefined); void loadChats(); if (selected) loadDetail(selected); };
    source.onerror = () => { void request("/api/session").catch(fail); };
    source.addEventListener("chat:updated", e => {
      const [chat] = JSON.parse((e as MessageEvent).data) as [Chat];
      setChats(list => applyChatUpdate(list, versions, chat, Number((e as MessageEvent).lastEventId)));
    });
    for (const channel of ["chat:event", "agents:updated", "consult:updated"]) source.addEventListener(channel, e => {
      const message: StreamMessage = { seq: Number((e as MessageEvent).lastEventId), channel, args: JSON.parse((e as MessageEvent).data) };
      if (buffer) buffer.push(message);
      else if (selected) setDetail(d => (d ? applyMessage(d, selected, message) : d));
    });
    return () => { closed = true; source.close(); };
  }, [selected, loadChats, fail, versions]);

  const logout = async () => {
    await request("/api/logout", {}).catch(() => undefined);
    onLoggedOut();
  };
  const chat = chats.find(c => c.id === selected);
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className={cn("flex w-full flex-col border-r bg-sidebar md:w-[300px] md:shrink-0", selected && "hidden md:flex")}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="font-semibold">AI ChatterBox</div>
          <Btn variant="ghost" onClick={() => void logout()} aria-label="로그아웃"><LogOut /> 로그아웃</Btn>
        </div>
        {error && <div role="alert" className="border-b px-4 py-2 text-[12.5px] text-destructive">{error}</div>}
        <ChatList chats={chats} projects={projects} selected={selected} onSelect={setSelected} />
      </aside>
      <main className={cn("min-w-0 flex-1", !selected && "hidden md:block")}>
        {chat ? <ChatPane key={chat.id} chat={chat} detail={detail} onBack={() => setSelected(null)} onError={fail} />
          : <div className="flex h-full items-center justify-center text-muted-foreground">채팅을 선택하세요.</div>}
      </main>
    </div>
  );
}

function ChatList({ chats, projects, selected, onSelect }: { chats: Chat[]; projects: ProjectRef[]; selected: number | null; onSelect: (id: number) => void }) {
  const groups = projects.filter(p => !p.archived).map(p => ({ project: p, chats: chats.filter(c => c.projectId === p.id && !c.archived) })).filter(g => g.chats.length);
  if (!groups.length) return <div className="p-4 text-[13px] text-muted-foreground">표시할 채팅이 없습니다.</div>;
  return (
    <nav className="flex-1 overflow-y-auto p-2" aria-label="채팅 목록">
      {groups.map(({ project, chats }) => (
        <section key={project.id} className="mb-3">
          <h2 className="px-2 py-1 text-[11.5px] font-medium text-muted-foreground">{project.name}</h2>
          {chats.map(c => (
            <button key={c.id} type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selected}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-[13.5px] hover:bg-accent", c.id === selected && "bg-accent")}>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <StatusBadge status={c.status} />
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}

function StatusBadge({ status }: { status: ChatStatus }) {
  return <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
    status === "working" && "border-primary/50 text-primary", status === "approval" && "border-warning/60 text-warning",
    status === "error" && "border-destructive/50 text-destructive", status === "done" && "text-success")}>{STATUS_LABEL[status]}</span>;
}

function ChatPane({ chat, detail, onBack, onError }: { chat: Chat; detail?: Detail; onBack: () => void; onError: (e: unknown) => void }) {
  const live = chat.status === "working" || chat.status === "approval";
  const items = useMemo(() => (detail ? buildItems(detail.events, undefined, live) : []), [detail, live]);
  const plan = useMemo(() => (detail ? planOf(detail.events) : null), [detail]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [items]);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try { await request(`/api/chats/${chat.id}/stop`, {}); } catch (e) { onError(e); } finally { setStopping(false); }
  };
  const agents = detail?.agents ?? [];
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Btn variant="ghost" className="md:hidden" onClick={onBack} aria-label="채팅 목록"><ArrowLeft /></Btn>
        <h1 className="min-w-0 flex-1 truncate font-semibold">{chat.title}</h1>
        <StatusBadge status={chat.status} />
        {busyStatus(chat.status) && <Btn variant="destructive" disabled={stopping} onClick={() => void stop()}><Square /> 중지</Btn>}
      </header>
      <TeamPanel chat={chat} agents={agents} consults={detail?.consults ?? []} plan={plan} />
      <div ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="flex-1 overflow-y-auto px-3 py-4 md:px-6">
        {!detail ? <div className="flex justify-center p-6 text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
          : <div className="mx-auto grid max-w-3xl gap-3">{items.map(item => <ItemView key={item.key} item={item} chat={chat} agents={agents} live={live} onError={onError} />)}</div>}
      </div>
      <Composer chat={chat} onError={onError} />
    </div>
  );
}

function TeamPanel({ chat, agents, consults, plan }: { chat: Chat; agents: ChatAgent[]; consults: Consult[]; plan: ReturnType<typeof planOf> }) {
  const active = agents.filter(a => a.status === "active");
  const running = consults.filter(c => c.status === "running");
  if (!active.length && !plan && !chat.goal) return null;
  return (
    <details className="border-b bg-muted/30 px-3 py-2 text-[12.5px] md:px-6" open={!!plan && busyStatus(chat.status)}>
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <Users className="size-4" /> 작업자 {active.length}명{running.length ? ` · ${running.length}건 진행 중` : ""}{plan ? ` · 체크리스트 ${plan.steps.filter(s => s.status === "completed").length}/${plan.steps.length}` : ""}
      </summary>
      <div className="mt-2 grid gap-2">
        {chat.goal && <div><span className="font-medium">목표</span> · {chat.goal.objective} <span className="text-muted-foreground">({chat.goal.status})</span></div>}
        {active.length > 0 && <ul className="grid gap-1">
          {active.map(a => {
            const work = running.find(c => c.toRole === a.key);
            return <li key={a.id} className="flex gap-2"><span className="font-medium">{a.nickname}</span><span className="min-w-0 truncate text-muted-foreground">{work ? `${CONSULT_KIND_LABEL[work.kind]} 진행 중 · ${work.request.slice(0, 80)}` : `대기 · ${a.job}`}</span></li>;
          })}
        </ul>}
        {plan && <ol className="grid gap-1" aria-label="체크리스트">
          {plan.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {s.status === "completed" ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : s.status === "inProgress" ? <CircleDot className="mt-0.5 size-3.5 shrink-0 text-primary" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
              <span className={cn(s.status === "completed" && "text-muted-foreground line-through")}>{s.title}</span>
            </li>
          ))}
        </ol>}
      </div>
    </details>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border bg-card p-3", className)}>{children}</div>;
}

function Clip({ text, limit = 4000 }: { text: string; limit?: number }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code-bg p-2 font-mono text-[11.5px]">{text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit}자 생략)` : text}</pre>;
}

function ItemView({ item, chat, agents, live, onError }: { item: Item; chat: Chat; agents: ChatAgent[]; live: boolean; onError: (e: unknown) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[85%] rounded-2xl bg-user-bubble px-3.5 py-2 text-[14px] whitespace-pre-wrap text-primary-foreground">
          {item.queued && <div className="mb-1 text-[11px] opacity-80">{item.delivery === "next" ? "다음 순서 예약" : "작업 중 추가 지시"}</div>}
          {item.text}
          {item.attachments.length > 0 && <div className="mt-1 text-[11px] opacity-80">첨부 {item.attachments.map(a => a.name).join(", ")}</div>}
        </div>
      );
    case "message":
      return <div><div className="mb-1 text-[12px] font-medium text-muted-foreground">{roleName(item.role, agents)}{item.streaming ? " · 작성 중…" : ""}</div><Md text={item.text} /></div>;
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
    case "consult":
      return (
        <Card>
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="font-medium">{roleName(item.from, agents)} → {roleName(item.to, agents)}</span>
            <span className="rounded border px-1.5 text-[11px]">{CONSULT_KIND_LABEL[item.consultKind]}</span>
            <span className={cn("text-[11.5px]", item.status === "running" ? "text-primary" : item.status === "done" ? "text-success" : "text-destructive")}>{CONSULT_STATUS_LABEL[item.status]}</span>
          </div>
          <details className="mt-1.5 text-[12.5px]"><summary className="cursor-pointer text-muted-foreground">요청 내용</summary><div className="mt-1.5"><Md text={item.request} /></div></details>
          {item.summary && <div className="mt-2 border-t pt-2"><Md text={item.summary} /></div>}
          {item.children.length > 0 && (
            <details className="mt-2 text-[12.5px]" open={item.status === "running"}>
              <summary className="cursor-pointer text-muted-foreground">작업 과정 {item.children.length}개</summary>
              <div className="mt-2 grid gap-2 border-l pl-3">{item.children.map(child => <ItemView key={child.key} item={child} chat={chat} agents={agents} live={live} onError={onError} />)}</div>
            </details>
          )}
        </Card>
      );
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

function Composer({ chat, onError }: { chat: Chat; onError: (e: unknown) => void }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = busyStatus(chat.status);
  const send = async (delivery: "now" | "next") => {
    if (!text.trim()) return;
    setPending(true);
    setError(undefined);
    try { await request(`/api/chats/${chat.id}/send`, { text, delivery }); setText(""); }
    catch (e) { if (e instanceof AuthError) onError(e); else setError(errorText(e)); }
    finally { setPending(false); }
  };
  return (
    <div className="border-t bg-background px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto grid max-w-3xl gap-2">
        {error && <div role="alert" className="text-[12.5px] text-destructive">{error}</div>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} aria-label="지시 입력"
          placeholder={busy ? "작업 중 추가 지시 (Ctrl+Enter 즉시 전달)" : "새 지시 (Ctrl+Enter 보내기)"}
          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send("now"); } }}
          className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
        <div className="flex flex-wrap justify-end gap-2">
          {busy ? <>
            <Btn variant="outline" disabled={pending || !text.trim()} onClick={() => void send("next")}>다음 순서 예약</Btn>
            <Btn disabled={pending || !text.trim()} onClick={() => void send("now")}><Send /> 즉시 전달</Btn>
          </> : <Btn disabled={pending || !text.trim()} onClick={() => void send("now")}><Send /> 보내기</Btn>}
        </div>
      </div>
    </div>
  );
}

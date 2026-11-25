import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bookmark, Hash, ImageIcon, MessagesSquare, Sparkles, Square, UsersRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MeetingEvent, MeetingMessage, MeetingSnapshot } from "../../../shared/character-meeting";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../../../shared/usage-companion";
import { AgentAvatar } from "../components/AgentAvatar";
import { cn, errorMessage } from "../lib/utils";
import { useMobile } from "../lib/remote-mode";
import { AuthError, request, url } from "./api";

const EMPTY: MeetingSnapshot = { seq: -1, requestId: null, messages: [], drafts: [], connected: [], resting: [], status: "" };
const NAME = { ...MONITOR_CHARACTER_LABEL, orch: "마스터", user: "사용자", system: "회의 안내" };
const ROLE = { assignment: "질문", report: "발표", review: "의견", discussion: "발언", summary: "결론" };
const TONE = { orch: "text-[#a0edcd]", claude: "text-[#ffb0a3]", gpt: "text-[#d0c1ff]", gemini: "text-[#ffd284]",
  grok: "text-[#b1c9ff]", deepseek: "text-[#8cdaff]", user: "text-[#e6d9ef]", system: "text-[#c4c8dc]" };
const CLOCK = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });

export function BoardroomTabs({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState(() => new URLSearchParams(location.search).get("tab") === "boardroom");
  function select(value: boolean) {
    setRoom(value);
    const address = new URL(location.href);
    if (value) address.searchParams.set("tab", "boardroom");
    else address.searchParams.delete("tab");
    history.replaceState(history.state, "", address);
  }

  return <div className="flex h-dvh flex-col overflow-hidden">
    <nav aria-label="웹 앱" className="flex shrink-0 items-center gap-1 border-b bg-background px-3 py-1.5 sm:px-4">
      <button type="button" id="workspace-tab" aria-pressed={!room} aria-controls="workspace-panel" onClick={() => select(false)}
        className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold", !room ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70")}>
        <MessagesSquare className="size-4" aria-hidden /> ChatterBox
      </button>
      <button type="button" id="boardroom-tab" aria-pressed={room} aria-controls="boardroom-panel" onClick={() => select(true)}
        className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold", room ? "bg-[#2d3449] text-[#afc2ff]" : "text-muted-foreground hover:bg-accent/70")}>
        <Sparkles className="size-4" aria-hidden /> Boardroom
      </button>
    </nav>
    <section id="workspace-panel" aria-labelledby="workspace-tab" className={cn("min-h-0 flex-1", room && "hidden")}>{children}</section>
    <section id="boardroom-panel" aria-labelledby="boardroom-tab" className={cn("min-h-0 flex-1", !room && "hidden")}>{room && <Boardroom />}</section>
  </div>;
}

function applyEvent(state: MeetingSnapshot, event: MeetingEvent): MeetingSnapshot {
  if (event.seq <= state.seq) return state;
  const next = { ...state, seq: event.seq, requestId: event.type === "end" ? null : event.requestId };
  if (event.type === "status" || event.type === "end") next.status = event.text;
  if (event.type === "roster") {
    next.connected = event.connected;
    next.resting = event.resting;
  }
  if (event.type === "draft") {
    next.drafts = [...next.drafts.filter(post => post.id !== event.message.id), event.message];
  }
  if (event.type === "message") {
    next.drafts = next.drafts.filter(post => post.id !== event.message.id);
    next.messages = [...next.messages, event.message].slice(-45);
  }
  if (event.type === "withdraw") next.drafts = next.drafts.filter(post => post.id !== event.id);
  return next;
}

function Boardroom() {
  const [room, setRoom] = useState(EMPTY);
  const [problem, setProblem] = useState("");
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState(() => {
    try { return sessionStorage.getItem("cbx-boardroom-draft") ?? ""; } catch { return ""; }
  });
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rosterPreference, setRosterPreference] = useState<boolean>();
  const [atLatest, setAtLatest] = useState(true);
  const mobile = useMobile();
  const showRoster = rosterPreference ?? !mobile;
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const field = useRef<HTMLTextAreaElement>(null);
  const fault = (error: unknown) => {
    if (error instanceof AuthError) location.reload();
    else setProblem(errorMessage(error));
  };

  useEffect(() => {
    let closed = false, generation = 0;
    let pending: MeetingEvent[] | undefined = [];
    const source = new EventSource(url("/api/boardroom/stream"));
    const sync = (online: boolean) => {
      pending = [];
      const generationAtStart = ++generation;
      void request<MeetingSnapshot>(url("/api/boardroom")).then(snapshot => {
        if (closed || generationAtStart !== generation) return;
        const state = (pending ?? []).reduce(applyEvent, snapshot);
        pending = undefined;
        setRoom(state);
        setReady(online);
        if (online) setProblem("");
      }).catch(error => { if (!closed && generationAtStart === generation) fault(error); });
    };
    source.onopen = () => sync(true);
    source.onerror = () => {
      if (closed) return;
      setReady(false);
      setProblem("회의실에 다시 연결하는 중…");
      sync(false);
    };
    source.addEventListener("boardroom:event", line => {
      if (closed) return;
      let event: MeetingEvent;
      try { [event] = JSON.parse((line as MessageEvent<string>).data) as [MeetingEvent]; }
      catch { return; }
      if (pending) pending.push(event);
      else setRoom(old => applyEvent(old, event));
    });
    return () => { closed = true; source.close(); };
  }, []);

  function goLatest() {
    follow.current = true;
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    setAtLatest(true);
  }

  useLayoutEffect(() => { if (follow.current) goLatest(); }, [room, showRoster]);
  useEffect(() => { try { sessionStorage.setItem("cbx-boardroom-draft", draft); } catch { /* Browser storage can be unavailable. */ } }, [draft]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!ready || submitting || room.requestId || !draft.trim()) return;
    setProblem("");
    setSubmitting(true);
    try {
      await request(url("/api/boardroom"), { text: draft.trim() });
      setDraft("");
      goLatest();
      field.current?.focus();
    } catch (e) { fault(e); }
    finally { setSubmitting(false); }
  }

  async function stop() {
    if (!room.requestId || stopping) return;
    setStopping(true);
    try { await request(url("/api/boardroom/stop"), { requestId: room.requestId }); }
    catch (e) { fault(e); }
    finally { setStopping(false); }
  }

  const speaking = new Set(room.drafts.map(message => message.sender));
  const posts = [...room.messages, ...room.drafts].sort((a, b) => a.at - b.at);
  const latestResult = room.messages.findLast(message => message.kind === "summary");
  function goResult() {
    const container = scroll.current;
    const result = latestResult && document.getElementById(`boardroom-message-${latestResult.id}`);
    if (!container || !result) return;
    follow.current = false;
    container.scrollTop += result.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
  }

  return <div className="boardroom flex h-full min-w-0 flex-col [color-scheme:dark]">
    <header className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-[var(--room-line)] px-3 sm:gap-2.5 sm:px-5">
      <Hash className="size-5 shrink-0 text-[var(--room-muted)]" aria-hidden />
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base">회의실</h1>
      <span className="mr-1 hidden shrink-0 items-center gap-1.5 text-xs text-[var(--room-muted)] sm:flex">
        <span className={cn("size-1.5 rounded-full", ready ? "bg-[var(--room-mint)]" : "bg-[var(--room-coral)]")} />{ready ? "연결됨" : "연결 중"}
      </span>
      <button type="button" onClick={goResult} disabled={!latestResult} className="boardroom-action">
        <Bookmark className="size-4" aria-hidden /> 최근 결론
      </button>
      <button type="button" aria-pressed={showRoster} aria-controls="boardroom-roster" onClick={() => setRosterPreference(!showRoster)} className="boardroom-action">
        <UsersRound className="size-4" aria-hidden /> 참가자
      </button>
    </header>
    <div className="relative flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="회의 대화">
        <div ref={scroll} onScroll={event => {
          const el = event.currentTarget;
          const atEnd = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
          follow.current = atEnd;
          setAtLatest(atEnd);
        }} className="boardroom-scroll min-h-0 flex-1 overflow-y-auto py-2.5 sm:py-3">
          {!posts.length && <p className="mx-auto max-w-[940px] px-6 py-7 text-sm text-[var(--room-muted)]">
            안건을 보내면 마스터가 첫 질문을 던지고 참가자들이 차례로 의견을 이어갑니다.
          </p>}
          <div className="mx-auto grid max-w-[940px] gap-0.5 px-2 sm:px-4">
            {posts.map(post => <Post key={post.id} post={post} streaming={room.drafts.some(draft => draft.id === post.id)} />)}
          </div>
        </div>
        <form onSubmit={send} className="mx-auto w-full max-w-[940px] px-3 pb-3 sm:px-5 sm:pb-4">
          {(problem || room.status || !atLatest) && <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
            <p role={problem ? "alert" : "status"} className={cn("min-w-0 text-xs", problem ? "text-[var(--room-coral)]" : "text-[var(--room-mint)]")}>{problem || room.status}</p>
            {!atLatest && <button type="button" onClick={goLatest} className="boardroom-action shrink-0">
              <ArrowDown className="size-3.5" aria-hidden /> 최신 메시지
            </button>}
          </div>}
          <div className="flex min-w-0 items-end gap-2 rounded-lg border border-[var(--room-line)] bg-[var(--room-well)] p-1.5 focus-within:border-[var(--room-accent)] sm:p-2">
            <textarea ref={field} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4_000} rows={2}
              onKeyDown={e => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !matchMedia("(pointer:fine)").matches) return;
                e.preventDefault();
                void send();
              }}
              placeholder="회의실에 안건 보내기" aria-label="회의 안건" className="max-h-[30dvh] min-h-9 min-w-0 flex-1 resize-y bg-transparent px-2 py-1 text-base outline-none placeholder:text-[var(--room-muted)] sm:text-sm" />
            {room.requestId && <button type="button" title="회의 중단" aria-label="회의 중단" onClick={() => void stop()} disabled={stopping}
              className="grid size-9 shrink-0 place-items-center rounded-md border border-[var(--room-line)] text-[var(--room-coral)] hover:bg-[var(--room-hover)] disabled:opacity-50"><Square className="size-4" aria-hidden /></button>}
            <button type="submit" title="안건 보내기" aria-label="안건 보내기" disabled={!ready || submitting || Boolean(room.requestId) || !draft.trim()}
              className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--room-accent)] text-[#1b1e26] hover:brightness-110 disabled:opacity-35"><ArrowUp className="size-5" aria-hidden /></button>
          </div>
        </form>
      </section>
      <aside id="boardroom-roster" hidden={!showRoster} aria-label="참가자"
        className="boardroom-scroll absolute inset-y-0 right-0 z-10 w-52 shrink-0 overflow-y-auto border-l border-[var(--room-line)] bg-[var(--room-side)] px-3 py-4 shadow-xl md:static md:shadow-none">
        <h2 className="mb-2 flex items-center justify-between gap-1 px-2 text-xs font-semibold text-[var(--room-muted)]">
          참가자 {room.seq >= 0 && <span>{room.connected.length}/{MONITOR_CHARACTERS.length} 연결</span>}
        </h2>
        <ul className="grid gap-0.5">
          {MONITOR_CHARACTERS.map(id => {
            const active = speaking.has(id);
            const connected = room.seq >= 0 && room.connected.includes(id);
            const resting = room.resting?.includes(id);
            return <li key={id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5",
              active && "bg-[var(--room-live)]", room.seq >= 0 && !connected && "opacity-65")}>
              <Portrait id={id} active={active} />
              <div><div className="text-xs font-semibold">{NAME[id]}</div><div className={cn("text-[11px]",
                active ? "text-[var(--room-mint)]" : resting ? "text-[var(--room-coral)]" : "text-[var(--room-muted)]")}>
                {active ? "작성 중…" : room.seq < 0 ? "연결 확인 중" : resting ? "잔여량 낮음 · 발언 쉼" : connected ? "참여 가능" : "연결 필요"}</div></div>
            </li>;
          })}
        </ul>
      </aside>
    </div>
  </div>;
}

function Portrait({ id, active }: { id: MonitorCharacterId; active: boolean }) {
  return <span className={cn("grid size-[34px] shrink-0 place-items-center rounded-full border bg-[var(--room-side)]", active ? "border-[var(--room-mint)]" : "border-[var(--room-line)]")}>
    <AgentAvatar kind={id} size={32} alt="" expression={active ? "speaking" : "neutral"}
      className={cn("rounded-lg object-contain", active && "motion-safe:animate-[boardroom-speaking_.48s_ease-in-out_infinite_alternate]")} />
  </span>;
}

const Post = memo(function Post({ post, streaming }: { post: MeetingMessage; streaming: boolean }) {
  return <article id={`boardroom-message-${post.id}`} className={cn("flex min-w-0 items-start gap-3 rounded-md border-l-2 border-transparent px-2 py-1.5 sm:px-3",
    post.kind === "summary" ? "border-l-[var(--room-accent)] bg-[var(--room-result)]"
      : streaming ? "border-l-[var(--room-mint)] bg-[var(--room-live)]"
      : post.kind === "assignment" ? "bg-[var(--room-well)]" : "hover:bg-[var(--room-hover)]")}>
    {post.sender === "user" || post.sender === "system"
      ? <span className="grid size-[34px] shrink-0 place-items-center rounded-full border border-[var(--room-line)] bg-[var(--room-side)] text-sm text-[var(--room-muted)]">{post.sender === "user" ? "나" : "✦"}</span>
      : <Portrait id={post.sender} active={streaming} />}
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("text-sm font-semibold", TONE[post.sender])}>{NAME[post.sender]}</span>
        <time className="text-[11px] text-[var(--room-muted)]" dateTime={new Date(post.at).toISOString()}>{CLOCK.format(post.at)}</time>
        {post.kind && <span className="rounded-sm bg-[var(--room-well)] px-1.5 text-[11px] text-[var(--room-accent)]">{ROLE[post.kind]}</span>}
      </div>
      {streaming ? <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{post.text}<span aria-hidden className="ml-0.5 text-[var(--room-mint)]">▏</span></div>
        : <RichText text={post.text} />}
    </div>
  </article>;
});

function linkUrl(raw: string, image = false) {
  try {
    const uri = new URL(raw);
    if ((uri.protocol === "https:" || !image && uri.protocol === "http:") && !uri.username && !uri.password) return uri.href;
  } catch { /* Display the text of malformed or relative URLs. */ }
  return "";
}

function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [show, setShow] = useState(false);
  const [failed, setFailed] = useState(false);
  const uri = linkUrl(src, true);
  const original = linkUrl(src);
  if (!original) return <span>{alt || "이미지"}</span>;
  return <span className="my-2 inline-flex max-w-full flex-col items-start gap-2 rounded-lg border border-[var(--room-line)] bg-[var(--room-side)] p-2">
    {uri && show && !failed && <img className="max-h-80 max-w-full rounded-lg object-contain" src={uri} alt={alt}
      referrerPolicy="no-referrer" decoding="async" onError={() => setFailed(true)} />}
    {uri && (!show || failed) && <button type="button" onClick={() => { setShow(true); setFailed(false); }}
      className="boardroom-action">
      <ImageIcon className="size-3.5" aria-hidden />{failed ? "불러오지 못함 · 다시 시도" : "이미지 보기"}
    </button>}
    <a href={original} target="_blank" rel="noreferrer">{alt || "이미지 원본"}</a>
  </span>;
}

function RichText({ text }: { text: string }) {
  return <div className="prose-chat boardroom-rich text-sm break-words">
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(value) => linkUrl(value)} components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ src, alt }) => <ImagePreview src={src ?? ""} alt={alt ?? ""} />,
      table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown>
  </div>;
}

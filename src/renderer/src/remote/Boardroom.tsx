import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ImageIcon, MessagesSquare, Sparkles, Square, UsersRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MeetingEvent, MeetingMessage, MeetingSnapshot } from "../../../shared/character-meeting";
import { MONITOR_CHARACTERS, MONITOR_CHARACTER_LABEL, type MonitorCharacterId } from "../../../shared/usage-companion";
import { AgentAvatar } from "../components/AgentAvatar";
import { cn, errorMessage } from "../lib/utils";
import { AuthError, request, url } from "./api";

const EMPTY: MeetingSnapshot = { seq: -1, requestId: null, messages: [], drafts: [], connected: [], status: "" };
const NAME = { ...MONITOR_CHARACTER_LABEL, orch: "마스터", user: "사용자", system: "회의 안내" };
const ROLE = { assignment: "지명", report: "발표", review: "의견", summary: "회의 결과" };
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
        className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold", room ? "bg-[#283e3d] text-[#acedd3]" : "text-muted-foreground hover:bg-accent/70")}>
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
  if (event.type === "roster") next.connected = event.connected;
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

  useLayoutEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [room]);
  useEffect(() => { try { sessionStorage.setItem("cbx-boardroom-draft", draft); } catch { /* Browser storage can be unavailable. */ } }, [draft]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!ready || submitting || room.requestId || !draft.trim()) return;
    setProblem("");
    setSubmitting(true);
    try {
      await request(url("/api/boardroom"), { text: draft.trim() });
      setDraft("");
      follow.current = true;
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
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
  return <div className="flex h-full min-w-0 flex-col bg-[#242735] text-[#f4f1fc] [color-scheme:dark]">
    <header className="flex shrink-0 items-center gap-3 border-b border-[#3b4054] bg-[#1b1e2a] px-4 py-3 sm:px-6">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#a0edcd] text-[#1b1e2a]"><Sparkles className="size-5" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <h1 className="text-lg leading-none font-semibold">Boardroom</h1>
        <p className="mt-1 text-xs text-[#bcc1d6]">캐릭터 회의실</p>
      </div>
      <span className="hidden items-center gap-1.5 rounded-full border border-[#3b4054] px-2.5 py-1 text-xs text-[#bcc1d6] sm:flex">
        <span className={cn("size-1.5 rounded-full", ready ? "bg-[#a0edcd]" : "bg-[#f5ab99]")} />{ready ? "연결됨" : "연결 중"}
      </span>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <section className="order-2 flex min-h-0 min-w-0 flex-1 flex-col md:order-1" aria-label="회의 대화">
        <div ref={scroll} onScroll={event => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 72;
        }} className="min-h-0 flex-1 overflow-y-auto py-4">
          {!posts.length && <div className="mx-auto max-w-[760px] px-6 py-8 sm:pt-14">
            <h2 className="text-xl font-semibold text-[#a0edcd]">어떤 안건을 살펴볼까요?</h2>
            <p className="mt-2 max-w-[38ch] text-sm leading-relaxed text-[#bcc1d6]">마스터가 담당자를 지명하면, 발표와 참가자들의 의견이 여기에 이어져요.</p>
          </div>}
          <div className="mx-auto grid max-w-[880px] gap-1.5 px-2 sm:px-5">
            {posts.map(post => <Post key={post.id} post={post} streaming={room.drafts.some(draft => draft.id === post.id)} />)}
          </div>
        </div>
        <form onSubmit={send} className="mx-auto w-full max-w-[880px] px-3 pb-3 sm:px-5 sm:pb-5">
          {(problem || room.status) && <p role={problem ? "alert" : "status"} className={cn("mb-2 px-1 text-xs", problem ? "text-[#f5ab99]" : "text-[#a0edcd]")}>{problem || room.status}</p>}
          <div className="flex min-w-0 items-end gap-2 rounded-2xl border border-[#3b4054] bg-[#1b1e2a] p-2.5 focus-within:border-[#a0edcd]/65">
            <textarea ref={field} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4_000} rows={2}
              onKeyDown={e => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !matchMedia("(pointer:fine)").matches) return;
                e.preventDefault();
                void send();
              }}
              placeholder="회의실에 안건 보내기" aria-label="회의 안건" className="min-h-12 min-w-0 flex-1 resize-y rounded-lg bg-transparent px-2 py-1 text-base outline-none placeholder:text-[#a5acc2] sm:text-sm" />
            {room.requestId && <button type="button" title="회의 중단" aria-label="회의 중단" onClick={() => void stop()} disabled={stopping}
              className="grid size-9 shrink-0 place-items-center rounded-xl border border-[#3b4054] text-[#f5ab99] hover:bg-[#303447] disabled:opacity-50"><Square className="size-4" aria-hidden /></button>}
            <button type="submit" title="안건 보내기" aria-label="안건 보내기" disabled={!ready || submitting || Boolean(room.requestId) || !draft.trim()}
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#a0edcd] text-[#1b1e2a] hover:bg-[#c0f6e0] disabled:opacity-35"><ArrowUp className="size-5" aria-hidden /></button>
          </div>
        </form>
      </section>
      <aside aria-label="참가자" className="order-1 shrink-0 border-b border-[#3b4054] bg-[#1b1e2a] px-3 py-2 md:order-2 md:w-[196px] md:overflow-y-auto md:border-b-0 md:border-l md:px-4 md:py-5">
        <h2 className="hidden items-center gap-2 text-sm font-semibold md:flex"><UsersRound className="size-4 text-[#a0edcd]" aria-hidden /> 참가자</h2>
        <ul className="flex gap-2 overflow-x-auto md:mt-4 md:flex-col md:gap-3">
          {MONITOR_CHARACTERS.map(id => {
            const active = speaking.has(id);
            const connected = room.seq >= 0 && room.connected.includes(id);
            return <li key={id} className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 md:gap-2",
              active && "bg-[#273c3c]", room.seq >= 0 && !connected && "opacity-55")}>
              <Portrait id={id} active={active} />
              <div><div className="text-xs font-semibold">{NAME[id]}</div><div className={cn("hidden text-[11px] md:block", active ? "text-[#a0edcd]" : "text-[#bcc1d6]")}>
                {active ? "작성 중…" : room.seq < 0 ? "연결 확인 중" : connected ? "참여 가능" : "연결 필요"}</div></div>
            </li>;
          })}
        </ul>
      </aside>
    </div>
  </div>;
}

function Portrait({ id, active }: { id: MonitorCharacterId; active: boolean }) {
  return <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl border bg-[#1f222f]", active ? "border-[#a0edcd]" : "border-[#3b4054]")}>
    <AgentAvatar kind={id} size={32} alt="" expression={active ? "speaking" : "neutral"}
      className={cn("rounded-lg object-contain", active && "motion-safe:animate-[boardroom-speaking_.48s_ease-in-out_infinite_alternate]")} />
  </span>;
}

function Post({ post, streaming }: { post: MeetingMessage; streaming: boolean }) {
  return <article className={cn("flex min-w-0 items-start gap-3 rounded-xl px-3 py-2 sm:px-4",
    streaming || post.kind === "summary" ? "bg-[#273b3b]" : post.kind === "assignment" && "bg-[#1f222f]")}>
    {post.sender === "user" || post.sender === "system"
      ? <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-[#3b4054] bg-[#1f222f] text-sm text-[#bcc1d6]">{post.sender === "user" ? "나" : "✦"}</span>
      : <Portrait id={post.sender} active={streaming} />}
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("text-sm font-semibold", TONE[post.sender])}>{NAME[post.sender]}</span>
        <time className="text-[11px] text-[#bcc1d6]" dateTime={new Date(post.at).toISOString()}>{CLOCK.format(post.at)}</time>
        {post.kind && <span className="text-[11px] text-[#a0edcd]">{ROLE[post.kind]}</span>}
      </div>
      {streaming ? <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{post.text}<span aria-hidden className="ml-0.5 text-[#a0edcd]">▏</span></div>
        : <RichText text={post.text} />}
    </div>
  </article>;
}

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
  return <span className="my-2 inline-flex max-w-full flex-col items-start gap-2 rounded-xl border border-[#505876] bg-[#1f222f] p-2">
    {uri && show && !failed && <img className="max-h-80 max-w-full rounded-lg object-contain" src={uri} alt={alt}
      referrerPolicy="no-referrer" decoding="async" onError={() => setFailed(true)} />}
    {uri && (!show || failed) && <button type="button" onClick={() => { setShow(true); setFailed(false); }}
      className="flex items-center gap-1.5 rounded-md border border-[#505876] px-2 py-1 text-xs text-[#f4f1fc] hover:bg-[#303447]">
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

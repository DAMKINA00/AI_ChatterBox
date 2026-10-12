import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentKind, CliInfo, Session, Workspace } from "../../shared/types";
import { apply, fromHistory, type Item } from "./timeline";

const api = window.chatterbox;
const AGENTS: { agent: AgentKind; label: string }[] = [
  { agent: "claude", label: "Claude" },
  { agent: "codex", label: "Codex" },
];

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [cli, setCli] = useState<CliInfo[]>([]);

  useEffect(() => {
    void api.cliInfo().then(setCli);
    void api.listWorkspaces().then((ws) => {
      setWorkspaces(ws);
      if (ws[0]) setWorkspaceId(ws[0].id);
    });
  }, []);

  useEffect(() => {
    setSessionId(null);
    if (workspaceId == null) return setSessions([]);
    void api.listSessions(workspaceId).then(setSessions);
  }, [workspaceId]);

  useEffect(() => {
    const off = api.onSessionUpdated((s) =>
      setSessions((prev) => (prev.some((x) => x.id === s.id) ? prev.map((x) => (x.id === s.id ? s : x)) : prev)),
    );
    return () => off();
  }, []);

  const pickWorkspace = async () => {
    const ws = await api.pickWorkspace();
    if (!ws) return;
    setWorkspaces((prev) => (prev.some((w) => w.id === ws.id) ? prev : [ws, ...prev]));
    setWorkspaceId(ws.id);
  };

  const newSession = async (agent: AgentKind) => {
    if (workspaceId == null) return;
    const s = await api.createSession(workspaceId, agent);
    setSessions((prev) => [s, ...prev]);
    setSessionId(s.id);
  };

  const current = sessions.find((s) => s.id === sessionId) ?? null;
  const workspace = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="ws">
          <select
            aria-label="워크스페이스"
            value={workspaceId ?? ""}
            onChange={(e) => setWorkspaceId(e.target.value ? Number(e.target.value) : null)}
          >
            {workspaces.length === 0 && <option value="">워크스페이스 없음</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button onClick={pickWorkspace} title="폴더를 워크스페이스로 추가">
            폴더 열기
          </button>
          {workspace && <div className="ws-path" title={workspace.path}>{workspace.path}</div>}
        </div>
        {AGENTS.map(({ agent, label }) => {
          const info = cli.find((c) => c.agent === agent);
          return (
            <section key={agent} className={`group ${agent}`}>
              <header>
                <span>{label}</span>
                <button
                  className="new"
                  disabled={workspaceId == null || !info?.path}
                  onClick={() => newSession(agent)}
                  title={info?.path ?? info?.error}
                  aria-label={`새 ${label} 세션`}
                >
                  + 새 세션
                </button>
              </header>
              {info && !info.path && <div className="cli-missing">{info.error}</div>}
              <ul>
                {sessions
                  .filter((s) => s.agent === agent)
                  .map((s) => (
                    <li key={s.id}>
                      <button className={s.id === sessionId ? "active" : ""} onClick={() => setSessionId(s.id)}>
                        <span className={`dot ${s.status}`} />
                        <span className="title">{s.title}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          );
        })}
      </aside>
      <main>
        {current ? (
          <ChatPanel key={current.id} session={current} />
        ) : (
          <div className="empty">
            {workspaceId == null ? "왼쪽에서 폴더를 열어 워크스페이스를 추가하세요." : "세션을 선택하거나 새 세션을 만드세요."}
          </div>
        )}
      </main>
    </div>
  );
}

function ChatPanel({ session }: { session: Session }) {
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const running = session.status === "running";
  const endRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    let live: Parameters<typeof apply>[1][] = [];
    let loaded = false;
    const off = api.onEvent((sid, ev) => {
      if (sid !== session.id) return;
      if (!loaded) live.push(ev);
      else setItems((prev) => apply(prev, ev));
    });
    void api.loadEvents(session.id).then((stored) => {
      // Live events that arrived during the load are either already stored or transient deltas.
      const ids = new Set(stored.map((s) => JSON.stringify(s.event)));
      const base = fromHistory(stored.map((s) => s.event), runningRef.current);
      setItems(live.filter((e) => !ids.has(JSON.stringify(e))).reduce(apply, base));
      loaded = true;
      live = [];
    });
    return () => off();
  }, [session.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    await api.send(session.id, text);
  }, [draft, running, session.id]);

  return (
    <div className="chat">
      <header className="chat-head">
        <span className={`badge ${session.agent}`}>{session.agent === "claude" ? "Claude" : "Codex"}</span>
        <span className="chat-title">{session.title}</span>
        <span className="chat-cwd" title={session.nativeId ?? ""}>
          {session.cwd}
        </span>
      </header>
      <div className="timeline" data-testid="timeline">
        {items.length === 0 && <div className="hint">메시지를 입력해 대화를 시작하세요.</div>}
        {items.map((it) => (
          <ItemView key={it.key} item={it} sessionId={session.id} />
        ))}
        {running && <div className="working">응답 중…</div>}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <textarea
          aria-label="메시지 입력"
          value={draft}
          placeholder={running ? "응답이 끝나면 입력할 수 있습니다" : "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running ? (
          <button className="stop" onClick={() => api.stop(session.id)}>
            중지
          </button>
        ) : (
          <button className="send" onClick={() => void send()} disabled={!draft.trim()}>
            보내기
          </button>
        )}
      </div>
    </div>
  );
}

function ItemView({ item, sessionId }: { item: Item; sessionId: number }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return <div className={`msg assistant${item.streaming ? " streaming" : ""}`}>{item.text}</div>;
    case "tool": {
      const state = !item.result ? "running" : item.result.ok ? "ok" : "fail";
      return (
        <details className={`tool ${state}`}>
          <summary>
            <span className="tool-name">{item.name}</span>
            <span className="tool-brief">{firstLine(item.input)}</span>
            <span className="tool-state">{state === "running" ? "실행 중" : state === "ok" ? "완료" : "실패"}</span>
          </summary>
          <pre>{item.input}</pre>
          {item.result && <pre className="out">{item.result.output || "(출력 없음)"}</pre>}
        </details>
      );
    }
    case "file":
      return (
        <div className={`file ${item.ok ? "ok" : "fail"}`}>
          <span>파일 변경</span>
          <pre>{item.summary}</pre>
        </div>
      );
    case "approval":
      return <ApprovalCard item={item} sessionId={sessionId} />;
    case "notice":
      return <div className={`notice ${item.tone}`}>{item.text}</div>;
  }
}

function ApprovalCard({ item, sessionId }: { item: Extract<Item, { kind: "approval" }>; sessionId: number }) {
  const { request, decision, expired } = item;
  const status = useMemo(
    () => (decision === "allow" ? "허용함" : decision === "deny" ? "거부함" : expired ? "만료됨" : null),
    [decision, expired],
  );
  return (
    <div className={`approval${status ? " done" : ""}`} data-testid="approval">
      <div className="approval-head">
        <span>승인 요청 · {request.title}</span>
        {status && <span className="approval-status">{status}</span>}
      </div>
      {request.reason && <div className="approval-reason">{request.reason}</div>}
      <pre>{request.detail}</pre>
      {!status && (
        <div className="approval-actions">
          <button className="allow" onClick={() => api.answerApproval(sessionId, request.id, "allow")}>
            허용
          </button>
          <button className="deny" onClick={() => api.answerApproval(sessionId, request.id, "deny")}>
            거부
          </button>
        </div>
      )}
    </div>
  );
}

function firstLine(s: string) {
  const line = s.split("\n").find((l) => l.trim() && l.trim() !== "{") ?? "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

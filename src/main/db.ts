// SQLite storage via Electron's built-in node:sqlite (no native module to rebuild).
// Only the app's own index + normalized events live here; the CLIs keep their original transcripts.
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import type { AgentEvent, AgentKind, Session, SessionStatus, StoredEvent, Workspace } from "../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex')),
  native_id TEXT,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_ws ON sessions(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, any>;

const toWorkspace = (r: Row): Workspace => ({ id: r.id, path: r.path, name: r.name, createdAt: r.created_at });
const toSession = (r: Row): Session => ({
  id: r.id,
  workspaceId: r.workspace_id,
  agent: r.agent,
  nativeId: r.native_id,
  title: r.title,
  cwd: r.cwd,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // A crash or kill can leave sessions marked running.
    this.db.exec("UPDATE sessions SET status = 'idle' WHERE status = 'running'");
  }

  close() {
    this.db.close();
  }

  listWorkspaces(): Workspace[] {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all().map(toWorkspace);
  }

  addWorkspace(path: string): Workspace {
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path);
    if (existing) return toWorkspace(existing);
    const r = this.db
      .prepare("INSERT INTO workspaces (path, name, created_at) VALUES (?, ?, ?)")
      .run(path, basename(path) || path, Date.now());
    return this.workspace(Number(r.lastInsertRowid))!;
  }

  workspace(id: number): Workspace | undefined {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return r ? toWorkspace(r) : undefined;
  }

  listSessions(workspaceId: number): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId)
      .map(toSession);
  }

  session(id: number): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? toSession(r) : undefined;
  }

  createSession(workspaceId: number, agent: AgentKind, cwd: string, title: string): Session {
    const now = Date.now();
    const r = this.db
      .prepare("INSERT INTO sessions (workspace_id, agent, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(workspaceId, agent, title, cwd, now, now);
    return this.session(Number(r.lastInsertRowid))!;
  }

  updateSession(id: number, patch: { nativeId?: string; title?: string; status?: SessionStatus }): Session {
    const s = this.session(id)!;
    this.db
      .prepare("UPDATE sessions SET native_id = ?, title = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(patch.nativeId ?? s.nativeId, patch.title ?? s.title, patch.status ?? s.status, Date.now(), id);
    return this.session(id)!;
  }

  addEvent(sessionId: number, event: AgentEvent): void {
    this.db
      .prepare("INSERT INTO events (session_id, at, type, data) VALUES (?, ?, ?, ?)")
      .run(sessionId, Date.now(), event.type, JSON.stringify(event));
  }

  events(sessionId: number): StoredEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r: Row) => ({ id: r.id, sessionId: r.session_id, at: r.at, event: JSON.parse(r.data) }));
  }

  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

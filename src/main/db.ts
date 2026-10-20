// SQLite storage via Electron's built-in node:sqlite (no native module to rebuild).
// Only the app's own index + normalized events live here; the CLIs keep their original transcripts.
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  MAX_CONSULTS,
  MAX_REVIEWS,
  WORKER_KIND_LABEL,
  type WorkerKind,
  type AgentEvent,
  type AttachmentRef,
  type ChatAgent,
  type GeminiWebAccountId,
  type Role,
  type Chat,
  type ChatStatus,
  type Consult,
  type ConsultKind,
  type ConsultStatus,
  type NodeId,
  type Project,
  type ProjectSettings,
  type TimelineEvent,
} from "../shared/types";

// v1 tables (workspaces, sessions, events) are left alone; V3 migrates them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  orch_claude_session_id TEXT,
  orch_codex_thread_id TEXT,
  claude_session_id TEXT,
  codex_thread_id TEXT,
  claude_model_override TEXT,
  codex_model_override TEXT,
  orchestrator_effort_override TEXT,
  claude_effort_override TEXT,
  codex_effort_override TEXT,
  gemini_effort_override TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  unread INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_project ON chats(project_id, last_active_at DESC);
CREATE TABLE IF NOT EXISTS consults (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  request TEXT NOT NULL,
  requested_effort TEXT,
  effort TEXT,
  response_summary TEXT,
  files_changed_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS consults_chat ON consults(chat_id, seq);
CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  node TEXT NOT NULL,
  role TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_events_chat ON chat_events(chat_id, id);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_id INTEGER,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  action_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  decision TEXT NOT NULL,
  scope TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('claude','gpt','gemini','grok','deepseek')),
  number INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  job TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_chat ON agents(chat_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, any>;

/** v1 normalized events → v2 events (v1 approvals can no longer be answered). */
function convertV1Event(e: any): AgentEvent | null {
  switch (e?.type) {
    case "user":
      return { type: "user", text: String(e.text ?? ""), attachments: [] };
    case "text":
      return { type: "text", text: String(e.text ?? "") };
    case "tool_call":
      return { type: "tool_call", id: String(e.id), name: String(e.name), input: String(e.input ?? "") };
    case "tool_result":
      return { type: "tool_result", id: String(e.id), ok: !!e.ok, output: String(e.output ?? "") };
    case "file_change":
      return { type: "notice", text: `파일 변경: ${String(e.summary ?? "")}` };
    case "approval_request":
      return {
        type: "approval_request",
        request: { id: String(e.request?.id), role: "orch", title: String(e.request?.title ?? ""), detail: String(e.request?.detail ?? ""), risk: "low" },
      };
    case "approval_resolved":
      return { type: "approval_resolved", id: String(e.id), decision: e.decision === "allow" ? "once" : "deny" };
    case "turn_end":
      return { type: "turn_end", ok: !!e.ok, error: e.error, interrupted: e.interrupted };
    case "error":
      return { type: "error", message: String(e.message ?? ""), kind: e.kind };
    default:
      return null;
  }
}

export type ChatPatch = Partial<
  Pick<
    Chat,
    | "title"
    | "orchClaudeSessionId"
    | "orchCodexThreadId"
    | "claudeSessionId"
    | "codexThreadId"
    | "claudeModelOverride"
    | "codexModelOverride"
    | "geminiModelOverride"
    | "grokModelOverride"
    | "deepseekModelOverride"
    | "orchestratorEffortOverride"
    | "claudeEffortOverride"
    | "codexEffortOverride"
    | "geminiEffortOverride"
    | "grokEffortOverride"
    | "deepseekEffortOverride"
    | "approvalModeOverride"
    | "orchestratorModelOverride"
    | "goal"
    | "status"
    | "unread"
    | "archived"
  > & { touch: boolean }
>;

function projectSettings(json: string): ProjectSettings {
  const saved = JSON.parse(json);
  // Task duration is unlimited, including projects created with a saved time cap.
  delete saved.maxMinutes;
  // Update earlier defaults while preserving user-written preferences.
  const previous = {
    claudeStrengths: ["소스 구조·동작 흐름 분석, 원인 조사. 구현·테스트·문서 작성은 맥락에 따라 배정.", "일반 업무의 기본 담당. 소스 분석·원인 조사·구현·테스트·문서 작성과 모션그래픽·애니메이션 제작을 우선 배정합니다."],
    claudeCautions: ["이미지 생성은 이미지 도구를 사용할 수 있는 지피티에게 맡깁니다. 성능 우열은 작업마다 다를 수 있습니다."],
    gptStrengths: ["이미지 생성·편집, 시각 자료 제작. 구현·테스트·문서 작성은 맥락에 따라 배정."],
    gptCautions: ["이미지 생성 도구의 실제 사용 가능 여부를 확인합니다. 소스 분석은 기본적으로 클로드를 우선 고려합니다.", "일반 분석·구현·테스트·문서와 모션그래픽은 클로드 우선입니다. 이미지 도구가 필요하거나 교차검증의 필요성이 크거나 클로드가 실행 불가·과부하일 때 배정합니다."],
    geminiStrengths: ["사용자 지정 제미나이 작업, 문서 요약·자료 비교와 추가 관점의 검토. 클로드가 바쁘거나 사용 한도에 도달했을 때 보조 담당.", "웹·CLI 모두 글쓰기 전담. 문장 다듬기, 캐릭터 대사·시나리오, 문서 본문 작성·요약·번역을 우선 배정합니다."],
    geminiCautions: ["Google AI Pro 계정에서 실제 제공되는 Gemini 모델만 사용합니다. Ultra 전용 모델·API 결제로 전환하지 않습니다. 일반 업무는 클로드 우선, 이미지 생성은 지피티, 중요한 오류는 기존 클로드·지피티 양쪽 조사 규칙을 유지합니다.", "코드 분석·구현·디버깅·테스트·기술 리뷰·교차검증은 맡기지 않습니다. 검증된 사실과 캐릭터 말투를 유지하고 텍스트만 반환합니다. 실제 파일 반영은 클로드·지피티가 수행합니다. Google AI Pro 계정에서 제공되는 모델만 사용합니다."],
  };
  for (const [key, values] of Object.entries(previous)) if (values.includes(saved[key])) delete saved[key];
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  const bounded = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
  settings.maxConsults = bounded(settings.maxConsults, 1, MAX_CONSULTS, DEFAULT_SETTINGS.maxConsults);
  settings.maxReviews = bounded(settings.maxReviews, 0, MAX_REVIEWS, DEFAULT_SETTINGS.maxReviews);
  return settings;
}

const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  folder: r.folder,
  settings: projectSettings(r.settings_json),
  createdAt: r.created_at,
  archived: !!r.archived,
});
const toChat = (r: Row): Chat => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  orchClaudeSessionId: r.orch_claude_session_id,
  orchCodexThreadId: r.orch_codex_thread_id,
  claudeSessionId: r.claude_session_id,
  codexThreadId: r.codex_thread_id,
  claudeModelOverride: r.claude_model_override,
  codexModelOverride: r.codex_model_override,
  geminiModelOverride: r.gemini_model_override ?? null,
  grokModelOverride: r.grok_model_override ?? null,
  deepseekModelOverride: r.deepseek_model_override ?? null,
  orchestratorEffortOverride: r.orchestrator_effort_override ?? null,
  claudeEffortOverride: r.claude_effort_override ?? null,
  codexEffortOverride: r.codex_effort_override ?? null,
  geminiEffortOverride: r.gemini_effort_override ?? null,
  grokEffortOverride: r.grok_effort_override ?? null,
  deepseekEffortOverride: r.deepseek_effort_override ?? null,
  approvalModeOverride: r.approval_mode_override ?? null,
  orchestratorModelOverride: r.orchestrator_model_override ?? null,
  goal: r.goal_json ? JSON.parse(r.goal_json) : null,
  status: r.status,
  unread: !!r.unread,
  archived: !!r.archived,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
});
const toConsult = (r: Row): Consult => ({
  requestedEffort: r.requested_effort ?? undefined,
  effort: r.effort ?? undefined,
  supersedes: r.supersedes ?? undefined,
  instructionId: r.instruction_id ?? undefined,
  reason: r.reason ?? undefined,
  id: r.id,
  chatId: r.chat_id,
  seq: r.seq,
  fromRole: r.from_role,
  toRole: r.to_role,
  scope: r.scope_json ? JSON.parse(r.scope_json) : [],
  kind: r.kind,
  request: r.request,
  responseSummary: r.response_summary,
  filesChanged: JSON.parse(r.files_changed_json),
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});
const toAgent = (r: Row): ChatAgent => ({
  id: r.id,
  chatId: r.chat_id,
  key: `w${r.id}` as Role,
  kind: r.kind,
  number: r.number,
  nickname: r.nickname,
  job: r.job,
  sessionId: r.session_id,
  webAccountId: r.web_account_id ?? undefined,
  status: r.status,
  createdAt: r.created_at,
});
const toAttachment = (r: Row): AttachmentRef => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, path: r.path });

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrateGeminiAgents();
    this.addColumns();
    this.db.exec("UPDATE chats SET status = 'paused' WHERE status = 'pausing'");
    // The app was quit or crashed mid-run: those chats can be resumed ("이어서 진행").
    this.db.exec("UPDATE chats SET status = 'interrupted' WHERE status IN ('working','approval')");
    this.db.exec("UPDATE consults SET status = 'stopped', ended_at = COALESCE(ended_at, started_at) WHERE status = 'running'");
    this.migrateV1();
    this.migrateAgents();
    // Rename only generated defaults; keep custom names, IDs and conversation history.
    const rename = this.db.prepare("UPDATE agents SET nickname = ? || ' ' || number || '호' WHERE kind = ? AND nickname = ? || ' ' || number || '호'");
    for (const [kind, old] of [["claude", "Claude"], ["gpt", "Codex"], ["gpt", "짚피티"], ["gemini", "Antigravity"], ["gemini", "Gemini"], ["grok", "Grok"]] as const) {
      rename.run(WORKER_KIND_LABEL[kind], kind, old);
    }
    this.migrateAllocationLimits();
  }

  private migrateAllocationLimits() {
    if (this.getSetting("migratedAllocationLimits")) return;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE projects SET settings_json = json_set(settings_json, '$.maxConsults', ?, '$.maxReviews', ?) WHERE json_extract(settings_json, '$.maxConsults') = 8 AND json_extract(settings_json, '$.maxReviews') = 3")
        .run(DEFAULT_SETTINGS.maxConsults, DEFAULT_SETTINGS.maxReviews);
      this.setSetting("migratedAllocationLimits", "1");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * 0.3: fixed "claude" / "gpt" worker roles become pooled workers. Existing chats get 클로드 1호 /
   * 지피티 1호 carrying the old session/thread ids, and their events/consults move to the new keys.
   */
  private migrateAgents() {
    if (this.getSetting("migratedAgents")) return;
    this.db.exec("BEGIN");
    try {
      for (const c of this.db.prepare("SELECT * FROM chats").all() as Row[]) {
        for (const [old, kind, session] of [
          ["claude", "claude", c.claude_session_id],
          ["gpt", "gpt", c.codex_thread_id],
        ] as const) {
          const used =
            session ||
            this.db.prepare("SELECT 1 FROM chat_events WHERE chat_id = ? AND (role = ? OR node = ?) LIMIT 1").get(c.id, old, old) ||
            this.db.prepare("SELECT 1 FROM consults WHERE chat_id = ? AND (to_role = ? OR from_role = ?) LIMIT 1").get(c.id, old, old);
          if (!used) continue;
          const r = this.db
            .prepare("INSERT INTO agents (chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (?, ?, 1, ?, '', ?, 'active', ?)")
            .run(c.id, kind, `${kind === "claude" ? "클로드" : "지피티"} 1호`, session ?? null, c.created_at);
          const key = `w${Number(r.lastInsertRowid)}`;
          this.db.prepare("UPDATE chat_events SET role = ? WHERE chat_id = ? AND role = ?").run(key, c.id, old);
          this.db.prepare("UPDATE chat_events SET node = ? WHERE chat_id = ? AND node = ?").run(key, c.id, old);
          this.db.prepare("UPDATE consults SET to_role = ? WHERE chat_id = ? AND to_role = ?").run(key, c.id, old);
          this.db.prepare("UPDATE consults SET from_role = ? WHERE chat_id = ? AND from_role = ?").run(key, c.id, old);
          // Approval and consult payloads name the role too.
          for (const e of this.db.prepare("SELECT id, payload_json FROM chat_events WHERE chat_id = ? AND type IN ('approval_request','approval_auto','consult_start')").all(c.id) as Row[]) {
            const ev = JSON.parse(e.payload_json);
            let changed = false;
            if (ev.request?.role === old) (ev.request.role = key), (changed = true);
            if (ev.to === old) (ev.to = key), (changed = true);
            if (ev.from === old) (ev.from = key), (changed = true);
            if (changed) this.db.prepare("UPDATE chat_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(ev), e.id);
          }
        }
      }
      this.db.exec("COMMIT");
      this.setSetting("migratedAgents", "1");
    } catch (e) {
      this.db.exec("ROLLBACK");
      console.error("agent migration failed", e);
    }
  }

  // ---- agents (pooled workers)
  private migrateGeminiAgents() {
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as Row;
    if (schema.sql.includes("'deepseek'")) return;
    const hasWebAccount = (this.db.prepare("PRAGMA table_info(agents)").all() as Row[]).some(c => c.name === "web_account_id");
    // SQLite cannot extend a CHECK constraint. Preserve every identity and session atomically.
    this.db.exec("BEGIN");
    try {
      this.db.exec(`CREATE TABLE agents_next (
        id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('claude','gpt','gemini','grok','deepseek')), number INTEGER NOT NULL,
        nickname TEXT NOT NULL, job TEXT NOT NULL DEFAULT '', session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, web_account_id TEXT);
        INSERT INTO agents_next SELECT id, chat_id, kind, number, nickname, job, session_id, status, created_at, ${hasWebAccount ? "web_account_id" : "NULL"} FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_next RENAME TO agents;
        CREATE INDEX agents_chat ON agents(chat_id, id); COMMIT;`);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listAgents(chatId: number): ChatAgent[] {
    return this.db.prepare("SELECT * FROM agents WHERE chat_id = ? ORDER BY id").all(chatId).map(toAgent);
  }
  agent(id: number): ChatAgent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return r ? toAgent(r) : undefined;
  }
  agentByKey(chatId: number, key: string): ChatAgent | undefined {
    const m = /^w(\d+)$/.exec(key);
    const a = m ? this.agent(Number(m[1])) : undefined;
    return a && a.chatId === chatId ? a : undefined;
  }
  createAgent(chatId: number, kind: WorkerKind, job: string): ChatAgent {
    // Reactivate the same identity/session so previous conversations keep their owner.
    const reusable = this.db.prepare("SELECT id FROM agents WHERE chat_id = ? AND kind = ? AND status = 'released' ORDER BY number, id LIMIT 1").get(chatId, kind) as Row | undefined;
    if (reusable) {
      this.updateAgent(reusable.id, { status: "active", job });
      return this.agent(reusable.id)!;
    }
    const n = ((this.db.prepare("SELECT MAX(number) m FROM agents WHERE chat_id = ? AND kind = ?").get(chatId, kind) as Row).m ?? 0) + 1;
    const r = this.db
      .prepare("INSERT INTO agents (chat_id, kind, number, nickname, job, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
      .run(chatId, kind, n, `${WORKER_KIND_LABEL[kind]} ${n}호`, job, Date.now());
    return this.agent(Number(r.lastInsertRowid))!;
  }
  updateAgent(id: number, patch: { sessionId?: string; status?: "active" | "released"; job?: string; webAccountId?: GeminiWebAccountId }) {
    const a = this.agent(id)!;
    this.db
      .prepare("UPDATE agents SET session_id = ?, status = ?, job = ?, web_account_id = ? WHERE id = ?")
      .run(patch.sessionId ?? a.sessionId, patch.status ?? a.status, patch.job ?? a.job, patch.webAccountId ?? a.webAccountId ?? null, id);
    return this.agent(id)!;
  }

  /** Columns added after 0.2.0 (CREATE TABLE IF NOT EXISTS doesn't add them to existing DBs). */
  private addColumns() {
    const add = (table: string, column: string, ddl: string) => {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    add("agents", "web_account_id", "web_account_id TEXT");
    add("chats", "approval_mode_override", "approval_mode_override TEXT");
    add("chats", "orchestrator_model_override", "orchestrator_model_override TEXT");
    add("chats", "goal_json", "goal_json TEXT");
    add("chats", "gemini_model_override", "gemini_model_override TEXT");
    add("chats", "grok_model_override", "grok_model_override TEXT");
    add("chats", "deepseek_model_override", "deepseek_model_override TEXT");
    add("chats", "orchestrator_effort_override", "orchestrator_effort_override TEXT");
    add("chats", "claude_effort_override", "claude_effort_override TEXT");
    add("chats", "codex_effort_override", "codex_effort_override TEXT");
    add("chats", "gemini_effort_override", "gemini_effort_override TEXT");
    add("chats", "grok_effort_override", "grok_effort_override TEXT");
    add("chats", "deepseek_effort_override", "deepseek_effort_override TEXT");
    add("consults", "scope_json", "scope_json TEXT");
    add("consults", "instruction_id", "instruction_id INTEGER");
    add("consults", "reason", "reason TEXT");
    add("consults", "supersedes", "supersedes INTEGER");
    add("consults", "requested_effort", "requested_effort TEXT");
    add("consults", "effort", "effort TEXT");
    add("approvals", "decided_by", "decided_by TEXT NOT NULL DEFAULT 'user'");
    add("approvals", "reason", "reason TEXT");
  }

  /**
   * v0.1 (M1) kept workspaces → sessions (one CLI each) → events. Each v1 workspace becomes a
   * "가져온 세션" project per CLI (the orchestrator CLI must match to resume), each session a chat
   * whose orchestrator conversation is the old CLI session.
   */
  private migrateV1() {
    if (this.getSetting("migratedV1")) return;
    const has = (t: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has("workspaces") || !has("sessions")) {
      this.setSetting("migratedV1", "none");
      return;
    }
    const workspaces = this.db.prepare("SELECT * FROM workspaces").all() as Row[];
    let moved = 0;
    this.db.exec("BEGIN");
    try {
      for (const ws of workspaces) {
        const sessions = this.db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at").all(ws.id) as Row[];
        const projects: Partial<Record<"claude" | "codex", number>> = {};
        for (const s of sessions) {
          const agent = s.agent === "codex" ? "codex" : "claude";
          if (!projects[agent]) {
            const settings = { ...DEFAULT_SETTINGS, orchestratorModel: agent === "codex" ? "codex:gpt-6-astra" : "claude:opus" } as ProjectSettings;
            projects[agent] = this.createProject(`가져온 세션 · ${ws.name} (${agent === "codex" ? "Codex" : "Claude"})`, ws.path, settings).id;
          }
          const r = this.db
            .prepare(
              "INSERT INTO chats (project_id, title, orch_claude_session_id, orch_codex_thread_id, status, created_at, last_active_at) VALUES (?, ?, ?, ?, 'idle', ?, ?)",
            )
            .run(projects[agent]!, s.title, agent === "claude" ? s.native_id : null, agent === "codex" ? s.native_id : null, s.created_at, s.updated_at);
          const chatId = Number(r.lastInsertRowid);
          if (has("events")) {
            for (const e of this.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id").all(s.id) as Row[]) {
              const ev = convertV1Event(JSON.parse(e.data));
              if (ev) this.db.prepare("INSERT INTO chat_events (chat_id, node, role, ts, type, payload_json) VALUES (?, 'orch', ?, ?, ?, ?)").run(chatId, ev.type === "user" ? null : "orch", e.at, ev.type, JSON.stringify(ev));
            }
          }
          moved++;
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      console.error("v1 migration failed", e);
      return;
    }
    this.setSetting("migratedV1", String(moved));
  }

  /** Chat ids whose messages contain the text (search box). */
  searchChats(q: string): number[] {
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    return (
      this.db
        .prepare("SELECT DISTINCT chat_id FROM chat_events WHERE type IN ('user','text','consult_start') AND payload_json LIKE ? ESCAPE '\\' LIMIT 500")
        .all(like) as Row[]
    ).map((r) => r.chat_id);
  }

  close() {
    this.db.close();
  }

  // ---- projects
  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(toProject);
  }
  project(id: number): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? toProject(r) : undefined;
  }
  createProject(name: string, folder: string, settings: ProjectSettings): Project {
    const r = this.db
      .prepare("INSERT INTO projects (name, folder, settings_json, created_at) VALUES (?, ?, ?, ?)")
      .run(name, folder, JSON.stringify(settings), Date.now());
    return this.project(Number(r.lastInsertRowid))!;
  }
  updateProject(id: number, patch: { name?: string; folder?: string; settings?: ProjectSettings; archived?: boolean }): Project {
    const p = this.project(id)!;
    this.db
      .prepare("UPDATE projects SET name = ?, folder = ?, settings_json = ?, archived = ? WHERE id = ?")
      .run(
        patch.name ?? p.name,
        patch.folder ?? p.folder,
        JSON.stringify(patch.settings ?? p.settings),
        (patch.archived ?? p.archived) ? 1 : 0,
        id,
      );
    return this.project(id)!;
  }
  deleteProject(id: number) {
    const chats = this.db.prepare("SELECT id FROM chats WHERE project_id = ?").all(id) as { id: number }[];
    for (const chat of chats) this.clearChatSettings(chat.id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ---- chats
  listChats(): Chat[] {
    return this.db.prepare("SELECT * FROM chats ORDER BY last_active_at DESC").all().map(toChat);
  }
  chat(id: number): Chat | undefined {
    const r = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
    return r ? toChat(r) : undefined;
  }
  createChat(projectId: number, title: string): Chat {
    const now = Date.now();
    const r = this.db
      .prepare("INSERT INTO chats (project_id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)")
      .run(projectId, title, now, now);
    return this.chat(Number(r.lastInsertRowid))!;
  }
  updateChat(id: number, patch: ChatPatch): Chat {
    const c = this.chat(id)!;
    // undefined = keep (node:sqlite rejects undefined bindings); null = clear (e.g. model overrides).
    const pick = <K extends keyof Chat>(k: K) => ((patch as any)[k] === undefined ? c[k] : (patch as any)[k]);
    this.db
      .prepare(
        `UPDATE chats SET title = ?, orch_claude_session_id = ?, orch_codex_thread_id = ?, claude_session_id = ?, codex_thread_id = ?,
         claude_model_override = ?, codex_model_override = ?, gemini_model_override = ?, grok_model_override = ?, deepseek_model_override = ?, orchestrator_effort_override = ?, claude_effort_override = ?, codex_effort_override = ?, gemini_effort_override = ?, grok_effort_override = ?, deepseek_effort_override = ?, approval_mode_override = ?, orchestrator_model_override = ?, goal_json = ?, status = ?, unread = ?, archived = ?, last_active_at = ? WHERE id = ?`,
      )
      .run(
        pick("title"),
        pick("orchClaudeSessionId"),
        pick("orchCodexThreadId"),
        pick("claudeSessionId"),
        pick("codexThreadId"),
        pick("claudeModelOverride"),
        pick("codexModelOverride"),
        pick("geminiModelOverride"),
        pick("grokModelOverride"),
        pick("deepseekModelOverride"),
        pick("orchestratorEffortOverride"),
        pick("claudeEffortOverride"),
        pick("codexEffortOverride"),
        pick("geminiEffortOverride"),
        pick("grokEffortOverride"),
        pick("deepseekEffortOverride"),
        pick("approvalModeOverride"),
        pick("orchestratorModelOverride"),
        (() => {
          const g = pick("goal");
          return g ? JSON.stringify(g) : null;
        })(),
        patch.status ?? c.status,
        (patch.unread ?? c.unread) ? 1 : 0,
        (patch.archived ?? c.archived) ? 1 : 0,
        patch.touch ? Date.now() : c.lastActiveAt,
        id,
      );
    return this.chat(id)!;
  }
  deleteChat(id: number) {
    this.clearChatSettings(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  private clearChatSettings(id: number) {
    for (const prefix of ["orchSession", "teamMessages", "gemini-web-context", "aistudio-context", "deepseek-context"])
      this.db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`${prefix}:${id}:%`);
  }

  // ---- consults
  listConsults(chatId: number): Consult[] {
    return this.db.prepare("SELECT * FROM consults WHERE chat_id = ? ORDER BY seq").all(chatId).map(toConsult);
  }
  consult(id: number): Consult | undefined {
    const r = this.db.prepare("SELECT * FROM consults WHERE id = ?").get(id);
    return r ? toConsult(r) : undefined;
  }
  createConsult(
    chatId: number,
    from: Role,
    to: Role,
    kind: ConsultKind,
    request: string,
    scope: string[] = [],
    instructionId?: number,
    reason?: string,
    supersedes?: number,
    reasoning?: { requestedEffort?: string; effort?: string },
  ): Consult {
    const seq = ((this.db.prepare("SELECT MAX(seq) m FROM consults WHERE chat_id = ?").get(chatId) as Row).m ?? 0) + 1;
    const r = this.db
      .prepare("INSERT INTO consults (chat_id, seq, from_role, to_role, kind, request, requested_effort, effort, status, started_at, scope_json, instruction_id, reason, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
      .run(
        chatId,
        seq,
        from,
        to,
        kind,
        request,
        reasoning?.requestedEffort ?? null,
        reasoning?.effort ?? null,
        Date.now(),
        JSON.stringify(scope),
        instructionId ?? null,
        reason ?? null,
        supersedes ?? null,
      );
    return this.consult(Number(r.lastInsertRowid))!;
  }
  finishConsult(id: number, status: ConsultStatus, summary: string, files: string[]): Consult {
    this.db
      .prepare("UPDATE consults SET status = ?, response_summary = ?, files_changed_json = ?, ended_at = ? WHERE id = ?")
      .run(status, summary, JSON.stringify(files), Date.now(), id);
    return this.consult(id)!;
  }

  // ---- events
  addEvent(chatId: number, node: NodeId, role: Role | null, event: AgentEvent): TimelineEvent {
    const at = Date.now();
    const r = this.db
      .prepare("INSERT INTO chat_events (chat_id, node, role, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatId, node, role, at, event.type, JSON.stringify(event));
    return { id: Number(r.lastInsertRowid), chatId, node, role, at, event };
  }
  events(chatId: number): TimelineEvent[] {
    return this.db
      .prepare("SELECT * FROM chat_events WHERE chat_id = ? ORDER BY id")
      .all(chatId)
      .map((r: Row) => ({ id: r.id, chatId: r.chat_id, node: r.node, role: r.role, at: r.ts, event: JSON.parse(r.payload_json) }));
  }
  hasUserEvent(chatId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_events WHERE chat_id = ? AND type = 'user' LIMIT 1").get(chatId);
  }

  // ---- attachments
  addAttachment(chatId: number, name: string, path: string, mime: string, size: number): AttachmentRef {
    const r = this.db.prepare("INSERT INTO attachments (chat_id, name, path, mime, size) VALUES (?, ?, ?, ?, ?)").run(chatId, name, path, mime, size);
    return this.attachment(Number(r.lastInsertRowid))!;
  }
  attachment(id: number): AttachmentRef | undefined {
    const r = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return r ? toAttachment(r) : undefined;
  }
  attachmentsFor(ids: number[]): AttachmentRef[] {
    return ids.map((id) => this.attachment(id)).filter((a): a is AttachmentRef => !!a);
  }
  linkAttachments(ids: number[], eventId: number) {
    for (const id of ids) this.db.prepare("UPDATE attachments SET event_id = ? WHERE id = ?").run(eventId, id);
  }
  deleteAttachment(id: number) {
    this.db.prepare("DELETE FROM attachments WHERE id = ? AND event_id IS NULL").run(id);
  }

  // ---- approvals log
  logApproval(chatId: number, agent: Role, action: unknown, risk: string, decision: string, scope: string, decidedBy = "user", reason?: string) {
    this.db
      .prepare("INSERT INTO approvals (chat_id, agent, action_json, risk, decision, scope, ts, decided_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, agent, JSON.stringify(action), risk, decision, scope, Date.now(), decidedBy, reason ?? null);
  }

  // ---- settings
  getSetting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

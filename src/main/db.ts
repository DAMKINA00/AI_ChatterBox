// SQLite storage via Electron's built-in node:sqlite (no native module to rebuild).
// Only the app's own index + normalized events live here; the CLIs keep their original transcripts.
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  normalizeGeminiModel,
  normalizeOrchestratorModel,
  MAX_CONSULTS,
  MAX_REVIEWS,
  WORKER_KIND_LABEL,
  isCliAccountId,
  type CliAccountId,
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
  type ReviewResult,
  type TimelineEvent,
} from "../shared/types";
import { CONTEXT_EVENT_TYPES, EVENT_MAX_CHARS, EVENT_PAGE_LIMITS, eventChars, minimalContextEvent, pageEvent, QUIET_EVENT_TYPES, reduceContext, REMOTE_TEXT_FIELDS, REMOTE_TEXT_MAX_BYTES, SNAPSHOT_LIMITS, type EventPage, type PendingApproval, type RemoteEventText } from "../shared/event-page";

/** Largest original one request returns (characters; at most two bytes each in the 128MB core frame). */
export const FULL_EVENT_MAX_CHARS = 16_000_000;

/** Part of a page's character budget kept for the start events of consults open where it begins. */
const ANCHOR_RESERVE = 8 * EVENT_MAX_CHARS;

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
-- History pages look up context/anchor events by type without reading tool output.
CREATE INDEX IF NOT EXISTS chat_events_chat_type ON chat_events(chat_id, type, id);
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

/** What an assignment was started with, for recovery. Kept out of Consult: it holds local paths. */
export interface ConsultAssignment {
  model?: string;
  accountId?: string;
  webAccountId?: string;
  attach: string[];
  discussion?: { topic: string; peers: string[] };
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
  if (settings.approvalMode === "orchestrator" && settings.delegateHighRisk) settings.approvalMode = "orchestrator-all";
  settings.geminiModel = normalizeGeminiModel(settings.geminiModel);
  settings.orchestratorModel = normalizeOrchestratorModel(settings.orchestratorModel);
  settings.delegateHighRisk = settings.approvalMode === "orchestrator-all";
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
  geminiModelOverride: r.gemini_model_override == null ? null : normalizeGeminiModel(r.gemini_model_override),
  grokModelOverride: r.grok_model_override ?? null,
  deepseekModelOverride: r.deepseek_model_override ?? null,
  orchestratorEffortOverride: r.orchestrator_effort_override ?? null,
  claudeEffortOverride: r.claude_effort_override ?? null,
  codexEffortOverride: r.codex_effort_override ?? null,
  geminiEffortOverride: r.gemini_effort_override ?? null,
  grokEffortOverride: r.grok_effort_override ?? null,
  deepseekEffortOverride: r.deepseek_effort_override ?? null,
  approvalModeOverride: r.approval_mode_override ?? null,
  orchestratorModelOverride: r.orchestrator_model_override == null ? null : normalizeOrchestratorModel(r.orchestrator_model_override),
  goal: r.goal_json ? JSON.parse(r.goal_json) : null,
  status: r.status,
  unread: !!r.unread,
  archived: !!r.archived,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
  ...(r.fork_json ? { fork: JSON.parse(r.fork_json) } : {}),
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
  ...(r.review_json ? { review: JSON.parse(r.review_json) } : {}),
  ...(r.interrupted_by ? { interruptedBy: r.interrupted_by } : {}),
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
  ...(isCliAccountId(r.cli_account_id) ? { cliAccountId: r.cli_account_id } : {}),
  ...(isCliAccountId(r.session_account_id) ? { sessionAccountId: r.session_account_id } : {}),
  ...(isCliAccountId(r.session_account_id) && Number.isFinite(r.session_account_gen) ? { sessionAccountGeneration: r.session_account_gen } : {}),
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
    this.db.exec("UPDATE consults SET status = 'stopped', ended_at = COALESCE(ended_at, started_at), interrupted_by = 'app_exit' WHERE status = 'running'");
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
  /**
   * `cliAccountId: null` returns the worker to the project/global policy; releasing a worker also
   * drops its assignment. A new `sessionAccountId` replaces the session generation with the given one.
   */
  updateAgent(id: number, patch: { sessionId?: string; status?: "active" | "released"; job?: string; webAccountId?: GeminiWebAccountId; cliAccountId?: CliAccountId | null; sessionAccountId?: CliAccountId; sessionAccountGeneration?: number }) {
    const a = this.agent(id)!;
    const cliAccountId = patch.cliAccountId === null || patch.status === "released" ? null : patch.cliAccountId ?? a.cliAccountId ?? null;
    const generation = patch.sessionAccountId !== undefined ? patch.sessionAccountGeneration ?? null : patch.sessionAccountGeneration ?? a.sessionAccountGeneration ?? null;
    this.db
      .prepare("UPDATE agents SET session_id = ?, status = ?, job = ?, web_account_id = ?, cli_account_id = ?, session_account_id = ?, session_account_gen = ? WHERE id = ?")
      .run(patch.sessionId ?? a.sessionId, patch.status ?? a.status, patch.job ?? a.job, patch.webAccountId ?? a.webAccountId ?? null,
        cliAccountId, patch.sessionAccountId ?? a.sessionAccountId ?? null, generation, id);
    return this.agent(id)!;
  }

  /** Columns added after 0.2.0 (CREATE TABLE IF NOT EXISTS doesn't add them to existing DBs). */
  private addColumns() {
    const add = (table: string, column: string, ddl: string) => {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    add("agents", "web_account_id", "web_account_id TEXT");
    add("agents", "cli_account_id", "cli_account_id TEXT");
    add("agents", "session_account_id", "session_account_id TEXT");
    add("agents", "session_account_gen", "session_account_gen INTEGER");
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
    add("consults", "review_json", "review_json TEXT");
    add("consults", "assignment_json", "assignment_json TEXT");
    add("consults", "interrupted_by", "interrupted_by TEXT");
    add("chats", "fork_json", "fork_json TEXT");
    add("approvals", "decided_by", "decided_by TEXT NOT NULL DEFAULT 'user'");
    add("approvals", "reason", "reason TEXT");
    add("attachments", "uuid", "uuid TEXT"); // remote uploads only; NULL for desktop attachments
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
        .prepare("SELECT DISTINCT chat_id FROM chat_events WHERE type IN ('user','text','consult_start','fork_context') AND payload_json LIKE ? ESCAPE '\\' LIMIT 500")
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
  /**
   * A new idle chat carrying the source's chat settings and a read-only conversation snapshot. Sessions,
   * workers, goal and approval grants stay behind. All one savepoint: `context` runs synchronously inside
   * it, so a failure leaves no chat, and no other write can interleave.
   */
  createForkChat(source: Chat, title: string, fork: NonNullable<Chat["fork"]>, context: (chatId: number) => Extract<AgentEvent, { type: "fork_context" }>): Chat {
    this.db.exec("SAVEPOINT fork_chat");
    try {
      const now = Date.now();
      const r = this.db
        .prepare(
          `INSERT INTO chats (project_id, title, claude_model_override, codex_model_override, gemini_model_override, grok_model_override, deepseek_model_override,
           orchestrator_effort_override, claude_effort_override, codex_effort_override, gemini_effort_override, grok_effort_override, deepseek_effort_override,
           approval_mode_override, orchestrator_model_override, fork_json, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.projectId, title, source.claudeModelOverride, source.codexModelOverride, source.geminiModelOverride, source.grokModelOverride, source.deepseekModelOverride,
          source.orchestratorEffortOverride, source.claudeEffortOverride, source.codexEffortOverride, source.geminiEffortOverride, source.grokEffortOverride, source.deepseekEffortOverride,
          source.approvalModeOverride, source.orchestratorModelOverride, JSON.stringify(fork), now, now,
        );
      const chatId = Number(r.lastInsertRowid);
      const event = context(chatId);
      const stored = this.addEvent(chatId, "orch", null, event);
      this.linkAttachments(event.attachments.map(a => a.id), stored.id);
      this.db.exec("RELEASE fork_chat");
      return this.chat(chatId)!;
    } catch (error) {
      this.db.exec("ROLLBACK TO fork_chat; RELEASE fork_chat");
      throw error;
    }
  }
  deleteChat(id: number) {
    this.clearChatSettings(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }
  /**
   * A removed CLI account: assigned workers return to the policy, and every session it owned
   * (workers and masters) is marked generation -1 so a re-created account with the same ID never
   * resumes it — the next run starts fresh with a handoff summary.
   */
  clearCliAccount(accountId: CliAccountId) {
    if (!isCliAccountId(accountId)) throw new Error("등록되지 않은 CLI 계정입니다.");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE agents SET cli_account_id = NULL WHERE cli_account_id = ?").run(accountId);
      this.db.prepare("UPDATE agents SET session_account_gen = -1 WHERE session_account_id = ?").run(accountId);
      this.db.prepare("UPDATE settings SET value = ? WHERE key LIKE 'orchSessionAccount:%' AND (value = ? OR value LIKE ?)").run(`${accountId}@-1`, accountId, `${accountId}@%`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  disconnectWebAccount(accountId: GeminiWebAccountId) {
    if (!/^gemini-([1-9]|10)$/.test(accountId)) throw new Error("등록되지 않은 웹 계정입니다.");
    const prefix = `web:${accountId}:/app/%`;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE agents SET
        session_id = CASE WHEN session_id LIKE ? THEN NULL ELSE session_id END,
        web_account_id = CASE WHEN web_account_id = ? THEN NULL ELSE web_account_id END
        WHERE kind = 'gemini' AND (session_id LIKE ? OR web_account_id = ?)`).run(prefix, accountId, prefix, accountId);
      this.db.prepare("DELETE FROM settings WHERE key LIKE 'orchSession:%:gemini' AND value LIKE ?").run(prefix);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private clearChatSettings(id: number) {
    for (const prefix of ["orchSession", "teamMessages", "gemini-web-context", "aistudio-context", "deepseek-context", "runInstruction"])
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
    assignment?: ConsultAssignment,
  ): Consult {
    const seq = ((this.db.prepare("SELECT MAX(seq) m FROM consults WHERE chat_id = ?").get(chatId) as Row).m ?? 0) + 1;
    const r = this.db
      .prepare("INSERT INTO consults (chat_id, seq, from_role, to_role, kind, request, requested_effort, effort, status, started_at, scope_json, instruction_id, reason, supersedes, assignment_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)")
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
        assignment ? JSON.stringify(assignment) : null,
      );
    return this.consult(Number(r.lastInsertRowid))!;
  }
  finishConsult(id: number, status: ConsultStatus, summary: string, files: string[]): Consult {
    this.db
      .prepare("UPDATE consults SET status = ?, response_summary = ?, files_changed_json = ?, ended_at = ? WHERE id = ?")
      .run(status, summary, JSON.stringify(files), Date.now(), id);
    return this.consult(id)!;
  }

  consultAssignment(id: number): ConsultAssignment | undefined {
    const r = this.db.prepare("SELECT assignment_json FROM consults WHERE id = ?").get(id) as Row | undefined;
    return r?.assignment_json ? JSON.parse(r.assignment_json) : undefined;
  }
  /** Accepted only while the assignment runs; null once it has ended. */
  setConsultReview(id: number, review: ReviewResult): Consult | null {
    const { changes } = this.db.prepare("UPDATE consults SET review_json = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(review), id);
    return changes ? this.consult(id)! : null;
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
  /**
   * One page of history, newest first in selection and id order in the result (see shared/event-page.ts).
   * `before` = load events older than this id; omitted = the newest page, which also carries the context.
   * Sizes are measured on the events as sent (after shortening), so a page never exceeds its budget.
   */
  eventsPage(chatId: number, before?: number): EventPage {
    const upper = before ?? Number.MAX_SAFE_INTEGER;
    const toEvent = (r: Row): TimelineEvent => pageEvent({ id: r.id, chatId: r.chat_id, node: r.node, role: r.role, at: r.ts, event: JSON.parse(r.payload_json) });
    const events: TimelineEvent[] = [];
    let visible = 0;
    let chars = 0;
    // iterate() stops reading as soon as a limit is reached; the anchor reserve keeps room for open consults.
    const budget = EVENT_PAGE_LIMITS.chars - ANCHOR_RESERVE;
    for (const r of this.db.prepare("SELECT * FROM chat_events WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?").iterate(chatId, upper, EVENT_PAGE_LIMITS.events) as Iterable<Row>) {
      const e = toEvent(r);
      const size = eventChars(e);
      if (events.length && chars + size > budget) break;
      events.push(e);
      chars += size;
      if (!QUIET_EVENT_TYPES.has(r.type as string)) visible++;
      if (visible >= EVENT_PAGE_LIMITS.visible) break;
    }
    events.reverse();
    if (!events.length) return { events: [], start: upper, hasMore: false, ...(before === undefined ? { context: [] } : {}) };
    const start = events[0].id;
    const hasMore = !!this.db.prepare("SELECT 1 FROM chat_events WHERE chat_id = ? AND id < ? LIMIT 1").get(chatId, start);
    // Consults still open where the page begins: their start event gives the page's worker events a card.
    const pageConsults = new Set(events.flatMap(e => (e.node.startsWith("consult:") ? [Number(e.node.slice(8))] : [])));
    const anchors: TimelineEvent[] = [];
    if (hasMore && pageConsults.size) {
      const ended = new Set((this.db.prepare("SELECT json_extract(payload_json, '$.consultId') AS consult FROM chat_events WHERE chat_id = ? AND type = 'consult_end' AND id < ?").all(chatId, start) as Row[]).map(r => r.consult));
      let reserve = ANCHOR_RESERVE;
      for (const r of this.db.prepare("SELECT * FROM chat_events WHERE chat_id = ? AND type = 'consult_start' AND id < ? AND json_extract(payload_json, '$.consultId') IN (SELECT value FROM json_each(?)) ORDER BY id DESC").all(chatId, start, JSON.stringify([...pageConsults])) as Row[]) {
        const e = toEvent(r);
        if (e.event.type !== "consult_start" || ended.has(e.event.consultId)) continue;
        // Newest open consults first; the reserve bounds how many anchors one page carries.
        if ((reserve -= eventChars(e)) < 0) break;
        anchors.unshift(e);
      }
    }
    const page: EventPage = { events: [...anchors, ...events], start, hasMore };
    if (before === undefined) {
      if (hasMore) Object.assign(page, reduceContext(this.contextEvents(chatId, start)));
      else page.context = [];
    }
    return page;
  }
  /**
   * CONTEXT_EVENT_TYPES events older than `before`, in minimal form, read row by row. Large fields are cut
   * in SQLite (a user message's text start, an approval without detail and diffs), so long instructions
   * and big approvals are never parsed whole here.
   */
  private contextEvents(chatId: number, before: number): TimelineEvent[] {
    const types = CONTEXT_EVENT_TYPES.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, chat_id, node, role, ts, type,
        CASE type
          WHEN 'user' THEN json_object('type', 'user', 'text', substr(json_extract(payload_json, '$.text'), 1, 301), 'attachments', json('[]'),
            'queued', json_extract(payload_json, '$.queued'), 'delivery', json_extract(payload_json, '$.delivery'))
          WHEN 'approval_request' THEN json_remove(payload_json, '$.request.detail', '$.request.diffs')
          ELSE payload_json END AS payload
      FROM chat_events WHERE chat_id = ? AND id < ? AND type IN (${types}) ORDER BY id`);
    const out: TimelineEvent[] = [];
    for (const r of rows.iterate(chatId, before, ...CONTEXT_EVENT_TYPES) as Iterable<Row>) {
      const event = JSON.parse(r.payload) as AgentEvent;
      if (event.type === "user") {
        // json_object stores booleans as 0/1 and absent fields as null.
        const raw = event as unknown as { queued: unknown; delivery: unknown };
        event.queued = raw.queued === 1 || raw.queued === true ? true : undefined;
        event.delivery = raw.delivery === "now" || raw.delivery === "next" ? raw.delivery : undefined;
        if (!event.queued) delete event.queued;
        if (!event.delivery) delete event.delivery;
      }
      if (event.type === "approval_request") event.request.detail ??= "";
      const minimal = minimalContextEvent({ id: r.id, chatId: r.chat_id, node: r.node, role: r.role, at: r.ts, event });
      if (minimal) out.push(minimal);
    }
    return out;
  }
  /**
   * Unanswered approval requests older than `before`, newest first, `limit` from `offset` (the snapshot
   * carries only the newest few), with the total. Read in SQLite without request details.
   */
  pendingApprovals(chatId: number, before: number, offset = 0, limit = SNAPSHOT_LIMITS.approvals): { items: PendingApproval[]; total: number } {
    const where = `FROM chat_events WHERE chat_id = ? AND id < ? AND type = 'approval_request'
      AND json_extract(payload_json, '$.request.id') NOT IN (
        SELECT json_extract(payload_json, '$.id') FROM chat_events WHERE chat_id = ? AND id < ? AND type = 'approval_resolved' AND json_extract(payload_json, '$.id') IS NOT NULL)`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${where}`).get(chatId, before, chatId, before) as Row).n);
    const rows = this.db.prepare(`SELECT id, ts, json_extract(payload_json, '$.request.id') AS rid, json_extract(payload_json, '$.request.role') AS role,
        substr(json_extract(payload_json, '$.request.title'), 1, 300) AS title, json_extract(payload_json, '$.request.risk') AS risk ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?`).all(chatId, before, chatId, before, Math.min(Math.max(1, limit), 200), Math.max(0, offset)) as Row[];
    return { items: rows.map(r => ({ eventId: r.id, at: r.ts, id: String(r.rid), role: r.role, title: r.title ?? "", risk: r.risk === "high" ? "high" : "low" })), total };
  }
  /**
   * The original text of one text-message event for remote web (REMOTE_TEXT_FIELDS); other types, and
   * texts over REMOTE_TEXT_MAX_BYTES, are refused without reading the text. No other field is returned.
   */
  eventText(chatId: number, eventId: number): RemoteEventText {
    const head = this.db.prepare("SELECT type FROM chat_events WHERE chat_id = ? AND id = ?").get(chatId, eventId) as Row | undefined;
    if (!head) return { ok: false, reason: "missing" };
    const type = head.type as keyof typeof REMOTE_TEXT_FIELDS;
    const field = REMOTE_TEXT_FIELDS[type];
    if (!field) return { ok: false, reason: "type" };
    const size = this.db.prepare(`SELECT length(json_extract(payload_json, '$.${field}')) AS chars, length(CAST(json_extract(payload_json, '$.${field}') AS BLOB)) AS bytes FROM chat_events WHERE id = ?`).get(eventId) as Row;
    if (Number(size.bytes ?? 0) > REMOTE_TEXT_MAX_BYTES) return { ok: false, reason: "size", length: Number(size.chars ?? 0) };
    const text = (this.db.prepare(`SELECT json_extract(payload_json, '$.${field}') AS t FROM chat_events WHERE id = ?`).get(eventId) as Row).t;
    return { ok: true, id: eventId, type, text: typeof text === "string" ? text : "" };
  }
  /** One event with its full payload (a history page may have shortened it). */
  event(chatId: number, eventId: number): TimelineEvent | undefined {
    // Checked before reading: an original this large would not fit one core frame (128MB) with room to spare.
    const size = this.db.prepare("SELECT length(payload_json) AS n FROM chat_events WHERE chat_id = ? AND id = ?").get(chatId, eventId) as Row | undefined;
    if (size && Number(size.n) > FULL_EVENT_MAX_CHARS)
      throw new Error(`원문이 너무 커서(${(Number(size.n) / 1_000_000).toFixed(1)}백만 자) 앱에서 한 번에 불러올 수 없습니다. 화면에는 줄인 내용만 표시합니다.`);
    const r = this.db.prepare("SELECT * FROM chat_events WHERE chat_id = ? AND id = ?").get(chatId, eventId) as Row | undefined;
    return r ? { id: r.id, chatId: r.chat_id, node: r.node, role: r.role, at: r.ts, event: JSON.parse(r.payload_json) } : undefined;
  }
  /**
   * Events after `afterId` in the minimal form run statistics need (tool text and other payloads are not
   * kept). The core aggregates them; they never cross the RPC as a whole.
   */
  statsEventsAfter(chatId: number, afterId = 0): TimelineEvent[] {
    // Only the fields the statistics use are extracted in SQLite; no payload is parsed whole in JS.
    const rows = this.db.prepare(`SELECT id, chat_id, node, role, ts, type,
        CASE WHEN type IN ('tool_call','tool_result','approval_resolved') THEN json_extract(payload_json, '$.id') END AS pid,
        CASE WHEN type = 'tool_call' THEN json_extract(payload_json, '$.name') END AS name,
        CASE WHEN type IN ('tool_result','turn_end') THEN json_extract(payload_json, '$.ok') END AS ok,
        CASE WHEN type = 'turn_end' THEN json_extract(payload_json, '$.interrupted') END AS interrupted,
        CASE WHEN type = 'user' THEN json_extract(payload_json, '$.queued') END AS queued,
        CASE WHEN type IN ('approval_request','approval_auto') THEN json_extract(payload_json, '$.request.id') END AS rid,
        CASE WHEN type IN ('approval_request','approval_auto') THEN json_extract(payload_json, '$.request.role') END AS rrole,
        CASE WHEN type = 'approval_resolved' THEN json_extract(payload_json, '$.decision') END AS decision
      FROM chat_events WHERE chat_id = ? AND id > ? ORDER BY id`).all(chatId, afterId) as Row[];
    const flag = (v: unknown) => v === 1 || v === true;
    return rows.map(r => {
      let event: AgentEvent;
      switch (r.type) {
        case "tool_call": event = { type: "tool_call", id: String(r.pid ?? ""), name: String(r.name ?? ""), input: "" }; break;
        case "tool_result": event = { type: "tool_result", id: String(r.pid ?? ""), ok: flag(r.ok), output: "" }; break;
        case "approval_request": event = { type: "approval_request", request: { id: String(r.rid ?? ""), role: r.rrole, title: "", detail: "", risk: "low" } }; break;
        case "approval_auto": event = { type: "notice", text: "" }; break;
        case "approval_resolved": event = { type: "approval_resolved", id: String(r.pid ?? ""), decision: r.decision }; break;
        case "turn_end": event = { type: "turn_end", ok: flag(r.ok), ...(flag(r.interrupted) ? { interrupted: true } : {}) }; break;
        case "user": event = { type: "user", text: "", attachments: [], ...(flag(r.queued) ? { queued: true } : {}) }; break;
        case "text": case "text_delta": event = { type: r.type, text: "" }; break;
        default: event = { type: "notice", text: "" };
      }
      return { id: r.id, chatId: r.chat_id, node: r.node, role: r.role, at: r.ts, event };
    });
  }
  /** Whether an attachment appears in this chat's history (the event types that carry attachments). */
  chatHasAttachment(chatId: number, attachmentId: number): boolean {
    const rows = this.db.prepare("SELECT payload_json FROM chat_events WHERE chat_id = ? AND type IN ('user','consult_start','fork_context','image_generation') AND instr(payload_json, ?) > 0")
      .all(chatId, `"id":${attachmentId},`) as Row[];
    return rows.some(r => {
      const ev = JSON.parse(r.payload_json) as AgentEvent;
      const refs = ev.type === "image_generation" ? (ev.attachment ? [ev.attachment] : []) : "attachments" in ev ? ev.attachments : [];
      return refs.some(a => a.id === attachmentId);
    });
  }
  hasUserEvent(chatId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM chat_events WHERE chat_id = ? AND type = 'user' LIMIT 1").get(chatId);
  }

  // ---- attachments
  /** `uuid`: set once for a remote upload (its file name); unlike the id it is never reused. */
  addAttachment(chatId: number, name: string, path: string, mime: string, size: number, uuid: string | null = null): AttachmentRef {
    const r = this.db.prepare("INSERT INTO attachments (chat_id, name, path, mime, size, uuid) VALUES (?, ?, ?, ?, ?, ?)").run(chatId, name, path, mime, size, uuid);
    return this.attachment(Number(r.lastInsertRowid))!;
  }
  attachment(id: number): AttachmentRef | undefined {
    const r = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return r ? toAttachment(r) : undefined;
  }
  /** The record only if it belongs to this chat. */
  chatAttachment(chatId: number, id: number): AttachmentRef | undefined {
    const r = this.db.prepare("SELECT * FROM attachments WHERE id = ? AND chat_id = ?").get(id, chatId);
    return r ? toAttachment(r) : undefined;
  }
  attachmentsFor(ids: number[]): AttachmentRef[] {
    return ids.map((id) => this.attachment(id)).filter((a): a is AttachmentRef => !!a);
  }
  /**
   * A user message and the link of its attachments in one transaction (a savepoint, so it also nests):
   * a crash or error in between leaves neither, so the record never shows attachments that stay unsent.
   */
  addUserEvent(chatId: number, event: AgentEvent, attachmentIds: number[]): TimelineEvent {
    this.db.exec("SAVEPOINT user_event");
    try {
      const ev = this.addEvent(chatId, "orch", null, event);
      this.linkAttachments(attachmentIds, ev.id);
      this.db.exec("RELEASE user_event");
      return ev;
    } catch (error) {
      this.db.exec("ROLLBACK TO user_event; RELEASE user_event");
      throw error;
    }
  }
  linkAttachments(ids: number[], eventId: number) {
    for (const id of ids) this.db.prepare("UPDATE attachments SET event_id = ? WHERE id = ?").run(eventId, id);
  }
  deleteAttachment(id: number) {
    this.db.prepare("DELETE FROM attachments WHERE id = ? AND event_id IS NULL").run(id);
  }
  /** Attachment records not yet sent with a message (remote uploads are among them, with their uuid). */
  unsentAttachments(chatId?: number): (AttachmentRef & { chatId: number; uuid: string | null })[] {
    const rows = chatId === undefined
      ? this.db.prepare("SELECT * FROM attachments WHERE event_id IS NULL").all()
      : this.db.prepare("SELECT * FROM attachments WHERE event_id IS NULL AND chat_id = ?").all(chatId);
    return rows.map((r: Row) => ({ id: r.id, chatId: r.chat_id, name: r.name, mime: r.mime, size: r.size, path: r.path, uuid: r.uuid ?? null }));
  }
  /** Bytes of all remote uploads, sent or not (every record with a uuid). */
  remoteUploadBytes(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE uuid IS NOT NULL").get() as Row).n);
  }
  /** Paths of every attachment record (sent or not, any chat): the references the remote-upload cleanup keeps. */
  attachmentPaths(chatId?: number): string[] {
    const rows = chatId === undefined
      ? this.db.prepare("SELECT path FROM attachments").all()
      : this.db.prepare("SELECT path FROM attachments WHERE chat_id = ?").all(chatId);
    return rows.map((r: Row) => r.path as string);
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

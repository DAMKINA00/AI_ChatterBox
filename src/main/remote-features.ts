// Extended remote web API (docs/remote-web-features.md, contract in src/shared/remote-web.ts).
// remote-web.ts authenticates the session and checks CSRF/Origin/Host before delegating here; every
// handler reuses the desktop core channels and strips local paths/emails from what it returns.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { DEFAULT_SETTINGS, type AgentKind, type ApprovalMode, type AttachmentRef, type Chat, type CliAccountStatus, type ModelOption, type Project, type TimelineEvent } from "../shared/types";
import type { AIStudioUsageReport } from "../shared/aistudio";
import {
  REMOTE_ATTACHMENT_TYPES, REMOTE_COMMANDS, REMOTE_EVENTS, REMOTE_FOLDER_NAME_PATTERN, REMOTE_LIMITS, REMOTE_NUMBER_SETTINGS,
  REMOTE_PROJECT_SETTING_KEYS, REMOTE_UPLOAD_BUDGET, REMOTE_UPLOAD_UUID, normalizeRemoteFileName,
  type RemoteAuditAction, type RemoteCliAccount, type RemoteProject, type RemoteProjectRoot,
  type RemoteUpload, type RemoteUploadKey,
} from "../shared/remote-web";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

export type CoreCall = (channel: string, args: unknown[]) => Promise<any>;
export interface FeatureSession { key: string; user: string; ip: string }
export interface FeatureContext {
  call: CoreCall;
  body(req: IncomingMessage, maxBytes?: number): Promise<any>;
  send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
  publish(channel: string, args: unknown[]): void;
  audit(session: FeatureSession, action: RemoteAuditAction, target: string, detail?: string): void;
  roots(): RemoteProjectRoot[];
  /** Cap on all remote uploads' disk use (desktop setting); the core checks it right before writing. */
  uploadStorageBytes(): number;
  now(): number;
}

const AGENTS: AgentKind[] = ["claude", "codex", "gemini", "grok", "deepseek"];
const MODEL_FIELDS: Record<string, AgentKind | "orch"> = {
  orchestratorModelOverride: "orch", claudeModelOverride: "claude", codexModelOverride: "codex",
  geminiModelOverride: "gemini", grokModelOverride: "grok", deepseekModelOverride: "deepseek",
};
const EFFORT_FIELDS = ["orchestratorEffortOverride", "claudeEffortOverride", "codexEffortOverride", "geminiEffortOverride", "grokEffortOverride", "deepseekEffortOverride"];
const BUSY = new Set(["working", "approval", "pausing", "paused"]);
const AUTONOMY: Record<ApprovalMode, number> = { user: 0, orchestrator: 1, "orchestrator-all": 2 };
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const UPLOAD_BODY_BYTES = Math.ceil(REMOTE_LIMITS.attachmentBytes * 4 / 3) + 64 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** Remove local `path` from attachment refs anywhere inside events (deep copy only where needed). */
export function stripLocalPaths<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripLocalPaths) as T;
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const isAttachment = typeof o.path === "string" && typeof o.mime === "string" && typeof o.id === "number";
  return Object.fromEntries(Object.entries(o).filter(([k]) => !(isAttachment && k === "path")).map(([k, v]) => [k, stripLocalPaths(v)])) as T;
}

/** File identity of a folder (volume + file index), used to pin an allowed root (D1). */
export const folderId = (path: string) => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };

/** AI Studio usage groups are keyed by account email; remote answers number them instead. */
export function anonymizeAccounts(report: AIStudioUsageReport): AIStudioUsageReport {
  if (!report?.groups?.account) return report;
  return { ...report, groups: { ...report.groups, account: report.groups.account.map((g, i) => ({ ...g, key: `계정 ${i + 1}` })) } };
}

/** Ids of attachment refs anywhere inside an event (user attachments, consult attachments, generated images). */
function attachmentIds(value: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(value)) value.forEach(v => attachmentIds(v, out));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.id === "number" && typeof o.mime === "string" && typeof o.name === "string") out.add(o.id);
    for (const v of Object.values(o)) attachmentIds(v, out);
  }
  return out;
}

const toRemoteUpload = ({ id, uuid, name, mime, size }: RemoteUpload): RemoteUpload => ({ id, uuid, name, mime, size });
const isUuid = (v: unknown): v is string => typeof v === "string" && REMOTE_UPLOAD_UUID.test(v);
type StoredUpload = RemoteUpload & { chatId: number };

export function toRemoteProject(p: Project): RemoteProject {
  const settings = Object.fromEntries(REMOTE_PROJECT_SETTING_KEYS.map(k => [k, p.settings[k]])) as RemoteProject["settings"];
  return { id: p.id, name: p.name, archived: p.archived, createdAt: p.createdAt, settings };
}

const isApprovalMode = (value: unknown): value is ApprovalMode => typeof value === "string" && Object.hasOwn(AUTONOMY, value);
const effectiveMode =(mode: ApprovalMode, delegateHighRisk = false): ApprovalMode => mode === "orchestrator" && delegateHighRisk ? "orchestrator-all" : mode;

function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new HttpError(400, `${field}을(를) 입력하세요.`);
  if (value.length > max) throw new HttpError(413, `${field}이(가) 너무 깁니다.`);
  return value;
}

/** D4: the bytes must look like the declared type (and never like a Windows executable). */
export function contentMatches(mime: string, bytes: Buffer): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x4d, 0x5a)) return false; // "MZ" PE executable
  if (mime === "image/png") return starts(0x89, 0x50, 0x4e, 0x47);
  if (mime === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mime === "image/gif") return starts(0x47, 0x49, 0x46, 0x38);
  if (mime === "image/webp") return starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (mime === "application/pdf") return starts(0x25, 0x50, 0x44, 0x46);
  if (mime === "application/zip" || mime === "application/x-zip-compressed" || mime.includes("openxmlformats")) return starts(0x50, 0x4b, 0x03, 0x04);
  if (mime === "application/msword" || mime === "application/vnd.ms-excel" || mime === "application/vnd.ms-powerpoint") return starts(0xd0, 0xcf, 0x11, 0xe0);
  // Allow-listed text types: no NUL byte anywhere. Every other type (SVG, BMP, unknown) is refused.
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return !bytes.includes(0);
  return false;
}

/** Map core "HTTP<status>:message" errors to HTTP answers. */
async function core<T>(call: CoreCall, channel: string, args: unknown[]): Promise<T> {
  try { return await call(channel, args) as T; }
  catch (error) {
    const m = /^HTTP(\d{3}):([\s\S]*)$/.exec(error instanceof Error ? error.message : String(error));
    if (m) throw new HttpError(Number(m[1]), m[2]);
    throw error;
  }
}

export class RemoteFeatures {
  /** Uploads run one after another (stored-state check + save), so parallel ones cannot pass the D4 limits together. */
  private uploadLane: Promise<unknown> = Promise.resolve();
  /** Uploads being received: reserved before the body is read, released when the request ends in any way. */
  private inFlight = { count: 0, bytes: 0, bySession: new Map<string, number>() };
  private models = new Map<AgentKind, { at: number; list: ModelOption[] }>();
  private usageRefreshed = new Map<string, number>();

  constructor(private ctx: FeatureContext) {}

  private async chat(id: number): Promise<Chat> {
    const chat = (await this.ctx.call("chats:list", []) as Chat[]).find(c => c.id === id);
    if (!chat) throw new HttpError(404, "채팅이 없습니다.");
    return chat;
  }

  private async project(id: number): Promise<Project> {
    const project = (await this.ctx.call("projects:list", []) as Project[]).find(p => p.id === id);
    if (!project) throw new HttpError(404, "프로젝트가 없습니다.");
    return project;
  }

  private async modelList(agent: AgentKind): Promise<ModelOption[]> {
    const cached = this.models.get(agent);
    if (cached && this.ctx.now() - cached.at < 60_000) return cached.list;
    const list = await this.ctx.call("models:list", [agent]) as ModelOption[];
    this.models.set(agent, { at: this.ctx.now(), list });
    return list;
  }

  private async checkModel(field: string, value: unknown) {
    if (value === null) return;
    if (typeof value !== "string" || value.length > 200) throw new HttpError(400, "모델 형식이 올바르지 않습니다.");
    let agent = MODEL_FIELDS[field];
    let id = value;
    if (agent === "orch") {
      const i = value.indexOf(":");
      agent = value.slice(0, i) as AgentKind;
      id = value.slice(i + 1);
      if (!AGENTS.includes(agent)) throw new HttpError(400, "지원하지 않는 마스터 모델입니다.");
    }
    if (!(await this.modelList(agent as AgentKind)).some(m => m.id === id)) throw new HttpError(400, "선택할 수 없는 모델입니다.");
  }

  private stream(channel: string, args: unknown[]) { this.ctx.publish(channel, args); }

  /** Returns true when the request was one of the extended routes. */
  async handle(method: string, url: URL, req: IncomingMessage, res: ServerResponse, session: FeatureSession): Promise<boolean> {
    const { call, send } = this.ctx;
    const path = url.pathname;
    const get = method === "GET", post = method === "POST";

    if (get && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (q.length > REMOTE_LIMITS.search) throw new HttpError(413, "검색어가 너무 깁니다.");
      send(res, 200, { chatIds: q.trim() ? await call("chats:search", [q.trim()]) : [] });
      return true;
    }
    if (get && path === "/api/models") {
      const agent = url.searchParams.get("agent") as AgentKind;
      if (!AGENTS.includes(agent)) throw new HttpError(400, "지원하지 않는 에이전트입니다.");
      send(res, 200, { agent, models: await this.modelList(agent) });
      return true;
    }
    if (get && path === "/api/projects") {
      const projects = await call("projects:list", []) as Project[];
      send(res, 200, { projects: projects.map(toRemoteProject), roots: this.ctx.roots().map(({ id, label }) => ({ id, label })) });
      return true;
    }
    if (post && path === "/api/projects") { await this.createProject(req, res, session); return true; }
    if (post && path === "/api/chats") {
      const { projectId } = await this.ctx.body(req);
      if (!Number.isSafeInteger(projectId)) throw new HttpError(400, "프로젝트를 선택하세요.");
      if ((await this.project(projectId)).archived) throw new HttpError(409, "보관된 프로젝트에는 채팅을 만들 수 없습니다.");
      const created = await call("chats:create", [projectId]) as Chat;
      // chats:create does not emit; an empty update announces the chat to the desktop window and the stream.
      const chat = await call("chats:update", [created.id, {}]) as Chat;
      this.ctx.audit(session, "chat.create", `채팅 ${chat.id}`, chat.title);
      send(res, 201, { chat });
      return true;
    }
    if (get && path === "/api/usage") { await this.usage(url, res, session); return true; }
    if (get && path === "/api/aistudio/usage") {
      const range = url.searchParams.get("range") ?? undefined;
      if (range !== undefined && !["24h", "7d", "30d"].includes(range)) throw new HttpError(400, "지원하지 않는 기간입니다.");
      send(res, 200, { report: anonymizeAccounts(await call("aistudio:usage", [range]) as AIStudioUsageReport) });
      return true;
    }

    let m = /^\/api\/projects\/(\d{1,12})\/update$/.exec(path);
    if (m && post) { await this.updateProject(Number(m[1]), req, res, session); return true; }

    m = /^\/api\/attachments\/(\d{1,12})(\/remove)?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      if (post && m[2]) {
        const { uuid } = await this.ctx.body(req);
        if (!isUuid(uuid)) throw new HttpError(400, "첨부를 {id, uuid}로 지정하세요.");
        // The core checks the pair (another upload under a reused id → 409), drops the unsent record and
        // collects the file (now, or on a later run if it is locked).
        const upload = (await this.uploads()).find(u => u.id === id);
        const key: RemoteUploadKey = { id, uuid };
        if (!upload || !(await core<boolean>(call, "remote:attachment-remove", [upload.chatId, key]))) throw new HttpError(404, "제거할 수 있는 첨부가 없습니다.");
        send(res, 200, { ok: true });
        return true;
      }
      if (get && !m[2]) { await this.download(id, url, res); return true; }
      throw new HttpError(405, "지원하지 않는 요청입니다.");
    }

    m = /^\/api\/chats\/(\d{1,12})\/(update|delete|viewed|pause|resume|dismiss-interrupted|command|attachments|send|fork)$/.exec(path);
    if (!m) return false;
    const id = Number(m[1]);
    const action = m[2];
    // The unsent remote uploads of a chat, as stored now: the web's attachment list follows this.
    if (get && action === "attachments") {
      await this.chat(id);
      send(res, 200, { attachments: (await this.uploads(id)).map(toRemoteUpload) });
      return true;
    }
    if (!post) throw new HttpError(405, "지원하지 않는 요청입니다.");
    if (action === "attachments") { await this.upload(id, req, res, session); return true; }
    const body = await this.ctx.body(req);
    if (action === "update") {
      await this.chat(id);
      const allowed = new Set(["title", "archived", "confirm", "approvalModeOverride", ...Object.keys(MODEL_FIELDS), ...EFFORT_FIELDS]);
      const unknown = Object.keys(body).find(k => !allowed.has(k));
      if (unknown) throw new HttpError(400, `바꿀 수 없는 항목입니다: ${unknown}`);
      const { confirm, ...patch } = body;
      if (patch.title !== undefined) patch.title = text(patch.title, "제목", REMOTE_LIMITS.title).trim();
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") throw new HttpError(400, "보관 값이 올바르지 않습니다.");
      for (const field of Object.keys(MODEL_FIELDS)) if (field in patch) await this.checkModel(field, patch[field]);
      for (const field of EFFORT_FIELDS)
        if (field in patch && patch[field] !== null && (typeof patch[field] !== "string" || !/^[a-z-]{0,20}$/.test(patch[field]))) throw new HttpError(400, "추론 수준이 올바르지 않습니다.");
      if ("approvalModeOverride" in patch && patch.approvalModeOverride !== null && !isApprovalMode(patch.approvalModeOverride))
        throw new HttpError(400, "지원하지 않는 승인 방식입니다.");
      // D3: the core compares autonomy against the chat as it is at save time and saves in the same step.
      const { chat: updated, approvalChange } = await core<{ chat: Chat; approvalChange?: string }>(call, "remote:chat-patch", [id, patch, confirm === true]);
      if (approvalChange) this.ctx.audit(session, "chat.approvalMode", `채팅 ${id}`, approvalChange);
      this.ctx.audit(session, "chat.update", `채팅 ${id}`, Object.keys(patch).join(", "));
      send(res, 200, { chat: updated });
      return true;
    }
    if (action === "delete") {
      if (typeof body.confirm !== "string") throw new HttpError(400, "삭제하려면 채팅 제목을 정확히 입력하세요.");
      // D8: the core re-checks title and idleness and deletes without letting new work start in between.
      await core(call, "remote:chat-delete", [id, body.confirm]);
      this.ctx.audit(session, "chat.delete", `채팅 ${id}`, body.confirm);
      this.stream(REMOTE_EVENTS.chatDeleted, [id]);
      send(res, 200, { ok: true });
      return true;
    }
    if (action === "fork") {
      const unknown = Object.keys(body).find(k => !["eventId", "range", "includeAttachments"].includes(k));
      if (unknown) throw new HttpError(400, `지정할 수 없는 항목입니다: ${unknown}`);
      // The core checks the chat, the message, and the attachments' size and disk space in one step.
      const chat = await core<Chat>(call, "remote:chat-fork", [id, { eventId: body.eventId, range: body.range, includeAttachments: body.includeAttachments }]);
      this.ctx.audit(session, "chat.fork", `채팅 ${id}`, `새 채팅 ${chat.id}`);
      send(res, 201, { chat });
      return true;
    }
    if (action === "send") {
      const delivery = body.delivery ?? "now";
      if (delivery !== "now" && delivery !== "next") throw new HttpError(400, "지원하지 않는 전달 방식입니다.");
      const list: unknown = body.attachments ?? [];
      if (body.attachmentIds !== undefined || !Array.isArray(list) || list.length > REMOTE_LIMITS.attachmentsPendingPerChat
        || list.some(a => !a || typeof a !== "object" || !Number.isSafeInteger(a.id) || !isUuid(a.uuid)) || new Set(list.map(a => a.id)).size !== list.length)
        throw new HttpError(400, "보낼 첨부는 {id, uuid} 목록으로 지정하세요.");
      const keys: RemoteUploadKey[] = list.map(a => ({ id: a.id, uuid: a.uuid }));
      // The core checks each {id, uuid} is an unsent remote upload of this chat whose file exists, and
      // links them in the same step (else 409: the web refreshes its list). Attachments alone may go with an empty text.
      await core(call, "remote:send", [id, text(body.text ?? "", "지시", REMOTE_LIMITS.text, keys.length > 0), keys, delivery]);
      send(res, 200, { ok: true });
      return true;
    }
    await this.chat(id);
    if (action === "command") {
      if (!(REMOTE_COMMANDS as readonly string[]).includes(body.name)) throw new HttpError(400, "지원하지 않는 명령입니다.");
      await call("chats:command", [id, body.name, text(body.arg ?? "", "명령 내용", REMOTE_LIMITS.text, true)]);
    } else {
      const channel = { viewed: "chats:viewed", pause: "chats:pause", resume: "chats:resume", "dismiss-interrupted": "chats:dismissInterrupted" }[action]!;
      await call(channel, [id]);
    }
    send(res, 200, { ok: true });
    return true;
  }

  private async createProject(req: IncomingMessage, res: ServerResponse, session: FeatureSession) {
    const { name, rootId, folderName } = await this.ctx.body(req);
    const projectName = text(name, "프로젝트 이름", REMOTE_LIMITS.title).trim();
    const root = this.ctx.roots().find(r => r.id === rootId);
    if (!root) throw new HttpError(this.ctx.roots().length ? 400 : 409, this.ctx.roots().length ? "허용된 위치를 선택하세요." : "원격 프로젝트 생성이 꺼져 있습니다. 데스크톱에서 허용 위치를 지정하세요.");
    if (typeof folderName !== "string" || !REMOTE_FOLDER_NAME_PATTERN.test(folderName) || folderName.trim() !== folderName || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(folderName))
      throw new HttpError(400, "폴더 이름은 한 단계 이름만 쓸 수 있습니다(경로 문자·예약어 불가).");
    // D1: exactly one new level under the root registered on the desktop. The root's real path and
    // file id are pinned at registration; a junction/symlink swapped in later is refused.
    // Roots saved before pinning existed carry no identity: refuse until re-registered on the desktop.
    if (!root.real || !root.fileId) throw new HttpError(409, "허용 위치를 데스크톱에서 다시 등록해야 합니다(보안 확인 정보 없음).");
    const pinned = () => {
      let real: string;
      try { real = realpathSync(root.path); } catch { throw new HttpError(409, "허용 위치 폴더를 찾을 수 없습니다."); }
      if (real !== root.real || folderId(real) !== root.fileId)
        throw new HttpError(409, "허용 위치 폴더가 등록 후 바뀌었습니다. 데스크톱에서 다시 등록하세요.");
      return real;
    };
    const rootReal = pinned();
    const target = join(rootReal, folderName);
    if (dirname(resolve(target)) !== resolve(rootReal)) throw new HttpError(400, "허용 위치 바로 아래에만 만들 수 있습니다.");
    if (existsSync(target)) throw new HttpError(409, "같은 이름의 폴더가 이미 있습니다.");
    mkdirSync(target);
    try {
      if (pinned() !== rootReal || lstatSync(target).isSymbolicLink() || realpathSync(target) !== resolve(target)) throw new HttpError(400, "링크 폴더는 쓸 수 없습니다.");
      const project = await this.ctx.call("projects:create", [{ name: projectName, folder: target, settings: DEFAULT_SETTINGS }]) as Project;
      this.ctx.audit(session, "project.create", `프로젝트 ${project.id}`, `${projectName} (${root.label}${sep}${folderName})`);
      this.stream(REMOTE_EVENTS.projectsUpdated, []);
      this.ctx.send(res, 201, { project: toRemoteProject(project) });
    } catch (error) {
      try { rmdirSync(target); } catch { /* not empty or gone: leave it */ }
      throw error;
    }
  }

  private async updateProject(id: number, req: IncomingMessage, res: ServerResponse, session: FeatureSession) {
    const body = await this.ctx.body(req);
    const unknown = Object.keys(body).find(k => !["name", "archived", "settings", "confirm"].includes(k));
    if (unknown) throw new HttpError(400, `원격에서 바꿀 수 없는 항목입니다: ${unknown}`);
    const project = await this.project(id);
    const patch: { name?: string; archived?: boolean; settings?: Record<string, unknown> } = {};
    if (body.name !== undefined) patch.name = text(body.name, "프로젝트 이름", REMOTE_LIMITS.title).trim();
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean") throw new HttpError(400, "보관 값이 올바르지 않습니다.");
      patch.archived = body.archived;
    }
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new HttpError(400, "설정 형식이 올바르지 않습니다.");
      const bad = Object.keys(body.settings).find(k => !(REMOTE_PROJECT_SETTING_KEYS as readonly string[]).includes(k));
      if (bad) throw new HttpError(400, `원격에서 바꿀 수 없는 설정입니다: ${bad}`);
      const s = body.settings as Record<string, unknown>;
      for (const [k, v] of Object.entries(s)) {
        const current = (project.settings as unknown as Record<string, unknown>)[k];
        if (typeof v !== typeof current || (typeof v === "string" && v.length > 4000)) throw new HttpError(400, `설정 값이 올바르지 않습니다: ${k}`);
        // Same ranges as the desktop project dialog (e.g. Claude/GPT workers 1~6, others 0~6).
        const range = (REMOTE_NUMBER_SETTINGS as Record<string, readonly [number, number]>)[k];
        if (typeof v === "number" && (!range || !Number.isInteger(v) || v < range[0] || v > range[1])) throw new HttpError(400, `설정 값이 허용 범위를 벗어났습니다: ${k}`);
      }
      for (const k of ["orchestratorModel", "claudeModel", "codexModel", "geminiModel", "grokModel", "deepseekModel"]) {
        if (!(k in s) || s[k] === "") continue;
        const field = k === "orchestratorModel" ? "orchestratorModelOverride" : `${k.replace("Model", "")}ModelOverride`;
        await this.checkModel(field, s[k]);
      }
      if ("approvalMode" in s && !isApprovalMode(s.approvalMode)) throw new HttpError(400, "지원하지 않는 승인 방식입니다.");
      // Only the changed keys go to the core, which merges them into the settings as they are at save time.
      patch.settings = s;
    }
    // D3/D5: merge, autonomy check and save happen in one core step (desktop changes in between are kept).
    const { project: updated, approvalChange } = await core<{ project: Project; approvalChange?: string }>(this.ctx.call, "remote:project-patch", [id, patch, body.confirm === true]);
    if (approvalChange) this.ctx.audit(session, "project.approvalMode", `프로젝트 ${id}`, approvalChange);
    this.ctx.audit(session, "project.update", `프로젝트 ${id}`, Object.keys(patch).join(", "));
    this.stream(REMOTE_EVENTS.projectsUpdated, []);
    this.ctx.send(res, 200, { project: toRemoteProject(updated) });
  }

  /**
   * Admission before the body is read, so many large uploads at once cannot exhaust memory: at most
   * REMOTE_UPLOAD_BUDGET.inFlightUploads at once (inFlightPerSession per session) and inFlightBytes of
   * bodies, reserved from Content-Length (the maximum when absent; the reader never takes more than the
   * reservation). The returned release runs once, however the request ends (error or closed connection).
   */
  private admit(req: IncomingMessage, session: FeatureSession): { maxBytes: number; release: () => void } {
    const raw = req.headers["content-length"];
    const maxBytes = raw === undefined ? UPLOAD_BODY_BYTES : /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(maxBytes)) throw new HttpError(400, "요청 길이가 올바르지 않습니다.");
    if (maxBytes > UPLOAD_BODY_BYTES) throw new HttpError(413, "파일은 10MB까지 첨부할 수 있습니다.");
    const f = this.inFlight, mine = f.bySession.get(session.key) ?? 0;
    if (f.count >= REMOTE_UPLOAD_BUDGET.inFlightUploads || mine >= REMOTE_UPLOAD_BUDGET.inFlightPerSession || f.bytes + maxBytes > REMOTE_UPLOAD_BUDGET.inFlightBytes)
      throw new HttpError(429, "지금 올리는 첨부가 많습니다. 잠시 뒤 다시 올리세요.", { "Retry-After": "5" });
    f.count++; f.bytes += maxBytes; f.bySession.set(session.key, mine + 1);
    let released = false;
    return {
      maxBytes,
      release: () => {
        if (released) return;
        released = true;
        f.count--; f.bytes -= maxBytes;
        const left = (f.bySession.get(session.key) ?? 1) - 1;
        if (left > 0) f.bySession.set(session.key, left); else f.bySession.delete(session.key);
      },
    };
  }

  /** Uploads being received now (for tests and diagnostics). */
  get uploadsInFlight() { return { count: this.inFlight.count, bytes: this.inFlight.bytes }; }

  private async upload(chatId: number, req: IncomingMessage, res: ServerResponse, session: FeatureSession) {
    const { maxBytes, release } = this.admit(req, session);
    try {
      const body = await this.ctx.body(req, maxBytes);
      // D4: Windows-normalized name, allow-listed extension, and the server's own MIME for it.
      const file = typeof body.name === "string" ? normalizeRemoteFileName(body.name) : null;
      if (!file) throw new HttpError(400, "파일 이름을 쓸 수 없습니다(경로·스트림 문자, 예약어 불가).");
      const mime = REMOTE_ATTACHMENT_TYPES[file.ext];
      if (!mime) throw new HttpError(415, "첨부할 수 없는 파일 형식입니다(이미지·텍스트·PDF·오피스·zip만).");
      if (typeof body.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new HttpError(400, "파일 데이터 형식이 올바르지 않습니다.");
      const bytes = Buffer.from(body.data, "base64");
      if (!bytes.length) throw new HttpError(400, "빈 파일은 첨부할 수 없습니다.");
      if (bytes.length > REMOTE_LIMITS.attachmentBytes) throw new HttpError(413, "파일은 10MB까지 첨부할 수 있습니다.");
      if (!contentMatches(mime, bytes)) throw new HttpError(415, "파일 내용이 형식과 맞지 않습니다.");
      // Limits come from what is stored (count/bytes of unsent remote uploads). Uploads go one at a time,
      // reading the stored state, checking and saving in turn, so parallel uploads cannot pass them together.
      const run = this.uploadLane.then(async () => {
        await this.chat(chatId);
        const held = await this.uploads();
        const chatHeld = held.filter(p => p.chatId === chatId);
        if (chatHeld.length >= REMOTE_LIMITS.attachmentsPendingPerChat) throw new HttpError(409, "보내지 않은 첨부가 너무 많습니다. 먼저 보내거나 제거하세요.");
        if (chatHeld.reduce((n, p) => n + p.size, 0) + bytes.length > REMOTE_UPLOAD_BUDGET.perChatBytes
          || held.reduce((n, p) => n + p.size, 0) + bytes.length > REMOTE_UPLOAD_BUDGET.totalBytes)
          throw new HttpError(413, "보내지 않은 첨부의 총 용량이 너무 큽니다. 먼저 보내거나 제거하세요.");
        // The core also checks all remote uploads' disk use (sent ones too) and the free disk space (507).
        return core<RemoteUpload>(this.ctx.call, "remote:att-bytes", [chatId, file.name, mime, new Uint8Array(bytes), this.ctx.uploadStorageBytes()]);
      });
      this.uploadLane = run.catch(() => undefined);
      const ref = await run;
      this.ctx.audit(session, "attachment.upload", `채팅 ${chatId}`, `${file.name} (${bytes.length} bytes)`);
      this.ctx.send(res, 201, { attachment: toRemoteUpload(ref) });
    } finally { release(); }
  }

  /** Unsent remote uploads as stored now (all chats, or one). */
  private uploads(chatId?: number) {
    return this.ctx.call("remote:uploads", chatId === undefined ? [] : [chatId]) as Promise<StoredUpload[]>;
  }

  /** Only attachments of the given chat: ones in its history, or its unsent remote uploads named by id and uuid. */
  private async download(id: number, url: URL, res: ServerResponse) {
    const raw = url.searchParams.get("chat") ?? "";
    if (!/^\d{1,12}$/.test(raw)) throw new HttpError(400, "채팅을 지정하세요.");
    const chatId = Number(raw);
    const events = await this.ctx.call("chats:events", [chatId]) as TimelineEvent[];
    if (!events.some(e => attachmentIds(e.event).has(id))) {
      const uuid = url.searchParams.get("uuid");
      if (!(await this.uploads(chatId)).some(u => u.id === id && u.uuid === uuid)) throw new HttpError(404, "첨부가 없습니다.");
    }
    const ref = await this.ctx.call("attachment:info", [id]) as AttachmentRef | undefined;
    if (!ref || !isAbsolute(ref.path) || !existsSync(ref.path)) throw new HttpError(404, "첨부 파일이 없습니다.");
    if (statSync(ref.path).size > MAX_DOWNLOAD_BYTES) throw new HttpError(413, "파일이 너무 커서 원격으로 받을 수 없습니다.");
    const inline = INLINE_IMAGES.has(ref.mime);
    res.writeHead(200, {
      "Content-Type": inline ? ref.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(readFileSync(ref.path));
  }

  private async usage(url: URL, res: ServerResponse, session: FeatureSession) {
    const refresh = url.searchParams.get("refresh") === "1";
    if (refresh) {
      const last = this.usageRefreshed.get(session.key) ?? 0;
      if (this.ctx.now() - last < REMOTE_LIMITS.usageRefreshSeconds * 1000) throw new HttpError(429, "사용량 새로고침은 1분에 한 번만 할 수 있습니다.");
      this.usageRefreshed.set(session.key, this.ctx.now());
    }
    const [usage, accounts] = await Promise.all([this.ctx.call("usage:get", [refresh]), this.ctx.call("cli-accounts:list", [])]);
    const remote: RemoteCliAccount[] = (accounts as CliAccountStatus[]).map(a => ({
      accountId: a.accountId, kind: a.kind, label: a.label, enabled: a.enabled, isDefault: a.isDefault,
      authStatus: a.authStatus, remainingPercent: a.remainingPercent, runningWorkers: a.runningWorkers,
    }));
    this.ctx.send(res, 200, { usage, accounts: remote });
  }
}

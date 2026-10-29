// Remote web access (browser → Caddy → 127.0.0.1 → this app). Shared by main, preload and renderer.
import type { AIStudioUsageRange, AIStudioUsageReport } from "./aistudio";
import type { ApprovalMode, AgentKind, Chat, CliAccountId, CliAccountKind, ModelOption, ProjectSettings, UsageInfo } from "./types";

export const REMOTE_WEB_DEFAULT_PORT = 47821;
export const REMOTE_WEB_DEFAULT_ORIGIN = "https://ai.damkina.net";
export const REMOTE_WEB_MIN_PASSWORD = 12;

/** local = the app's own password (always kept as the emergency login); synology-dsm = NAS account. */
export type RemoteAuthProvider = "local" | "synology-dsm";

export interface RemoteWebSession {
  /** Public id for listing/revoking; never the cookie value. */
  id: string;
  /** "local" or the DSM account name. */
  user: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  userAgent: string;
}

export interface RemoteWebDsmSettings {
  url: string;
  /** Pinned SHA-256 certificate fingerprint (64 hex); empty = normal CA validation. */
  certSha256: string;
  allowedUsers: string[];
}

export interface RemoteWebDsmProbe {
  fingerprint: string;
  /** Certificate passes CA validation or matches the pinned fingerprint. */
  trusted: boolean;
  authPath?: string;
  error?: string;
}

/** A failed login with its real reason; shown only in the app (the browser gets one uniform message). */
export interface RemoteWebLoginFailure {
  at: number;
  ip: string;
  provider: RemoteAuthProvider;
  user: string;
  detail: string;
}

export interface RemoteWebStatus {
  enabled: boolean;
  port: number;
  /** Browser origin allowed for state-changing requests, e.g. https://ai.damkina.net */
  publicOrigin: string;
  /** Local (emergency) password. */
  passwordSet: boolean;
  provider: RemoteAuthProvider;
  dsm: RemoteWebDsmSettings;
  /** Use X-ChatterBox-Client-IP set by the loopback reverse proxy (Caddy) as the client IP. */
  trustProxy: boolean;
  /** Max NAS-rejected logins per 5 minutes before NAS checks pause (below DSM's auto-block). */
  dsmFailureLimit: number;
  /** Most recent first. */
  loginFailures: RemoteWebLoginFailure[];
  /** Listening on 127.0.0.1:port right now. */
  running: boolean;
  error?: string;
  sessions: RemoteWebSession[];
  /** Only on the "dsm-probe" action. */
  dsmProbe?: RemoteWebDsmProbe;
  /** D1 allowed roots (filled by the server once the features API lands). */
  projectRoots?: RemoteProjectRoot[];
  /** Recent remote state changes, newest first (filled by the server once the features API lands). */
  audit?: RemoteAuditEntry[];
}

export type RemoteWebAction = "status" | "update" | "set-password" | "logout-all" | "revoke" | "dsm-probe";
export interface RemoteWebInput {
  enabled?: boolean;
  port?: number;
  publicOrigin?: string;
  password?: string;
  sessionId?: string;
  provider?: RemoteAuthProvider;
  dsmUrl?: string;
  /** "" clears the pin. */
  dsmCertSha256?: string;
  dsmAllowedUsers?: string[];
  trustProxy?: boolean;
  dsmFailureLimit?: number;
  /** D1: folders under which remote users may create project folders (desktop-only setting). */
  projectRoots?: RemoteProjectRoot[];
}

// =====================================================================================
// 원격 웹 기능 확장 API (docs/remote-web-features.md, D1~D8 승인 2026-10-29)
// 계약만 정의합니다. 서버(src/main/remote-web.ts)와 웹 UI(src/renderer/src/remote/**)가 이 정의를 따릅니다.
// 소유: 클로드 1호(서버). 웹 UI 담당은 읽기만 하고 변경이 필요하면 1호에게 요청합니다.
// 공통: 모든 경로는 세션 쿠키 필요(401). POST는 X-CSRF-Token·Origin·Sec-Fetch-Site·JSON 필수.
//       오류 본문은 RemoteApiError. 로컬 경로·이메일은 응답에 넣지 않습니다.
// =====================================================================================

/** Error body for every non-2xx JSON answer. */
export interface RemoteApiError { error: string }

/**
 * Status codes the extended API uses (in addition to 401/403/415/421 of the base rules).
 * 428 = the change raises autonomy (D3) and needs `confirm: true`.
 */
export type RemoteApiStatus = 200 | 201 | 400 | 404 | 409 | 413 | 428 | 429 | 503;

/** Paths. `:id` segments are filled with `remotePath()`. */
export const REMOTE_API = {
  // existing
  login: "/api/login",
  logout: "/api/logout",
  authInfo: "/api/auth-info",
  session: "/api/session",
  stream: "/api/stream",
  chats: "/api/chats",                              // GET list (existing) · POST create (A)
  chat: "/api/chats/:id",                           // GET snapshot (existing)
  chatSend: "/api/chats/:id/send",                  // POST (existing; extended with attachmentIds)
  chatStop: "/api/chats/:id/stop",
  chatApprove: "/api/chats/:id/approve",
  chatAnswer: "/api/chats/:id/answer",
  // A
  chatUpdate: "/api/chats/:id/update",              // POST RemoteChatPatch
  chatViewed: "/api/chats/:id/viewed",              // POST {}
  chatPause: "/api/chats/:id/pause",                // POST {}
  chatResume: "/api/chats/:id/resume",              // POST {} (pause resume and interrupted-run resume)
  chatDismissInterrupted: "/api/chats/:id/dismiss-interrupted", // POST {}
  chatCommand: "/api/chats/:id/command",            // POST RemoteCommandRequest
  search: "/api/search",                            // GET ?q=
  models: "/api/models",                            // GET ?agent=
  projects: "/api/projects",                        // GET RemoteProjectsResponse · POST RemoteProjectCreate (B, D1)
  projectUpdate: "/api/projects/:id/update",        // POST RemoteProjectPatch (A name/archived, B settings)
  // B
  chatDelete: "/api/chats/:id/delete",              // POST RemoteChatDelete (D8)
  chatAttachments: "/api/chats/:id/attachments",    // POST RemoteAttachmentUpload (D4)
  attachment: "/api/attachments/:id",               // GET file bytes
  attachmentRemove: "/api/attachments/:id/remove",  // POST {}
  usage: "/api/usage",                              // GET ?refresh=0|1 (read-only, D5)
  aiStudioUsage: "/api/aistudio/usage",             // GET ?range=
} as const;
export type RemoteApiPath = (typeof REMOTE_API)[keyof typeof REMOTE_API];

/** Fills `:id` in a REMOTE_API path. */
export const remotePath = (path: RemoteApiPath, id?: number) => (id === undefined ? path : path.replace(":id", String(id)));

/** Limits shared by server validation and UI hints. */
export const REMOTE_LIMITS = {
  title: 200,
  text: 50_000,
  search: 200,
  folderName: 64,
  /** D4 */
  attachmentBytes: 10 * 1024 * 1024,
  attachmentsPendingPerChat: 10,
  /** Usage refresh per session (seconds). */
  usageRefreshSeconds: 60,
} as const;

/** D4: accepted upload types (others → 415). Executable/script types are never accepted. */
export const REMOTE_ATTACHMENT_MIME_PREFIXES = ["image/", "text/"] as const;
export const REMOTE_ATTACHMENT_MIME_TYPES = [
  "application/pdf", "application/json", "application/zip", "application/x-zip-compressed",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;
export const REMOTE_ATTACHMENT_BLOCKED_EXTENSIONS = [".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".lnk", ".dll", ".reg", ".hta"] as const;

// ---------- chats (A / B)

/** POST /api/chats */
export interface RemoteChatCreate { projectId: number }
export interface RemoteChatResponse { chat: Chat }

/**
 * POST /api/chats/:id/update. Unknown keys → 400. Model ids must come from GET /api/models (null = project default).
 * approvalModeOverride raising autonomy (D3) needs confirm: true (else 428) and is recorded in the audit log.
 */
export interface RemoteChatPatch {
  title?: string;
  archived?: boolean;
  orchestratorModelOverride?: string | null;
  claudeModelOverride?: string | null;
  codexModelOverride?: string | null;
  geminiModelOverride?: string | null;
  grokModelOverride?: string | null;
  deepseekModelOverride?: string | null;
  orchestratorEffortOverride?: string | null;
  claudeEffortOverride?: string | null;
  codexEffortOverride?: string | null;
  geminiEffortOverride?: string | null;
  grokEffortOverride?: string | null;
  deepseekEffortOverride?: string | null;
  approvalModeOverride?: ApprovalMode | null;
  confirm?: boolean;
}

/** D8: POST /api/chats/:id/delete. confirm must equal the chat title exactly (else 400); running chats → 409. */
export interface RemoteChatDelete { confirm: string }

/** POST /api/chats/:id/command. `stop` uses the existing stop endpoint. */
export const REMOTE_COMMANDS = ["plan", "plan-run", "plan-cancel", "goal", "review", "compact"] as const;
export type RemoteCommandName = (typeof REMOTE_COMMANDS)[number];
export interface RemoteCommandRequest { name: RemoteCommandName; arg: string }

/** POST /api/chats/:id/send (existing, extended). attachmentIds: only this chat's remote uploads not yet sent. */
export interface RemoteSendRequest { text: string; delivery?: "now" | "next"; attachmentIds?: number[] }

/** GET /api/search?q= */
export interface RemoteSearchResponse { chatIds: number[] }

/** GET /api/models?agent= (cached 60 s on the server; also the allow-list for model overrides). */
export interface RemoteModelsResponse { agent: AgentKind; models: ModelOption[] }

/** Generic `{ ok: true }` answer for viewed/pause/resume/dismiss-interrupted/command/delete/remove. */
export interface RemoteOk { ok: true }

// ---------- attachments (B, D4)

/** Attachment without its local path. */
export interface RemoteAttachment { id: number; name: string; mime: string; size: number }

/** POST /api/chats/:id/attachments. `data` is base64 of at most REMOTE_LIMITS.attachmentBytes bytes. */
export interface RemoteAttachmentUpload { name: string; mime: string; data: string }
export interface RemoteAttachmentResponse { attachment: RemoteAttachment }

// ---------- projects (A / B, D1 / D2)

/** Project settings fields remote users may change (accountPolicy is desktop-only, D5). */
export const REMOTE_PROJECT_SETTING_KEYS = [
  "orchestratorModel", "claudeModel", "codexModel", "geminiModel", "grokModel", "deepseekModel",
  "orchestratorEffort", "claudeEffort", "codexEffort", "geminiEffort", "grokEffort", "deepseekEffort",
  "claudeStrengths", "claudeCautions", "gptStrengths", "gptCautions", "geminiStrengths", "geminiCautions",
  "grokStrengths", "grokCautions", "deepseekStrengths", "deepseekCautions",
  "reviewGate", "maxConsults", "maxReviews",
  "maxClaudeWorkers", "maxGptWorkers", "maxGeminiWorkers", "maxGrokWorkers", "maxDeepseekWorkers",
  "approvalMode", "delegateHighRisk",
] as const satisfies readonly (keyof ProjectSettings)[];
export type RemoteProjectSettingKey = (typeof REMOTE_PROJECT_SETTING_KEYS)[number];
export type RemoteProjectSettings = Pick<ProjectSettings, RemoteProjectSettingKey>;

/** Project without its folder path. */
export interface RemoteProject { id: number; name: string; archived: boolean; createdAt: number; settings: RemoteProjectSettings }

/** D1: an allowed root for new remote projects; the path itself stays on the desktop. */
export interface RemoteProjectRoot { id: string; label: string; path: string }
export type RemoteProjectRootRef = Omit<RemoteProjectRoot, "path">;

/** GET /api/projects. roots is empty when no allowed root is configured (create disabled). */
export interface RemoteProjectsResponse { projects: RemoteProject[]; roots: RemoteProjectRootRef[] }

/**
 * D1: POST /api/projects. The server creates `<root>/<folderName>` (existing → 409) and checks that the
 * resolved path stays under the root (symlinks/junctions refused). Settings start from DEFAULT_SETTINGS.
 */
export interface RemoteProjectCreate { name: string; rootId: string; folderName: string }
export interface RemoteProjectResponse { project: RemoteProject }
/** Allowed folder name: one segment, no reserved characters, not starting with a dot. */
export const REMOTE_FOLDER_NAME_PATTERN = /^[^\\/:*?"<>|.\x00-\x1f][^\\/:*?"<>|\x00-\x1f]{0,63}$/;

/**
 * POST /api/projects/:id/update. folder/accountPolicy keys → 400 (D2/D5: no remote delete, no account policy).
 * approvalMode/delegateHighRisk raising autonomy (D3) needs confirm: true (else 428).
 */
export interface RemoteProjectPatch { name?: string; archived?: boolean; settings?: Partial<RemoteProjectSettings>; confirm?: boolean }

// ---------- usage (B, read-only, D5)

/** CLI account summary without config dir or email. */
export interface RemoteCliAccount {
  accountId: CliAccountId;
  kind: CliAccountKind;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  authStatus: "authenticated" | "required" | "unknown";
  remainingPercent?: number;
  runningWorkers: number;
}
/** GET /api/usage?refresh=0|1 (refresh at most once per REMOTE_LIMITS.usageRefreshSeconds per session → 429). */
export interface RemoteUsageResponse { usage: UsageInfo; accounts: RemoteCliAccount[] }
/** GET /api/aistudio/usage?range= */
export interface RemoteAIStudioUsageQuery { range?: AIStudioUsageRange }
export interface RemoteAIStudioUsageResponse { report: AIStudioUsageReport }

// ---------- SSE events

/**
 * Stream event names. Existing: chat:event, chat:updated, agents:updated, consult:updated (core events).
 * New (published by the remote server itself): projects:updated (refetch /api/projects and /api/chats),
 * chat:deleted (drop the chat).
 */
export const REMOTE_EVENTS = {
  chatEvent: "chat:event",
  chatUpdated: "chat:updated",
  agentsUpdated: "agents:updated",
  consultUpdated: "consult:updated",
  projectsUpdated: "projects:updated",
  chatDeleted: "chat:deleted",
} as const;
export type RemoteEventName = (typeof REMOTE_EVENTS)[keyof typeof REMOTE_EVENTS];
/** SSE `data` is a JSON array of these arguments. */
export interface RemoteEventArgs {
  "projects:updated": [];
  "chat:deleted": [chatId: number];
}

// ---------- audit (desktop only)

/** Remote state changes shown in the desktop remote web dialog (memory, newest first, max 50). */
export type RemoteAuditAction =
  | "chat.create" | "chat.update" | "chat.delete" | "chat.approvalMode"
  | "project.create" | "project.update" | "project.approvalMode"
  | "attachment.upload";
export interface RemoteAuditEntry { at: number; user: string; ip: string; action: RemoteAuditAction; target: string; detail?: string }

// ---------- client-only (D6): no server API

/** localStorage key of the web page's own theme ("dark" | "light"; absent = system). */
export const REMOTE_THEME_STORAGE_KEY = "cbx-theme";

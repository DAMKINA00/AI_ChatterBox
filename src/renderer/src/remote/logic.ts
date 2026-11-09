// Pure helpers for the remote web page (theme, approval autonomy, attachments, slash commands, lists).
// Kept free of React and browser globals so they run under node:test.
import {
  REMOTE_ATTACHMENT_TYPES, REMOTE_COMMANDS, normalizeRemoteFileName,
  REMOTE_FOLDER_NAME_PATTERN, REMOTE_LIMITS, type RemoteCommandName, type RemoteProjectSettings,
} from "../../../shared/remote-web";
import type { AgentKind, ApprovalMode, Chat, ModelOption } from "../../../shared/types";

// lib/utils.formatBytes reads window.chatterbox at import time, so the page keeps its own copy.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- theme (D6: this browser only)

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_LABEL: Record<ThemeChoice, string> = { system: "시스템 설정", light: "라이트", dark: "다크" };
export const readTheme = (stored: string | null): ThemeChoice => (stored === "dark" || stored === "light" ? stored : "system");
export const isDark = (choice: ThemeChoice, systemDark: boolean) => (choice === "system" ? systemDark : choice === "dark");
export const nextTheme = (choice: ThemeChoice): ThemeChoice => (choice === "system" ? "light" : choice === "light" ? "dark" : "system");

// ---------- approval mode (D3)

export const APPROVAL_MODES: ApprovalMode[] = ["user", "orchestrator", "orchestrator-all"];
const RANK: Record<ApprovalMode, number> = { user: 0, orchestrator: 1, "orchestrator-all": 2 };
export const approvalHelp = (mode: ApprovalMode) =>
  mode === "orchestrator-all" ? "고위험도 마스터에게 위임합니다. 명시적 거부, 작업 범위, 계획 모드 제한은 유지합니다."
    : mode === "orchestrator" ? "마스터가 판단하고, 고위험하거나 불확실한 요청은 관리자에게 확인합니다."
      : "작업자가 파일을 고치거나 명령을 실행할 때마다 관리자가 직접 승인합니다.";

/** The project's mode as the desktop shows it (orchestrator + delegateHighRisk = orchestrator-all). */
export const projectApprovalMode = (s: Pick<RemoteProjectSettings, "approvalMode" | "delegateHighRisk">): ApprovalMode =>
  s.approvalMode === "orchestrator" && s.delegateHighRisk ? "orchestrator-all" : s.approvalMode;
/** True when moving from `from` to `to` gives the master more autonomy (the server asks for confirm). */
export const raisesAutonomy = (from: ApprovalMode, to: ApprovalMode) => RANK[to] > RANK[from];

// ---------- models and reasoning effort (same rules as the desktop EffortPicker)

export const MODEL_AGENTS: AgentKind[] = ["claude", "codex", "gemini", "grok", "deepseek"];
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];

export function findModel(models: Partial<Record<AgentKind, ModelOption[]>>, agent: AgentKind, model: string): ModelOption | undefined {
  const list = models[agent] ?? [];
  return list.find(m => m.id === model) ?? (agent === "deepseek" && !model ? list.find(m => m.isDefault) : undefined);
}

export function effortChoices(models: Partial<Record<AgentKind, ModelOption[]>>, agent: AgentKind, model: string, worker: boolean): string[] {
  const unique = [...new Set((findModel(models, agent, model)?.reasoningEfforts ?? []).filter(v => typeof v === "string" && v.length > 0))];
  const ordered = [...EFFORT_ORDER.filter(v => unique.includes(v)), ...unique.filter(v => !EFFORT_ORDER.includes(v))];
  return ["auto", ...ordered];
}
export const effortText = (value: string | null | undefined) => (!value ? "CLI 기본값" : value === "auto" ? "자동 배정" : value);

/** Model choices for a picker: visible models plus the current value if it is hidden or unknown. */
export function modelChoices(list: ModelOption[] | undefined, current: string): ModelOption[] {
  const visible = (list ?? []).filter(m => !m.hidden || m.id === current);
  return current && !visible.some(m => m.id === current) ? [{ id: current, label: current }, ...visible] : visible;
}

// ---------- attachments (D4 pre-check; the server checks again)

const EXT_MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".log": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".pdf": "application/pdf", ".zip": "application/zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const extOf = (name: string) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i).toLowerCase() : ""; };

/** Browser type, or a guess from the extension when the browser leaves it empty. */
export const attachmentMime = (name: string, type: string) => type || EXT_MIME[extOf(name)] || "application/octet-stream";

/** The server stores only allow-listed types (REMOTE_ATTACHMENT_TYPES, keyed by extension). */
export const mimeAllowed = (mime: string) => Object.values(REMOTE_ATTACHMENT_TYPES).includes(mime);

/** Error message for a file the server would refuse, or null when it may be uploaded. */
export function attachmentProblem(file: { name: string; size: number; type: string }, pending: number): string | null {
  if (pending >= REMOTE_LIMITS.attachmentsPendingPerChat) return `첨부는 한 번에 ${REMOTE_LIMITS.attachmentsPendingPerChat}개까지 올릴 수 있습니다.`;
  const normalized = normalizeRemoteFileName(file.name);
  if (!normalized) return `${file.name}: 쓸 수 없는 파일 이름입니다.`;
  if (!REMOTE_ATTACHMENT_TYPES[normalized.ext]) return `${file.name}: 이미지(png·jpg·gif·webp)·텍스트(txt·md·csv·json·log 등)·PDF·오피스·zip 파일만 올릴 수 있습니다.`;
  if (file.size > REMOTE_LIMITS.attachmentBytes) return `${file.name}: 파일당 ${formatBytes(REMOTE_LIMITS.attachmentBytes)}까지 올릴 수 있습니다 (${formatBytes(file.size)}).`;
  if (!file.size) return `${file.name}: 빈 파일입니다.`;
  return null;
}

/** File picker filter matching the server's allow-list. */
export const ATTACHMENT_ACCEPT = Object.keys(REMOTE_ATTACHMENT_TYPES).join(",");

export const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

/** base64 of raw bytes, chunked so large files do not overflow the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ---------- slash commands typed into the composer

export type Slash = { kind: "command"; name: RemoteCommandName; arg: string } | { kind: "stop" } | { kind: "error"; message: string };
export const COMMAND_HELP: { name: "plan" | "goal" | "review" | "compact"; args?: string; desc: string; needsArg?: boolean }[] = [
  { name: "plan", args: "<지시>", needsArg: true, desc: "계획만 세우고, 확인한 뒤 실행" },
  { name: "goal", args: "<목표> | clear", needsArg: true, desc: "채팅 목표를 정하고 끝날 때까지 진행" },
  { name: "review", args: "[요청]", desc: "커밋되지 않은 변경을 작업자에게 리뷰" },
  { name: "compact", desc: "마스터 대화 압축" },
];

/** `/name arg` → a command; plain text (or an unknown /word) → null so it is sent as an instruction. */
export function parseSlash(text: string): Slash | null {
  const m = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const [, name, rest = ""] = m;
  const arg = rest.trim();
  if (name === "stop") return { kind: "stop" };
  if (!(REMOTE_COMMANDS as readonly string[]).includes(name) || name === "plan-run" || name === "plan-cancel") return null;
  const help = COMMAND_HELP.find(c => c.name === name);
  if (help?.needsArg && !arg) return { kind: "error", message: `/${name} ${help.args} 형식으로 입력하세요.` };
  if (arg.length > REMOTE_LIMITS.text) return { kind: "error", message: `명령 내용은 ${REMOTE_LIMITS.text.toLocaleString()}자까지입니다.` };
  return { kind: "command", name: name as RemoteCommandName, arg };
}

// ---------- projects

export function folderNameProblem(name: string): string | null {
  if (!name) return "폴더 이름을 입력하세요.";
  if (name.length > REMOTE_LIMITS.folderName) return `폴더 이름은 ${REMOTE_LIMITS.folderName}자까지입니다.`;
  if (name.includes("..") || !REMOTE_FOLDER_NAME_PATTERN.test(name)) return "폴더 이름에 \\ / : * ? \" < > | 를 쓸 수 없고, 점(.)으로 시작할 수 없습니다.";
  return null;
}

// ---------- chat list

export interface ProjectRef { id: number; name: string; archived: boolean }

/**
 * Chat list groups. `showArchived` also lists archived chats and projects. `matches` (search result ids)
 * keeps only those chats; null = no search.
 */
export function chatGroups(chats: Chat[], projects: ProjectRef[], showArchived: boolean, matches: Set<number> | null) {
  return projects
    .filter(p => showArchived || !p.archived)
    .map(project => ({
      project,
      chats: chats
        .filter(c => c.projectId === project.id && (showArchived || !c.archived) && (!matches || matches.has(c.id)))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    }))
    .filter(g => g.chats.length || (!matches && !g.project.archived));
}

/** Drops chats the server deleted (chat:deleted), even if an older snapshot still lists them. */
export const withoutDeleted = (chats: Chat[], deleted: Set<number>) => (deleted.size ? chats.filter(c => !deleted.has(c.id)) : chats);

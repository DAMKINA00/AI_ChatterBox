// The desktop renderer's API (ChatterBoxApi, normally the Electron preload) implemented on the remote web
// server's HTTP routes and SSE stream (src/main/remote-web.ts, docs/remote-web.md). The renderer runs
// unchanged on top of it; what the server does not offer answers with REMOTE_UNSUPPORTED.
// Authentication, CSRF and the server's checks stay as they are: this file only calls the existing routes.
// Must not import lib/utils (it reads window.chatterbox, which this file provides).
import type {
  AgentKind, AttachmentRef, Chat, ChatAgent, ChatterBoxApi, CliInfo, Consult, ModelOption, Project, ProjectSettings,
  RunStatsRows, Theme, TimelineEvent, UsageInfo,
} from "../../../shared/types";
import { REMOTE_TEXT_FIELDS, type EventPage, type StateSnapshot } from "../../../shared/event-page";
import {
  REMOTE_ATTACHMENT_TYPES, REMOTE_COMMANDS, REMOTE_EVENTS, REMOTE_THEME_STORAGE_KEY,
  type RemoteAttachmentResponse, type RemoteChatResponse, type RemoteCliResponse, type RemoteCommandName, type RemoteModelsResponse,
  type RemoteForkAnchorResponse, type RemoteProject, type RemoteProjectPatch, type RemoteProjectResponse, type RemoteProjectsResponse, type RemoteSearchResponse, type RemoteUsageResponse,
} from "../../../shared/remote-web";
import { pendingUploads, RemoteDeleteTargetChanged, REMOTE_UNSUPPORTED, useRemoteUsage } from "../lib/remote-mode";
import { ApiError, AuthError, postConfirmed, request, url } from "./api";

export interface RemoteApiHooks {
  /** The session ended (401): show the login page. */
  onAuthLost(): void;
  /** D3: a change raises autonomy; the user must confirm (the server answered 428). */
  confirm(message: string): Promise<boolean>;
  /** Non-fatal notice (e.g. some of several uploads failed). */
  notify(message: string): void;
  /** The loaded event with this id (to rebuild a shortened message around its original text). */
  findEvent(chatId: number, eventId: number): TimelineEvent | undefined;
  /** The stream reconnected after a drop: data may have been missed; reload what is on screen. */
  onResync(chatId: number | null): void;
}

/** GET /api/chats/:id (newest page plus the chat's team). */
interface RemoteDetail { seq: number; chat: Chat; events: TimelineEvent[]; context?: TimelineEvent[]; snapshot?: StateSnapshot; start: number; hasMore: boolean; agents: ChatAgent[]; consults: Consult[] }

type Handler = (...args: never[]) => void;

/** How long a history load waits for the chat's stream to open. */
export const OPEN_WAIT_MS = 4000;

/** A history page read for a chat that is no longer on screen (or across a stream gap it could not repair). */
export class StaleHistoryError extends Error {
  constructor() { super("다른 채팅으로 이동해 이 기록은 버렸습니다. 다시 열면 새로 읽습니다."); }
}

const unsupported = (): never => { throw new Error(REMOTE_UNSUPPORTED); };
const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));

/** Project as the renderer knows it; the folder path never leaves the PC. */
export const toProject = (p: RemoteProject): Project => ({
  id: p.id, name: p.name, archived: p.archived, createdAt: p.createdAt, folder: "", settings: p.settings as ProjectSettings,
});

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The MIME type the server will store (it ignores the browser's type; unknown extensions are refused there). */
function mimeOf(name: string, fallback: string): string {
  const i = name.lastIndexOf(".");
  return (i > 0 && REMOTE_ATTACHMENT_TYPES[name.slice(i).toLowerCase()]) || fallback || "application/octet-stream";
}

/** Lets the user choose files with the browser's own picker; resolves [] when they cancel. */
function chooseFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = Object.keys(REMOTE_ATTACHMENT_TYPES).join(",");
    let done = false;
    const finish = (files: File[]) => { if (!done) { done = true; input.remove(); resolve(files); } };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    input.style.display = "none";
    document.body.append(input);
    input.click();
  });
}

/** The adapter plus the page shell's controls: start the stream, and keep it on the selected chat. */
export type RemoteApi = ChatterBoxApi & {
  start(): void;
  follow(chatId: number | null): void;
  saveProject(id: number, patch: RemoteProjectPatch): Promise<Project>;
  forkAnchor(id: number): Promise<RemoteForkAnchorResponse["anchor"]>;
};

export function createRemoteApi(hooks: RemoteApiHooks): RemoteApi {
  const handlers = new Map<string, Set<Handler>>();
  const on = (channel: string, cb: Handler) => {
    const set = handlers.get(channel) ?? new Set();
    handlers.set(channel, set.add(cb));
    return () => { set.delete(cb); };
  };
  const emit = (channel: string, args: unknown[]) => { for (const cb of handlers.get(channel) ?? []) (cb as (...a: unknown[]) => void)(...args); };

  /** Every call goes through here: a lost session switches to the login page. */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (e) { if (e instanceof AuthError) hooks.onAuthLost(); throw e; }
  };
  const get = <T>(path: string) => call(() => request<T>(path));
  const post = <T>(path: string, body: unknown = {}) => call(() => request<T>(path, body));
  const confirmed = <T>(path: string, body: Record<string, unknown>) => call(async () => {
    const r = await postConfirmed<T>(path, body, hooks.confirm);
    if (r === undefined) throw new Error("변경을 취소했습니다.");
    return r;
  });
  const saveProject: RemoteApi["saveProject"] = async (id, patch) =>
    toProject((await confirmed<RemoteProjectResponse>(url("/api/projects/:id/update", id), { ...patch })).project);

  // ---------- stream: one EventSource, chat events for the chat on screen (the server filters by ?chat=).
  // Its lifetime follows the selected chat (follow()), not the history cache. `epoch` changes whenever the
  // live events may have had a gap (another stream, a (re)connect): a history page read across a change is
  // not trusted (loadEventsPage reads it again, or drops it when the chat is no longer on screen).
  let source: EventSource | null = null;
  let streamChat: number | null = null;
  let epoch = 0;
  let opened: Promise<void> = Promise.resolve();
  let started = false;

  const openStream = (chatId: number | null): Promise<void> => {
    if (source && streamChat === chatId) return opened;
    source?.close();
    streamChat = chatId;
    epoch++;
    const es = new EventSource(chatId === null ? url("/api/stream") : `${url("/api/stream")}?chat=${chatId}`);
    source = es;
    let first = true;
    let late = false;
    opened = new Promise<void>(ok => {
      // A slow connection must not hold the history load for long; if it opens after the wait, the page may
      // already be on screen without the events in between, so the chat is read again (onResync).
      const timer = setTimeout(() => { late = true; ok(); }, OPEN_WAIT_MS);
      es.addEventListener("open", () => {
        if (source !== es) return;
        clearTimeout(timer);
        epoch++;
        ok();
        if (!first || late) hooks.onResync(chatId);
        first = false;
      });
    });
    es.onerror = () => {
      if (source !== es) return;
      // EventSource retries by itself; a 401 behind it means the session is gone.
      void request(url("/api/session")).catch(e => { if (e instanceof AuthError) { es.close(); hooks.onAuthLost(); } });
    };
    const data = (e: Event) => JSON.parse((e as MessageEvent).data) as unknown[];
    es.addEventListener(REMOTE_EVENTS.chatEvent, e => emit("chat:event", data(e)));
    es.addEventListener(REMOTE_EVENTS.chatUpdated, e => emit("chat:updated", data(e)));
    es.addEventListener(REMOTE_EVENTS.agentsUpdated, e => emit("agents:updated", data(e)));
    es.addEventListener(REMOTE_EVENTS.consultUpdated, e => emit("consult:updated", data(e)));
    es.addEventListener(REMOTE_EVENTS.chatDeleted, e => {
      const args = data(e);
      details.delete(args[0] as number);
      emit("chat:deleted", args);
    });
    es.addEventListener(REMOTE_EVENTS.projectsUpdated, () => emit("projects:updated", []));
    return opened;
  };

  // ---------- chat detail: one request serves the page, workers and consults the store asks for together
  const details = new Map<number, { at: number; promise: Promise<RemoteDetail> }>();
  const detail = (chatId: number, fresh = false): Promise<RemoteDetail> => {
    const cached = details.get(chatId);
    if (cached && !fresh && Date.now() - cached.at < 3000) return cached.promise;
    const promise = get<RemoteDetail>(url("/api/chats/:id", chatId));
    details.set(chatId, { at: Date.now(), promise });
    promise.catch(() => { if (details.get(chatId)?.promise === promise) details.delete(chatId); });
    return promise;
  };

  const usage = async (wait = false): Promise<UsageInfo> => {
    let r: RemoteUsageResponse;
    try { r = await get<RemoteUsageResponse>(url("/api/usage", undefined, { refresh: wait ? "1" : "0" })); }
    catch (e) {
      // Refreshing is limited per session; the stored reading is still worth showing.
      if (!(e instanceof ApiError && e.status === 429)) throw e;
      r = await get<RemoteUsageResponse>(url("/api/usage", undefined, { refresh: "0" }));
    }
    useRemoteUsage.setState({ groups: r.groups, loaded: true });
    const info = { ...(r.deepseek ? { deepseek: r.deepseek } : {}) } as UsageInfo;
    emit("usage", [info]);
    return info;
  };

  const upload = async (chatId: number, name: string, mime: string, bytes: Uint8Array): Promise<AttachmentRef> => {
    const { attachment } = await post<RemoteAttachmentResponse>(url("/api/chats/:id/attachments", chatId), { name, mime: mimeOf(name, mime), data: base64(bytes) });
    pendingUploads.set(attachment.id, attachment.uuid);
    return { id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size, path: "" };
  };

  const api: RemoteApi = {
    start() {
      if (started) return;
      started = true;
      if (!source) void openStream(null);
    },
    /** The chat on screen (null = none): its live events stream regardless of what is cached. */
    follow(chatId) {
      if (streamChat !== chatId || !source) void openStream(chatId);
    },

    // ---------- projects
    saveProject,
    listProjects: async () => (await get<RemoteProjectsResponse>(url("/api/projects"))).projects.map(toProject),
    createProject: async () => unsupported(),
    async updateProject(id, patch) {
      if (patch.folder !== undefined) unsupported();
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.archived !== undefined) body.archived = patch.archived;
      if (patch.settings) body.settings = patch.settings;
      return saveProject(id, body);
    },
    deleteProject: async () => unsupported(),
    pickFolder: async () => unsupported(),

    // ---------- chats
    async listChats() {
      const r = await get<{ chats: Chat[] }>(url("/api/chats"));
      return r.chats;
    },
    createChat: async projectId => (await post<RemoteChatResponse>(url("/api/chats"), { projectId })).chat,
    async reorderChat(id, targetId, placement) {
      return (await post<{ chats: Chat[] }>(url("/api/chats/:id/reorder", id), { targetId, placement })).chats;
    },
    forkChat: async (chatId, options) => (await post<RemoteChatResponse>(url("/api/chats/:id/fork", chatId), options)).chat,
    forkAnchor: async id => (await get<RemoteForkAnchorResponse>(url("/api/chats/:id/fork-anchor", id))).anchor,
    updateChat: async (id, patch) => (await confirmed<RemoteChatResponse>(url("/api/chats/:id/update", id), patch as Record<string, unknown>)).chat,
    async deleteChat(id, target) {
      if (!target || target.id !== id) throw new Error("삭제할 채팅을 다시 확인하세요.");
      try {
        await post(url("/api/chats/:id/delete", id), { confirm: target.title, createdAt: target.createdAt, projectId: target.projectId });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 412)) throw new RemoteDeleteTargetChanged(error.message);
        throw error;
      }
    },
    markViewed: async id => { await post(url("/api/chats/:id/viewed", id)); },
    listConsults: async chatId => (await detail(chatId)).consults,
    listAgents: async chatId => (await detail(chatId)).agents,
    async loadEvents(chatId) { return (await detail(chatId, true)).events; },
    async loadEventsPage(chatId, before) {
      if (before !== undefined) return get<EventPage>(url("/api/chats/:id", chatId, { before: String(before) }));
      // The newest page: the chat's live events must be flowing before it is read (events that arrive
      // meanwhile are replayed on top of it by the store). The page counts only if the same stream stayed
      // open for this chat the whole time; otherwise it is read again, or dropped when the user moved on
      // (a late answer must never fill the history of a chat that is not receiving its events).
      if (streamChat !== chatId) await openStream(chatId);
      else await opened;
      for (let attempt = 0; ; attempt++) {
        const at = epoch;
        const d = await detail(chatId, true);
        if (streamChat !== chatId) throw new StaleHistoryError();
        if (at === epoch || attempt >= 2) return { events: d.events, start: d.start, hasMore: d.hasMore, context: d.context ?? [], ...(d.snapshot ? { snapshot: d.snapshot } : {}) };
        await opened;
      }
    },
    async loadEvent(chatId, eventId) {
      // The server returns the original text of shortened text messages only ({id, type, text}).
      const original = hooks.findEvent(chatId, eventId);
      const field = original && REMOTE_TEXT_FIELDS[original.event.type as keyof typeof REMOTE_TEXT_FIELDS];
      if (!original || !field) throw new Error("원격 웹에서는 이 기록의 원문을 볼 수 없습니다. PC 앱에서 확인하세요.");
      const read = () => get<{ id: number; type: string; text: string }>(`${url("/api/chats/:id/events", chatId)}/${eventId}`);
      let r: { text: string };
      try { r = await read(); }
      catch (e) {
        if (!(e instanceof ApiError && e.status === 429)) throw e;
        await sleep(1100);
        r = await read();
      }
      const { clipped: _, ...rest } = original as TimelineEvent & { clipped?: unknown };
      return { ...rest, event: { ...original.event, [field]: r.text } } as TimelineEvent;
    },
    pendingApprovals: (chatId, before, offset = 0) => get(url("/api/chats/:id/pending-approvals", chatId, { before: String(before), offset: String(offset) })),
    async runStats(chatId, now) {
      return (await get<{ rows: RunStatsRows }>(url("/api/chats/:id/run-stats", chatId, now ? { live: "1" } : undefined))).rows;
    },
    searchChats: async q => (await get<RemoteSearchResponse>(url("/api/search", undefined, { q }))).chatIds,
    async send(chatId, text, attachmentIds, delivery, clientMessageId) {
      const attachments = attachmentIds.map(id => {
        const uuid = pendingUploads.get(id);
        if (!uuid) throw new Error("첨부 목록이 오래되었습니다. 첨부를 지우고 다시 올리세요.");
        return { id, uuid };
      });
      const result = await post<{ eventId?: number | null }>(url("/api/chats/:id/send", chatId), { text, delivery: delivery ?? "now", attachments, clientMessageId });
      for (const id of attachmentIds) pendingUploads.delete(id);
      return result?.eventId;
    },
    stop: async chatId => { await post(url("/api/chats/:id/stop", chatId)); },
    pause: async chatId => { await post(url("/api/chats/:id/pause", chatId)); },
    resume: async chatId => { await post(url("/api/chats/:id/resume", chatId)); },
    async command(chatId, name, arg) {
      if (name === "stop") { await post(url("/api/chats/:id/stop", chatId)); return; }
      if (!REMOTE_COMMANDS.includes(name as RemoteCommandName)) unsupported();
      await post(url("/api/chats/:id/command", chatId), { name, arg });
    },
    setPlanMode: async (chatId, on) => { await post(url("/api/chats/:id/plan-mode", chatId), { on }); },
    dismissInterrupted: async chatId => { await post(url("/api/chats/:id/dismiss-interrupted", chatId)); },
    async answerApproval(chatId, approvalId, decision) {
      try { return (await post<{ decision: typeof decision }>(url("/api/chats/:id/approve", chatId), { approvalId, decision })).decision; }
      catch (e) { if (e instanceof ApiError && e.status === 409) return null; throw e; }
    },
    async answerAskUser(chatId, askId, answer) {
      try { await post(url("/api/chats/:id/answer", chatId), { askId, answer }); return true; }
      catch (e) { if (e instanceof ApiError && e.status === 409) return false; throw e; }
    },

    // ---------- attachments (D4: uploads through the browser; no PC paths)
    attachFromPaths: async () => unsupported(),
    attachFromBytes: (chatId, name, mime, bytes) => upload(chatId, name, mime, bytes),
    async pickAttachments(chatId) {
      const files = await chooseFiles();
      const added: AttachmentRef[] = [];
      const failed: string[] = [];
      for (const f of files) {
        try { added.push(await upload(chatId, f.name, f.type, new Uint8Array(await f.arrayBuffer()))); }
        catch (e) { failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (failed.length && !added.length) throw new Error(failed.join(" / "));
      if (failed.length) hooks.notify(`일부 첨부 실패 — ${failed.join(" / ")}`);
      return added;
    },
    async removeAttachment(id) {
      const uuid = pendingUploads.get(id);
      if (!uuid) return;
      pendingUploads.delete(id);
      await post(url("/api/attachments/:id/remove", id), { uuid }).catch(() => undefined);
    },
    pathForFile: () => "",

    // ---------- status and settings
    async cliInfo() {
      // Installation and the stored login state only (GET /api/cli); never paths or error texts.
      try { return (await get<RemoteCliResponse>(url("/api/cli"))).cli.map((c): CliInfo => ({ agent: c.agent, path: c.installed ? "PC" : null, authStatus: c.authStatus })); }
      catch (e) { if (e instanceof ApiError && e.status === 404) return []; throw e; }
    },
    models: async (agent: AgentKind): Promise<ModelOption[]> => (await get<RemoteModelsResponse>(url("/api/models", undefined, { agent }))).models,
    cliAccounts: {
      list: async () => [],
      startupCheck: async () => [],
      create: async () => unsupported(),
      login: async () => unsupported(),
      logout: async () => unsupported(),
      refresh: async () => unsupported(),
      update: async () => unsupported(),
      remove: async () => unsupported(),
      getPolicy: async () => unsupported(),
      setPolicy: async () => unsupported(),
    },
    deepSeek: async () => unsupported(),
    remoteWeb: async () => unsupported(),
    async getTheme(): Promise<Theme> {
      try { return localStorage.getItem(REMOTE_THEME_STORAGE_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
    },
    async setTheme(theme) {
      try { localStorage.setItem(REMOTE_THEME_STORAGE_KEY, theme); } catch { /* private mode */ }
      document.documentElement.style.colorScheme = theme;
    },
    usage,
    openPath: async () => { throw new Error("원격 웹에서는 PC의 파일·폴더를 열 수 없습니다."); },
    previewImage: async () => null,
    async linkAction(_chatId, href, action) {
      if (action === "open" && /^https?:\/\//i.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
        return {};
      }
      throw new Error("원격 웹에서는 PC의 파일을 열 수 없습니다.");
    },

    // ---------- push events (from the stream)
    onEvent: cb => on("chat:event", cb as Handler),
    onChatUpdated: cb => on("chat:updated", cb as Handler),
    onConsultUpdated: cb => on("consult:updated", cb as Handler),
    onAgentsUpdated: cb => on("agents:updated", cb as Handler),
    onUsage: cb => on("usage", cb as Handler),
    onSelectChat: () => () => undefined,
    onChatDeleted: cb => on("chat:deleted", cb as Handler),
    onProjectsUpdated: cb => on("projects:updated", cb as Handler),
  };
  return api;
}

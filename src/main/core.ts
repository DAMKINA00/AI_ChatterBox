import { app } from "electron";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUSY_STATUSES, chatApprovalChange, checkRemoteSend, listRemoteUploads, mergeProjectSettings, remoteError, removeRemoteUpload, saveRemoteUpload } from "./remote-core";
import { REMOTE_UPLOAD_BUDGET, REMOTE_UPLOAD_STORAGE, type RemoteUploadKey } from "../shared/remote-web";
import { ForkError } from "./chat-fork";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { CLI_ACCOUNT_KINDS, type AgentKind, type ApprovalDecision, type ChatForkOptions, type CliAccountId, type CliAccountKind, type CliAccountPolicies, type ProjectSettings, type Theme, type GeminiWebAccountId } from "../shared/types";
import type { AIStudioAction, AIStudioInput } from "../shared/aistudio";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { AttachmentStore } from "./attachments";
import { Orchestrator } from "./orchestrator";
import { resolveLink } from "./file-links";
import { previewImage } from "./artifact-preview";
import { CoreRpc } from "./core-rpc";

let store: Store;
let chats: ChatManager;
let attachments: AttachmentStore;
let orchestrator: Orchestrator;
let preparingUpdate = false;
/** Chats being deleted from the remote web; no new work may start on them. */
const remoteDeleting = new Set<number>();
let pendingCalls = 0;

function withAccountPolicy(settings: ProjectSettings): ProjectSettings {
  if (!settings || settings.accountPolicy === undefined) return settings;
  return { ...settings, accountPolicy: chats.sanitizeAccountPolicy(settings.accountPolicy) };
}

function registerHandlers(rpc: CoreRpc) {
  const channels: string[] = [];
  const ipcMain = { handle(channel: string, handler: (...args: any[]) => unknown) {
    channels.push(channel);
    rpc.handle(channel, async (...args) => {
      if (preparingUpdate && channel !== "window:save") throw new Error("업데이트 적용을 준비하고 있습니다. 새 작업은 재시작 후 보내 주세요.");
      const backgroundRead = ["usage:get", "cli:info", "models:list", "aistudio:usage"].includes(channel);
      if (!backgroundRead) pendingCalls++;
      try { return await handler(undefined, ...args); }
      finally { if (!backgroundRead) pendingCalls--; }
    });
  } };
  // projects
  ipcMain.handle("projects:list", () => store.listProjects());
  ipcMain.handle("projects:create", (_e, input: { name: string; folder: string; settings: ProjectSettings }) => {
    if (!input.folder || !existsSync(input.folder)) throw new Error("작업 폴더가 없습니다.");
    return store.createProject(input.name.trim() || "새 프로젝트", input.folder, withAccountPolicy(input.settings));
  });
  ipcMain.handle("projects:update", async (_e, id: number, patch) => {
    if (patch.folder !== undefined && (!patch.folder || !existsSync(patch.folder) || !statSync(patch.folder).isDirectory()))
      throw new Error("작업 폴더가 없습니다.");
    // A stale form must not write back a removed account or a malformed policy.
    if (patch.settings) patch = { ...patch, settings: withAccountPolicy(patch.settings) };
    const before = store.project(id);
    const p = store.updateProject(id, patch);
    if (patch.settings || patch.folder) {
      for (const c of store.listChats().filter((c) => c.projectId === id)) chats.approvals.invalidate(c.id);
    }
    // A new folder means new working directories for every CLI conversation.
    if (before && patch.folder && patch.folder !== before.folder)
      for (const c of store.listChats().filter((c) => c.projectId === id)) await chats.resetDrivers(c.id);
    return p;
  });
  // Remote-upload files live as long as a record references them: deleting chats drops their records,
  // so their remote uploads (sent or not) are collected right after. Desktop attachment files are kept.
  const remoteUploadsOf = (chatIds: number[]) => chatIds.flatMap((c) => store.attachmentPaths(c)).filter((p) => attachments.isRemoteUpload(p));
  ipcMain.handle("projects:delete", async (_e, id: number) => {
    const ids = store.listChats().filter((c) => c.projectId === id).map((c) => c.id);
    for (const c of ids) await chats.resetDrivers(c);
    const released = remoteUploadsOf(ids);
    store.deleteProject(id);
    attachments.gcRemoteUploads({ released });
  });

  // chats
  ipcMain.handle("chats:list", () => store.listChats());
  ipcMain.handle("chats:create", (_e, projectId: number) => store.createChat(projectId, "새 채팅"));
  ipcMain.handle("chats:update", (_e, id: number, patch) => chats.updateChat(id, patch));
  ipcMain.handle("chats:delete", async (_e, id: number) => {
    await orchestrator.stop(id);
    orchestrator.forget(id);
    const released = remoteUploadsOf([id]);
    await chats.deleteChat(id);
    attachments.gcRemoteUploads({ released });
  });
  ipcMain.handle("chats:viewed", (_e, id: number) => {
    if (store.chat(id)?.unread) chats.updateChat(id, { unread: false });
  });
  ipcMain.handle("chats:consults", (_e, id: number) => store.listConsults(id));
  ipcMain.handle("chats:agents", (_e, id: number) => store.listAgents(id));
  ipcMain.handle("chats:events", (_e, id: number) => store.events(id));
  // Windows open chats page by page; one long chat can exceed the 128MB core frame (see shared/event-page.ts).
  ipcMain.handle("chats:eventsPage", (_e, id: number, before?: number) => store.eventsPage(id, before));
  ipcMain.handle("chats:event", (_e, id: number, eventId: number) => store.event(id, eventId));
  ipcMain.handle("chats:statsEvents", (_e, id: number) => store.statsEvents(id));
  ipcMain.handle("chats:hasAttachment", (_e, id: number, attachmentId: number) => store.chatHasAttachment(id, attachmentId));
  ipcMain.handle("chats:search", (_e, q: string) => (q.trim() ? store.searchChats(q.trim()) : []));
  const notDeleting = (id: number) => { if (remoteDeleting.has(id)) throw new Error("채팅을 삭제하는 중입니다."); };
  ipcMain.handle("chats:send", (_e, id: number, text: string, attachmentIds: number[], delivery?: "now" | "next") => { notDeleting(id); return chats.send(id, text, attachmentIds, delivery); });
  ipcMain.handle("chats:fork", (_e, id: number, options: ChatForkOptions) => { notDeleting(id); return chats.forkChat(id, options); });
  ipcMain.handle("chats:stop", (_e, id: number) => orchestrator.stop(id));
  ipcMain.handle("chats:pause", (_e, id: number) => orchestrator.pause(id));
  ipcMain.handle("chats:resume", (_e, id: number) => { notDeleting(id); return orchestrator.resume(id); });
  ipcMain.handle("chats:command", (_e, id: number, name: string, arg: string) => { notDeleting(id); return orchestrator.command(id, name, arg); });
  ipcMain.handle("chats:dismissInterrupted", (_e, id: number) => orchestrator.dismissInterrupted(id));
  ipcMain.handle("chats:approve", (_e, id: number, approvalId: string, decision: ApprovalDecision) =>
    chats.answerApproval(id, approvalId, decision),
  );
  ipcMain.handle("chats:answerAsk", (_e, id: number, askId: string, answer: string) => orchestrator.answerAsk(id, askId, answer));

  // ---- remote web: check-and-change in one synchronous step (no await between reading and writing),
  // so a desktop change in between cannot be overwritten or bypassed. Errors carry "HTTP<status>:".
  ipcMain.handle("remote:chat-patch", (_e, id: number, patch: Record<string, unknown>, confirm: boolean) => {
    const chat = store.chat(id);
    if (!chat) throw remoteError(404, "채팅이 없습니다.");
    const approvalChange = chatApprovalChange(chat, store.project(chat.projectId)!.settings, patch, confirm === true);
    return { chat: chats.updateChat(id, patch), approvalChange };
  });
  ipcMain.handle("remote:project-patch", (_e, id: number, patch: { name?: string; archived?: boolean; settings?: Record<string, unknown> }, confirm: boolean) => {
    const project = store.project(id);
    if (!project) throw remoteError(404, "프로젝트가 없습니다.");
    const merged = patch.settings ? mergeProjectSettings(project.settings, patch.settings, confirm === true) : undefined;
    const settings = merged?.settings, approvalChange = merged?.approvalChange;
    const updated = store.updateProject(id, { name: patch.name, archived: patch.archived, settings });
    if (settings) for (const c of store.listChats().filter((c) => c.projectId === id)) chats.approvals.invalidate(c.id);
    return { project: updated, approvalChange };
  });
  ipcMain.handle("remote:chat-delete", async (_e, id: number, title: string) => {
    const chat = store.chat(id);
    if (!chat) throw remoteError(404, "채팅이 없습니다.");
    if (chat.title !== title) throw remoteError(400, "삭제하려면 채팅 제목을 정확히 입력하세요.");
    // Never stops work: a busy chat is refused, and no new work may start while the delete runs.
    if (BUSY_STATUSES.includes(chat.status) || chats.isBusy(id)) throw remoteError(409, "작업 중인 채팅은 삭제할 수 없습니다. 먼저 중지하세요.");
    remoteDeleting.add(id);
    const released = remoteUploadsOf([id]); // no remote upload can be added while it is marked deleting
    try {
      orchestrator.forget(id);
      await chats.deleteChat(id);
    } finally { remoteDeleting.delete(id); }
    // As on the desktop, the chat folder is kept; the chat's remote-upload files (sent or not) go.
    attachments.gcRemoteUploads({ released });
  });
  ipcMain.handle("remote:chat-fork", (_e, id: number, options: ChatForkOptions) => {
    if (remoteDeleting.has(id)) throw remoteError(409, "채팅을 삭제하는 중입니다.");
    try { return chats.forkChat(id, options, { maxBytes: REMOTE_UPLOAD_BUDGET.totalBytes, minFreeBytes: REMOTE_UPLOAD_STORAGE.minFreeBytes }); }
    catch (error) {
      if (error instanceof ForkError) throw remoteError(error.status, error.message);
      throw error;
    }
  });
  // Remote uploads: remote-pending/<UUID><ext>, sent or not; the only file cleanup is gcRemoteUploads()
  // (no tracking state). Remove and send name an upload by {id, uuid}.
  ipcMain.handle("remote:att-bytes", (_e, chatId: number, name: string, mime: string, bytes: Uint8Array, storageBytes: number) => {
    notDeleting(chatId);
    return saveRemoteUpload(store, attachments, chatId, name, mime, bytes, storageBytes);
  });
  ipcMain.handle("remote:uploads", (_e, chatId?: number) => listRemoteUploads(store, attachments, chatId));
  ipcMain.handle("remote:attachment-remove", (_e, chatId: number, key: RemoteUploadKey) => removeRemoteUpload(store, attachments, chatId, key));
  ipcMain.handle("remote:send", (_e, chatId: number, text: string, keys: RemoteUploadKey[], delivery?: "now" | "next") => {
    notDeleting(chatId);
    return chats.send(chatId, text, checkRemoteSend(store, attachments, chatId, keys), delivery);
  });

  // attachments
  ipcMain.handle("artifacts:previewImage", (_e, chatId: number, href: string) => previewImage(store, attachments, chatId, href));
  ipcMain.handle("att:paths", (_e, chatId: number, paths: string[]) => paths.map((p) => attachments.fromPath(chatId, p)));
  ipcMain.handle("att:bytes", (_e, chatId: number, name: string, mime: string, bytes: Uint8Array) =>
    attachments.fromBytes(chatId, name, mime, bytes),
  );
  ipcMain.handle("att:remove", (_e, id: number) => store.deleteAttachment(id));

  // misc
  ipcMain.handle("cli:info", (_e, checkAuth?: boolean) => checkAuth ? chats.checkedCliInfo() : chats.cliInfo());
  ipcMain.handle("models:list", (_e, agent: AgentKind) => chats.models(agent));
  ipcMain.handle("deepseek", async (_e, action, input = {}) => {
    const service = chats.deepSeek();
    if (action === "save") { service.save(input); chats.resetDeepSeekBalance(); }
    else if (action === "remove") { service.remove(); chats.resetDeepSeekBalance(); }
    else if (action === "check") return service.check();
    else if (action === "balance") await chats.refreshDeepSeekBalance();
    else if (action !== "status") throw new Error("지원하지 않는 DeepSeek 설정 작업입니다.");
    return service.status();
  });
  ipcMain.handle("aistudio:usage", (_e, range) => chats.aiStudio().usage(range));
  ipcMain.handle("aistudio", async (_e, action: AIStudioAction, input: AIStudioInput = {}) => {
    const studio = chats.aiStudio();
    if (action === "save") studio.save(input);
    else if (action === "launch") await studio.launch();
    else if (action === "start") await studio.start();
    else if (action === "stop") await studio.json("/api/control/stop", {});
    else if (action === "refresh") await studio.account(action, input);
    else if (action === "enable") {
      const accounts = chats.geminiWebAccounts();
      const ids = input.accountId ? studio.linkedWebAccounts(input.accountId) : [];
      const previous = accounts.list().filter(a => ids.includes(a.accountId));
      try {
        for (const account of previous) accounts.update(account.accountId, { enabled: input.enabled });
        await studio.account(action, input);
      } catch (error) {
        for (const account of previous) accounts.update(account.accountId, { enabled: account.enabled });
        throw error;
      }
    }
    else if (action === "sync-web") await chats.syncStudioWeb(input.accountId as GeminiWebAccountId);
    else if (action !== "status") throw new Error("지원하지 않는 AI Studio 요청입니다.");
    return studio.status();
  });
  ipcMain.handle("gemini:web", (_e, action: string, accountId: GeminiWebAccountId = "gemini-1") => {
    const browser = chats.geminiWeb(accountId);
    if (action === "login") return browser.login();
    if (action === "open") return browser.open();
    if (action === "refresh") return browser.refresh();
    if (action === "status") return browser.status();
    throw new Error("지원하지 않는 웹 연결 요청입니다.");
  });
  ipcMain.handle("gemini:web-accounts", async (_e, action: string, input?: { accountId?: GeminiWebAccountId; label?: string; enabled?: boolean }) => {
    const accounts = chats.geminiWebAccounts();
    if (action === "list") return accounts.list();
    if (action === "add") return accounts.add();
    if ((action === "logout" || action === "remove") && input?.accountId)
      return chats.disconnectWebAccount(input.accountId, action === "remove");
    if (action === "update" && input?.accountId) {
      const previous = accounts.list().find(a => a.accountId === input.accountId);
      const updated = accounts.update(input.accountId, input);
      const linked = chats.aiStudio().linkedAccount(input.accountId);
      if (linked && input.enabled !== undefined) {
        try { await chats.aiStudio().account("enable", { accountId: linked, enabled: input.enabled }); }
        catch (error) { if (previous) accounts.update(input.accountId, { enabled: previous.enabled }); throw error; }
      }
      return updated;
    }
    throw new Error("지원하지 않는 웹 계정 관리 요청입니다.");
  });
  ipcMain.handle("cli-accounts:list", () => chats.listCliAccounts());
  ipcMain.handle("cli-accounts:create", (_e, kind: CliAccountKind, label?: string) => {
    if (!(CLI_ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new Error("지원하지 않는 CLI 계열입니다.");
    return chats.createCliAccount(kind, label);
  });
  ipcMain.handle("cli-accounts:login", (_e, id: CliAccountId) => { chats.loginCliAccount(id); });
  ipcMain.handle("cli-accounts:logout", (_e, id: CliAccountId) => chats.logoutCliAccount(id));
  ipcMain.handle("cli-accounts:refresh", (_e, id?: CliAccountId) => chats.refreshCliAccount(id ?? undefined));
  ipcMain.handle("cli-accounts:update", (_e, id: CliAccountId, patch: { label?: string; enabled?: boolean }) => chats.updateCliAccount(id, patch ?? {}));
  ipcMain.handle("cli-accounts:remove", (_e, id: CliAccountId) => chats.removeCliAccount(id));
  ipcMain.handle("cli-accounts:get-policy", () => chats.getCliAccountPolicy());
  ipcMain.handle("cli-accounts:set-policy", (_e, policies: CliAccountPolicies) => chats.setCliAccountPolicy(policies));
  ipcMain.handle("theme:get", () => (store.getSetting("theme") as Theme) ?? "dark");
  ipcMain.handle("theme:set", (_e, theme: Theme) => {
    store.setSetting("theme", theme);
  });
  ipcMain.handle("usage:get", async (_e, wait = false) => {
    const refresh = chats.refreshUsage();
    if (wait === true) await refresh;
    return chats.usage();
  });
  ipcMain.handle("files:resolve-link", (_e, chatId: number, href: string) => {
    const chat = store.chat(chatId);
    const project = chat && store.project(chat.projectId);
    if (!project) throw new Error("대화의 프로젝트를 찾을 수 없습니다.");
    return resolveLink(href, project.folder);
  });
  ipcMain.handle("attachment:info", (_e, id: number) => store.attachment(id));
  ipcMain.handle("window:save", (_e, bounds: unknown) => store.setSetting("window", JSON.stringify(bounds)));
  return channels;
}

export async function runCore(dataDir: string, pipe: string, token: string, test: boolean) {
  const socket = connect(pipe);
  const rpc = new CoreRpc(socket, token, true);
  let stopping = false;
  let disposing: Promise<void> | undefined;
  const boot = (async () => {
    await rpc.ready;
    const elevated = process.platform === "win32" && execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"], { windowsHide: true, timeout: 15_000, encoding: "utf8" }).trim() === "True";
    if (process.platform === "win32" && !test && !elevated) throw new Error("코어는 관리자 권한으로 실행해야 합니다.");
    store = new Store(join(dataDir, "chatterbox.db"));
    attachments = new AttachmentStore(join(dataDir, "attachments"), store);
    // Remote-upload collection at start and every 10 minutes (unref: never keeps the core alive).
    attachments.gcRemoteUploads();
    setInterval(() => attachments.gcRemoteUploads(), 10 * 60_000).unref();
    chats = new ChatManager(store, {
      agents: (id, list) => rpc.emit("agents:updated", id, list),
      event: event => rpc.emit("chat:event", event),
      chat: chat => rpc.emit("chat:updated", chat),
      consult: consult => rpc.emit("consult:updated", consult),
      usage: usage => rpc.emit("usage", usage),
      webLogin: status => rpc.emit("gemini:web-login", status),
    }, dataDir, join(import.meta.dirname, "bridge-mcp.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1"));
    orchestrator = new Orchestrator(chats);
    const channels = registerHandlers(rpc);
    await chats.start();
    orchestrator.startRecovery();
    return { channels, elevated, pid: process.pid, version: app.getVersion(), window: store.getSetting("window"), theme: store.getSetting("theme") ?? "dark", chats: store.listChats() };
  })();
  void boot.catch(() => undefined);
  const dispose = () => disposing ??= (async () => {
    stopping = true;
    orchestrator?.stopRecovery();
    await boot.catch(() => undefined);
    await orchestrator?.judge.dispose().catch(() => undefined);
    await chats?.dispose().catch(() => undefined);
    try { store?.close(); } catch { /* already closed */ }
  })();
  rpc.handle("core:boot", () => boot);
  rpc.handle("core:prepare-update", async () => {
    if (preparingUpdate || chats.isBusyForUpdate()) return false;
    preparingUpdate = true;
    orchestrator.stopRecovery();
    const deadline = Date.now() + 5_000;
    while ((pendingCalls || orchestrator.recovering) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (pendingCalls || orchestrator.recovering || chats.isBusyForUpdate()) {
      preparingUpdate = false;
      orchestrator.startRecovery();
      return false;
    }
    return true;
  });
  rpc.handle("core:cancel-update", () => {
    preparingUpdate = false;
    orchestrator.startRecovery();
  });
  rpc.handle("core:shutdown", async () => {
    await dispose();
    setTimeout(() => app.exit(0), 50);
    return true;
  });
  rpc.onClose = () => { void dispose().finally(() => app.exit(0)); };
  app.on("before-quit", event => {
    if (stopping) return;
    event.preventDefault();
    void dispose().finally(() => app.exit(0));
  });
  await boot;
}

import { app, BrowserWindow, dialog, ipcMain, protocol, shell, nativeTheme, screen } from "electron";
import { mkdirSync, readFileSync, existsSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import type { AgentKind, ApprovalDecision, ProjectSettings, Theme, GeminiWebAccountId } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { AttachmentStore } from "./attachments";
import { Orchestrator } from "./orchestrator";
import { AppTray } from "./tray";
import { ensureOnlyInstance } from "./instance-guard";
import { mayOpenDocument, resolveLink } from "./file-links";
import { previewImage } from "./artifact-preview";
import type { AIStudioAction, AIStudioInput } from "../shared/aistudio";

// Data lives in %APPDATA%\AI_ChatterBox. Tests point AI_CHATTERBOX_DATA at scratch folders; the packaged
// app only honours it with an explicit --test-data flag, so a stray variable can never hide real data.
const testDataAllowed = !app.isPackaged || process.argv.includes("--test-data");
const testData = testDataAllowed ? process.env.AI_CHATTERBOX_DATA : undefined;
const dataDir = testData ?? join(app.getPath("appData"), "AI_ChatterBox");
/** e2e runs: keep the window off-screen so it can't be mistaken for the real app. */
const hideTestWindow = !!testData && process.env.AI_CHATTERBOX_HIDE === "1";
mkdirSync(dataDir, { recursive: true });
app.setPath("userData", join(dataDir, "electron"));
app.setAppUserModelId("net.damkina.aichatterbox");

// One instance per data folder: a second launch just shows the running window (e.g. from the tray).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on("second-instance", () => tray?.show());

// Attachment thumbnails are served from cbx://attachment/<id>.
protocol.registerSchemesAsPrivileged([{ scheme: "cbx", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win: BrowserWindow | null = null;
let quitting = false;
let tray: AppTray | undefined;
let store: Store;
let chats: ChatManager;
let attachments: AttachmentStore;

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function savedBounds(): Bounds {
  try {
    const b = JSON.parse(store.getSetting("window") ?? "") as Bounds;
    // Ignore positions on a monitor that is gone.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x !== undefined && b.y !== undefined && b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y;
    });
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch {
    return { width: 1320, height: 860 };
  }
}

function createWindow() {
  const b = hideTestWindow ? { x: -4000, y: 40, width: 1320, height: 860 } : savedBounds();
  const theme = (store.getSetting("theme") as Theme) ?? "dark";
  win = new BrowserWindow({
    ...b,
    minWidth: 900,
    minHeight: 560,
    title: `AI ChatterBox v${app.getVersion()}${testData ? " [자동 테스트 데이터]" : ""}`,
    skipTaskbar: hideTestWindow,
    backgroundColor: theme === "dark" ? "#0b0d12" : "#ffffff",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("page-title-updated", (event) => event.preventDefault());
  if ("maximized" in b && b.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  const persist = () => {
    // The store is closed during quit; never throw from a window event (Electron shows a blocking error box).
    if (!win || win.isDestroyed() || win.isMinimized() || quitting || hideTestWindow) return;
    try {
      const n = win.getNormalBounds();
      store.setSetting("window", JSON.stringify({ ...n, maximized: win.isMaximized() }));
    } catch {
      // ignore
    }
  };
  win.on("resize", persist);
  win.on("move", persist);
  win.on("close", (e) => {
    persist();
    // Closing the window while work runs keeps everything going in the tray.
    if (!quitting && tray?.hideIfBusy()) e.preventDefault();
  });
  // Links in chat open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "file:")) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  win.on("closed", () => (win = null));
}

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

function registerIpc() {
  // projects
  ipcMain.handle("projects:list", () => store.listProjects());
  ipcMain.handle("projects:create", (_e, input: { name: string; folder: string; settings: ProjectSettings }) => {
    if (!input.folder || !existsSync(input.folder)) throw new Error("작업 폴더가 없습니다.");
    return store.createProject(input.name.trim() || "새 프로젝트", input.folder, input.settings);
  });
  ipcMain.handle("projects:update", async (_e, id: number, patch) => {
    if (patch.folder !== undefined && (!patch.folder || !existsSync(patch.folder) || !statSync(patch.folder).isDirectory()))
      throw new Error("작업 폴더가 없습니다.");
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
  ipcMain.handle("projects:delete", async (_e, id: number) => {
    for (const c of store.listChats().filter((c) => c.projectId === id)) await chats.resetDrivers(c.id);
    store.deleteProject(id);
  });
  ipcMain.handle("projects:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "작업 폴더 선택", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // chats
  ipcMain.handle("chats:list", () => store.listChats());
  ipcMain.handle("chats:create", (_e, projectId: number) => store.createChat(projectId, "새 채팅"));
  ipcMain.handle("chats:update", (_e, id: number, patch) => chats.updateChat(id, patch));
  ipcMain.handle("chats:delete", async (_e, id: number) => {
    await orchestrator.stop(id);
    orchestrator.forget(id);
    await chats.deleteChat(id);
  });
  ipcMain.handle("chats:viewed", (_e, id: number) => {
    if (store.chat(id)?.unread) chats.updateChat(id, { unread: false });
  });
  ipcMain.handle("chats:consults", (_e, id: number) => store.listConsults(id));
  ipcMain.handle("chats:agents", (_e, id: number) => store.listAgents(id));
  ipcMain.handle("chats:events", (_e, id: number) => store.events(id));
  ipcMain.handle("chats:search", (_e, q: string) => (q.trim() ? store.searchChats(q.trim()) : []));
  ipcMain.handle("chats:send", (_e, id: number, text: string, attachmentIds: number[], delivery?: "now" | "next") => chats.send(id, text, attachmentIds, delivery));
  ipcMain.handle("chats:stop", (_e, id: number) => orchestrator.stop(id));
  ipcMain.handle("chats:pause", (_e, id: number) => orchestrator.pause(id));
  ipcMain.handle("chats:resume", (_e, id: number) => orchestrator.resume(id));
  ipcMain.handle("chats:command", (_e, id: number, name: string, arg: string) => orchestrator.command(id, name, arg));
  ipcMain.handle("chats:dismissInterrupted", (_e, id: number) => orchestrator.dismissInterrupted(id));
  ipcMain.handle("chats:approve", (_e, id: number, approvalId: string, decision: ApprovalDecision) =>
    chats.answerApproval(id, approvalId, decision),
  );
  ipcMain.handle("chats:answerAsk", (_e, id: number, askId: string, answer: string) => orchestrator.answerAsk(id, askId, answer));

  // attachments
  ipcMain.handle("artifacts:previewImage", (_e, chatId: number, href: string) => previewImage(store, attachments, chatId, href));
  ipcMain.handle("att:paths", (_e, chatId: number, paths: string[]) => paths.map((p) => attachments.fromPath(chatId, p)));
  ipcMain.handle("att:bytes", (_e, chatId: number, name: string, mime: string, bytes: Uint8Array) =>
    attachments.fromBytes(chatId, name, mime, bytes),
  );
  ipcMain.handle("att:pick", async (_e, chatId: number) => {
    const r = await dialog.showOpenDialog(win!, { title: "파일 첨부", properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths.map((p) => attachments.fromPath(chatId, p));
  });
  ipcMain.handle("att:remove", (_e, id: number) => store.deleteAttachment(id));

  // misc
  ipcMain.handle("cli:info", (_e, checkAuth?: boolean) => checkAuth ? chats.checkedCliInfo() : chats.cliInfo());
  ipcMain.handle("models:list", (_e, agent: AgentKind) => chats.models(agent));
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
    else if (action === "open") await shell.openExternal(studio.settings().baseUrl);
    else if (action === "export-antigravity") {
      const target = await dialog.showSaveDialog({ title: "Antigravity Custom Model Enabler 설정 저장", defaultPath: "chatterbox-aistudio-argon.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (target.filePath) writeFileSync(target.filePath, JSON.stringify(studio.antigravityConfig(), null, 2), "utf8");
    } else if (action !== "status") throw new Error("지원하지 않는 AI Studio 요청입니다.");
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
  ipcMain.handle("theme:get", () => (store.getSetting("theme") as Theme) ?? "dark");
  ipcMain.handle("theme:set", (_e, theme: Theme) => {
    store.setSetting("theme", theme);
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("usage:get", async (_e, wait = false) => {
    const refresh = chats.refreshUsage();
    if (wait === true) await refresh;
    return chats.usage();
  });
  ipcMain.handle("shell:openPath", async (_e, p: string) => {
    if (typeof p !== "string" || !existsSync(p)) throw new Error("파일이나 폴더를 찾을 수 없습니다.");
    if (!mayOpenDocument(p)) throw new Error("실행 파일은 탐색기에서 확인해 주세요.");
    const error = await shell.openPath(p);
    if (error) throw new Error(error);
  });
  ipcMain.handle("shell:link", async (_e, chatId: number, href: string, action: string) => {
    if (!["open", "reveal", "save"].includes(action)) throw new Error("지원하지 않는 파일 작업입니다.");
    const chat = store.chat(chatId);
    const project = chat && store.project(chat.projectId);
    if (!project) throw new Error("대화의 프로젝트를 찾을 수 없습니다.");
    const link = resolveLink(href, project.folder);
    if ("url" in link) {
      if (action !== "open") throw new Error("웹 파일은 브라우저에서 다운로드해 주세요.");
      await shell.openExternal(link.url);
      return {};
    }
    const path = link.path;
    if (!existsSync(path)) throw new Error(`파일이나 폴더를 찾을 수 없습니다: ${path}`);
    if (action === "reveal") shell.showItemInFolder(path);
    else if (action === "open") {
      if (!mayOpenDocument(path)) throw new Error("실행 파일은 ‘탐색기에서 보기’로 확인해 주세요.");
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    } else {
      if (!statSync(path).isFile()) throw new Error("폴더는 탐색기에서 복사해 주세요.");
      const options = { title: "다른 이름으로 저장", defaultPath: basename(path) };
      const selected = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (selected.canceled || !selected.filePath) return { canceled: true };
      if (resolve(selected.filePath).toLowerCase() !== resolve(path).toLowerCase()) copyFileSync(path, selected.filePath);
      return { path: selected.filePath };
    }
    return { path };
  });
}

let orchestrator: Orchestrator;

app.whenReady().then(async () => {
  // Never open the DB next to another running instance (e.g. 0.2.0, which has no single-instance lock).
  if (!(await ensureOnlyInstance(app.getPath("userData"), join(dataDir, "chatterbox.db")))) {
    app.exit(0);
    return;
  }
  store = new Store(join(dataDir, "chatterbox.db"));
  attachments = new AttachmentStore(join(dataDir, "attachments"), store);
  nativeTheme.themeSource = (store.getSetting("theme") as Theme) ?? "dark";
  protocol.handle("cbx", (req) => {
    const m = /^cbx:\/\/attachment\/(\d+)/.exec(req.url);
    const a = m ? store.attachment(Number(m[1])) : undefined;
    if (!a || !existsSync(a.path)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(a.path), { headers: { "content-type": a.mime } });
  });
  chats = new ChatManager(
    store,
    {
      agents: (chatId, list) => send("agents:updated", chatId, list),
      event: (e) => send("chat:event", e),
      chat: (c) => {
        send("chat:updated", c);
        tray?.chatChanged(c);
      },
      consult: (c) => send("consult:updated", c),
      usage: (u) => send("usage", u),
      webLogin: (status) => send("gemini:web-login", status),
    },
    dataDir,
    // claude.exe/codex.exe run this script with our exe as Node; packaged, it is unpacked next to app.asar.
    join(import.meta.dirname, "bridge-mcp.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1"),
  );
  orchestrator = new Orchestrator(chats);
  await chats.start();
  registerIpc();
  tray = new AppTray({
    window: () => (win && !win.isDestroyed() ? win : null),
    createWindow,
    chats: () => store.listChats(),
    quit: () => app.quit(),
  });
  tray.start();
  createWindow();
});

// Stop every CLI process (stdin EOF, then taskkill /T /F) before quitting.
app.on("before-quit", (e) => {
  if (quitting) return;
  // Remember the window size before the store closes.
  if (win && !win.isDestroyed() && !win.isMinimized())
    store.setSetting("window", JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  quitting = true;
  tray?.destroy();
  e.preventDefault();
  orchestrator.judge
    .dispose()
    .catch(() => undefined)
    .then(() => chats.dispose())
    .catch(() => undefined)
    .finally(() => {
      try {
        store.close();
      } catch {
        // already closed
      }
      app.quit();
    });
});

// The window only really closes when nothing is running (otherwise it hides to the tray).
app.on("window-all-closed", () => app.quit());

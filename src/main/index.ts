import { app, BrowserWindow, dialog, ipcMain, protocol, shell, nativeTheme, screen } from "electron";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, ApprovalDecision, ModelOption, ProjectSettings, Theme } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";
import { AttachmentStore } from "./attachments";
import { listClaudeModels } from "./drivers/claude";
import { Orchestrator } from "./orchestrator";
import { AppTray } from "./tray";
import { ensureOnlyInstance } from "./instance-guard";

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
const modelCache = new Map<AgentKind, ModelOption[]>();

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
    title: testData ? "AI_ChatterBox [자동 테스트 데이터]" : "AI_ChatterBox",
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
    const before = store.project(id);
    const p = store.updateProject(id, patch);
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
  ipcMain.handle("chats:events", (_e, id: number) => store.events(id));
  ipcMain.handle("chats:search", (_e, q: string) => (q.trim() ? store.searchChats(q.trim()) : []));
  ipcMain.handle("chats:send", (_e, id: number, text: string, attachmentIds: number[]) => chats.send(id, text, attachmentIds));
  ipcMain.handle("chats:stop", (_e, id: number) => orchestrator.stop(id));
  ipcMain.handle("chats:resume", (_e, id: number) => orchestrator.resume(id));
  ipcMain.handle("chats:dismissInterrupted", (_e, id: number) => orchestrator.dismissInterrupted(id));
  ipcMain.handle("chats:approve", (_e, id: number, approvalId: string, decision: ApprovalDecision) =>
    chats.answerApproval(id, approvalId, decision),
  );
  ipcMain.handle("chats:answerAsk", (_e, id: number, askId: string, answer: string) => orchestrator.answerAsk(id, askId, answer));

  // attachments
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
  ipcMain.handle("cli:info", () => chats.cliInfo());
  ipcMain.handle("models:list", async (_e, agent: AgentKind) => {
    const cached = modelCache.get(agent);
    if (cached) return cached;
    let list: ModelOption[];
    if (agent === "codex") list = await chats.codex().models();
    else
      list = (await listClaudeModels(chats.claudeExe(), dataDir)).map((m) => ({
        id: m.value,
        label: m.displayName,
        isDefault: m.value === "opus",
      }));
    modelCache.set(agent, list);
    return list;
  });
  ipcMain.handle("theme:get", () => (store.getSetting("theme") as Theme) ?? "dark");
  ipcMain.handle("theme:set", (_e, theme: Theme) => {
    store.setSetting("theme", theme);
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("usage:get", () => {
    void chats
      .codex()
      .readUsage()
      .catch(() => undefined);
    void chats.refreshClaudeUsage();
    return chats.usage();
  });
  ipcMain.handle("shell:openPath", (_e, p: string) => shell.openPath(p));
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
      event: (e) => send("chat:event", e),
      chat: (c) => {
        send("chat:updated", c);
        tray?.chatChanged(c);
      },
      consult: (c) => send("consult:updated", c),
      usage: (u) => send("usage", u),
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
      tray?.destroy();
      app.quit();
    });
});

// The window only really closes when nothing is running (otherwise it hides to the tray).
app.on("window-all-closed", () => app.quit());

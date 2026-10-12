import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, ApprovalDecision } from "../shared/types";
import { Store } from "./db";
import { SessionManager } from "./sessions";

// Data lives in %APPDATA%\AI_ChatterBox unless overridden (the e2e script uses a scratch folder).
const dataDir = process.env.AI_CHATTERBOX_DATA ?? join(app.getPath("appData"), "AI_ChatterBox");
mkdirSync(dataDir, { recursive: true });
app.setPath("userData", join(dataDir, "electron"));

let win: BrowserWindow | null = null;
let store: Store;
let sessions: SessionManager;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    title: "AI_ChatterBox",
    backgroundColor: "#1b1d22",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  win.on("closed", () => (win = null));
}

function registerIpc() {
  ipcMain.handle("workspaces:list", () => store.listWorkspaces());
  ipcMain.handle("workspaces:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "워크스페이스 폴더 선택", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    return store.addWorkspace(r.filePaths[0]);
  });
  // Used by the e2e script, which can't drive the native folder dialog.
  ipcMain.handle("workspaces:add", (_e, path: string) => store.addWorkspace(path));
  ipcMain.handle("sessions:list", (_e, workspaceId: number) => store.listSessions(workspaceId));
  ipcMain.handle("sessions:create", (_e, workspaceId: number, agent: AgentKind) => sessions.create(workspaceId, agent));
  ipcMain.handle("sessions:events", (_e, sessionId: number) => store.events(sessionId));
  ipcMain.handle("sessions:send", (_e, sessionId: number, text: string) => sessions.send(sessionId, text));
  ipcMain.handle("sessions:stop", (_e, sessionId: number) => sessions.stop(sessionId));
  ipcMain.handle("sessions:approve", (_e, sessionId: number, approvalId: string, decision: ApprovalDecision) =>
    sessions.answerApproval(sessionId, approvalId, decision),
  );
  ipcMain.handle("cli:info", () => sessions.cliInfo());
}

app.whenReady().then(async () => {
  store = new Store(join(dataDir, "chatterbox.db"));
  sessions = new SessionManager(
    store,
    {
      event: (sessionId, event) => win?.webContents.send("session:event", sessionId, event),
      sessionUpdated: (session) => win?.webContents.send("session:updated", session),
    },
    dataDir,
    join(import.meta.dirname, "approver-mcp.js"),
  );
  await sessions.start();
  registerIpc();
  createWindow();
});

// Stop every CLI process (stdin EOF, then taskkill /T /F) before quitting.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  sessions
    .dispose()
    .catch(() => undefined)
    .finally(() => {
      store.close();
      app.quit();
    });
});

app.on("window-all-closed", () => app.quit());

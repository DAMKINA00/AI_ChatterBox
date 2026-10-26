import { app, BrowserWindow, dialog, ipcMain, protocol, shell, nativeTheme, screen, Notification } from "electron";
import { execFile } from "node:child_process";
import updaterPackage from "electron-updater";
import { mkdirSync, readFileSync, existsSync, statSync, copyFileSync, writeFileSync, cpSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import type { AttachmentRef, Chat, Theme } from "../shared/types";
import { AppTray } from "./tray";
import { ensureOnlyInstance } from "./instance-guard";
import { mayOpenDocument, resolveLink } from "./file-links";
import { launchCore } from "./core-launch";
import { runCore } from "./core";
import type { CoreRpc } from "./core-rpc";
import { AppUpdates } from "./app-updates";
import { UsageCompanion } from "./usage-companion";
import { suiteMenu } from "./suite-menu";

const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const coreMode = process.argv.includes("--agent-core");
const testDataAllowed = !app.isPackaged || process.argv.includes("--test-data");
const testData = testDataAllowed ? (coreMode ? argument("core-data") : process.env.AI_CHATTERBOX_DATA) : undefined;
const dataDir = testData ?? join(app.getPath("appData"), "AI_ChatterBox");
const hideTestWindow = !!testData && process.env.AI_CHATTERBOX_HIDE === "1";
mkdirSync(dataDir, { recursive: true });
// Google account partitions stay in the original profile; only the chat UI gets a separate profile.
app.setPath("userData", join(dataDir, coreMode ? "electron" : "ui-electron"));
app.setAppUserModelId(coreMode ? "net.damkina.aichatterbox.core" : "net.damkina.aichatterbox");
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => tray?.show());
protocol.registerSchemesAsPrivileged([{ scheme: "cbx", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win: BrowserWindow | null = null;
let quitting = false;
let tray: AppTray | undefined;
let core: CoreRpc | undefined;
let chatCache: Chat[] = [];
let windowSetting: string | undefined;
let usage: UsageCompanion | undefined;
let updates: AppUpdates | undefined;
let applyingUpdate = false;
let startupSetting: boolean | undefined;

const reportDesktopError = (error: unknown) => dialog.showErrorBox("AI ChatterBox", error instanceof Error ? error.message : String(error));

function syncStartup(enabled: boolean) {
  if (startupSetting === enabled || !app.isPackaged || testData) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--minimized"] });
  startupSetting = enabled;
  // Only retire the old monitor's own Run entry; account/profile settings remain untouched.
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $v=(Get-ItemProperty -LiteralPath $k -Name AIUsageMonitor -ErrorAction SilentlyContinue).AIUsageMonitor; if($v -match '(?i)(?:^|[\\\\\" ])AIUsageMonitor\\.exe(?:\"| |$)'){Remove-ItemProperty -LiteralPath $k -Name AIUsageMonitor -ErrorAction Stop}"],
    { windowsHide: true }, error => { if (error) reportDesktopError(new Error("기존 사용량 모니터의 시작 프로그램 항목을 정리하지 못했습니다. Windows 시작 프로그램 설정에서 AIUsageMonitor를 꺼 주세요.")); });
}

async function cancelUpdate() {
  applyingUpdate = false;
  await core?.call("core:cancel-update").catch(() => undefined);
  await usage?.start().catch(reportDesktopError);
}

async function installUpdate() {
  if (applyingUpdate || updates?.state.status !== "ready") return;
  applyingUpdate = true;
  try {
    if (!await core?.call("core:prepare-update")) throw new Error("진행 중인 작업이나 승인 요청이 있습니다. 작업이 끝난 뒤 업데이트를 적용해 주세요.");
    await usage?.stop();
    await persistBounds();
    if (!updates.install()) await cancelUpdate();
  } catch (error) {
    await cancelUpdate();
    reportDesktopError(error);
  }
}

function startDesktopServices() {
  const { autoUpdater } = updaterPackage;
  const allowed = app.isPackaged && !testData && process.platform === "win32";
  usage = new UsageCompanion({
    exe: join(process.resourcesPath, "usage-monitor", "AIUsageMonitor.exe"), settingsFile: join(dataDir, "desktop.json"), allowed,
    changed: snapshot => { tray?.refresh(); if (snapshot.running && snapshot.state) syncStartup(snapshot.state.startup); },
    notification: notice => { if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.message }).show(); },
  });
  updates = new AppUpdates(autoUpdater, {
    version: app.getVersion(), enabled: allowed && !process.env.PORTABLE_EXECUTABLE_DIR,
    changed: state => { tray?.refresh(); if (state.status === "error" && applyingUpdate && !quitting) void cancelUpdate(); },
    downloaded: state => {
      if (Notification.isSupported()) {
        const notice = new Notification({ title: `AI ChatterBox ${state.version} 업데이트 준비 완료`, body: "작업이 끝나면 트레이의 ‘업데이트하고 재시작’을 눌러 적용하세요." });
        notice.on("click", () => tray?.show()); notice.show();
      }
    },
  });
  tray = new AppTray({
    window: () => win && !win.isDestroyed() ? win : null, createWindow, chats: () => chatCache, quit: () => app.quit(),
    keepAlive: () => !!usage?.snapshot().enabled || !!usage?.snapshot().running,
    extraMenu: () => suiteMenu(usage!.snapshot(), updates!.state, {
      enable: enabled => { void usage!.setEnabled(enabled).then(() => enabled ? usage!.command("show") : undefined).catch(reportDesktopError); },
      command: (name, value) => { void usage!.command(name, value).catch(reportDesktopError); },
      check: () => { void updates!.check(); }, install: () => { void installUpdate(); },
    }),
  });
  tray.start();
  updates.start();
  void usage.start().then(() => usage!.snapshot().running ? usage!.command("show") : undefined).catch(() => undefined);
}

interface Bounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }
function savedBounds(): Bounds {
  try {
    const b = JSON.parse(windowSetting ?? "") as Bounds;
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return b.x !== undefined && b.y !== undefined && b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y;
    });
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch { return { width: 1320, height: 860 }; }
}

function persistBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || hideTestWindow) return;
  const bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  windowSetting = JSON.stringify(bounds);
  return core?.call("window:save", [bounds], 5_000).catch(() => undefined);
}

function createWindow() {
  const b = hideTestWindow ? { x: -4000, y: 40, width: 1320, height: 860 } : savedBounds();
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 560,
    title: `AI ChatterBox v${app.getVersion()}${testData ? " [자동 테스트 데이터]" : ""}`,
    skipTaskbar: hideTestWindow, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d12" : "#ffffff",
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false },
  });
  win.on("page-title-updated", event => event.preventDefault());
  if ("maximized" in b && b.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  win.on("resize", () => { if (!quitting) void persistBounds(); });
  win.on("move", () => { if (!quitting) void persistBounds(); });
  win.on("close", event => {
    void persistBounds();
    if (!quitting && tray?.hideIfBusy()) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? "file:")) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  win.on("closed", () => (win = null));
}

function registerUi(channels: string[], rpc: CoreRpc) {
  const internal = new Set(["attachment:info", "window:save", "files:resolve-link", "aistudio:export-config"]);
  const local = new Set(["theme:set", "aistudio"]);
  for (const channel of channels.filter(channel => !internal.has(channel) && !local.has(channel))) {
    ipcMain.handle(channel, async (_event, ...args) => {
      const result = await rpc.call(channel, args);
      if (["chats:create", "chats:delete", "projects:delete"].includes(channel)) chatCache = await rpc.call("chats:list");
      return result;
    });
  }
  ipcMain.handle("projects:pickFolder", async () => {
    const result = await dialog.showOpenDialog(win!, { title: "작업 폴더 선택", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("att:pick", async (_event, chatId: number) => {
    const result = await dialog.showOpenDialog(win!, { title: "파일 첨부", properties: ["openFile", "multiSelections"] });
    return result.canceled ? [] : rpc.call("att:paths", [chatId, result.filePaths]);
  });
  ipcMain.handle("theme:set", async (_event, theme: Theme) => {
    await rpc.call("theme:set", [theme]);
    nativeTheme.themeSource = theme;
  });
  ipcMain.handle("aistudio", async (_event, action: string, input = {}) => {
    if (action === "open") {
      const status = await rpc.call("aistudio", ["launch"]);
      await shell.openExternal(status.settings.baseUrl);
      return status;
    }
    if (action === "export-antigravity") {
      const target = await dialog.showSaveDialog(win!, { title: "Antigravity Custom Model Enabler 설정 저장", defaultPath: "chatterbox-aistudio-argon.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (target.filePath) writeFileSync(target.filePath, JSON.stringify(await rpc.call("aistudio:export-config"), null, 2), "utf8");
      return rpc.call("aistudio", ["status"]);
    }
    return rpc.call("aistudio", [action, input]);
  });
  ipcMain.handle("shell:openPath", async (_event, path: string) => {
    if (typeof path !== "string" || !existsSync(path)) throw new Error("파일이나 폴더를 찾을 수 없습니다.");
    if (!mayOpenDocument(path)) throw new Error("실행 파일은 탐색기에서 확인해 주세요.");
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("shell:link", async (_event, chatId: number, href: string, action: string) => {
    if (!["open", "reveal", "save"].includes(action)) throw new Error("지원하지 않는 파일 작업입니다.");
    const link = await rpc.call<ReturnType<typeof resolveLink>>("files:resolve-link", [chatId, href]);
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
      const selected = await dialog.showSaveDialog(win!, { title: "다른 이름으로 저장", defaultPath: basename(path) });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      if (resolve(selected.filePath).toLowerCase() !== resolve(path).toLowerCase()) copyFileSync(path, selected.filePath);
      return { path: selected.filePath };
    }
    return { path };
  });
}

app.whenReady().then(async () => {
  if (coreMode) {
    const pipe = argument("core-pipe"), token = argument("core-token");
    if (!pipe || !token || token.length !== 64 || (!testData && resolve(argument("core-data") ?? "") !== resolve(dataDir))) throw new Error("잘못된 코어 실행 요청입니다.");
    await runCore(dataDir, pipe, token, !!testData);
    return;
  }
  // Old versions still own the legacy core profile and must finish before we open the same DB.
  if (!(await ensureOnlyInstance(join(dataDir, "electron"), join(dataDir, "chatterbox.db")))) return app.exit(0);
  const oldStorage = join(dataDir, "electron", "Local Storage"), uiStorage = join(dataDir, "ui-electron", "Local Storage");
  if (existsSync(oldStorage) && !existsSync(uiStorage)) cpSync(oldStorage, uiStorage, { recursive: true });
  for (;;) {
    try {
      const rpc = await launchCore(dataDir, !!testData);
      core = rpc;
      const boot = await rpc.call("core:boot", [], 120_000);
      if (boot.version !== app.getVersion()) throw new Error("화면과 코어 버전이 다릅니다.");
      if (testData) Object.assign(globalThis, { __chatterboxCoreTest: {
        pid: boot.pid, elevated: boot.elevated,
        prepareUpdate: () => rpc.call("core:prepare-update"), cancelUpdate: () => rpc.call("core:cancel-update"),
      } });
      windowSetting = boot.window;
      nativeTheme.themeSource = boot.theme as Theme;
      chatCache = boot.chats;
      const events = new Set(["chat:event", "chat:updated", "consult:updated", "agents:updated", "usage", "gemini:web-login"]);
      rpc.onEvent = (channel, args) => {
        if (!events.has(channel)) return;
        if (channel === "chat:updated") {
          const chat = args[0] as Chat;
          chatCache = chatCache.some(value => value.id === chat.id) ? chatCache.map(value => value.id === chat.id ? chat : value) : [chat, ...chatCache];
          tray?.chatChanged(chat);
        }
        win?.webContents.send(channel, ...args);
      };
      rpc.onClose = () => {
        if (quitting) return;
        dialog.showErrorBox("관리자 코어 연결 종료", "에이전트 코어와 연결이 끊어졌습니다. 앱을 다시 실행하면 대화에서 이어서 진행할 수 있습니다.");
        app.quit();
      };
      registerUi(boot.channels, rpc);
      protocol.handle("cbx", async request => {
        const match = /^cbx:\/\/attachment\/(\d+)/.exec(request.url);
        const attachment = match ? await rpc.call<AttachmentRef | undefined>("attachment:info", [Number(match[1])]) : undefined;
        if (!attachment || !existsSync(attachment.path)) return new Response("not found", { status: 404 });
        return new Response(readFileSync(attachment.path), { headers: { "content-type": attachment.mime } });
      });
      startDesktopServices();
      if (testData || !process.argv.includes("--minimized")) createWindow();
      break;
    } catch (error) {
      core?.close(); core = undefined;
      const result = await dialog.showMessageBox({ type: "error", title: "관리자 코어 실행", message: error instanceof Error ? error.message : String(error), buttons: ["다시 시도", "종료"], defaultId: 0, cancelId: 1 });
      if (result.response !== 0) return app.quit();
    }
  }
}).catch(error => {
  if (!coreMode) dialog.showErrorBox("ChatterBox 시작 실패", error instanceof Error ? error.message : String(error));
  app.exit(1);
});

app.on("before-quit", event => {
  if (coreMode || quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    try { await usage?.stop(); }
    catch (error) { quitting = false; reportDesktopError(error); return; }
    updates?.stop();
    tray?.destroy();
    await persistBounds();
    await core?.call("core:shutdown", [], 30_000).catch(() => undefined);
    core?.close();
    app.quit();
  })();
});
app.on("window-all-closed", () => { if (!coreMode && !usage?.snapshot().enabled && !usage?.snapshot().running) app.quit(); });

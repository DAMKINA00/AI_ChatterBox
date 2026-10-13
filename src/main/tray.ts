// System tray: closing the window while work is running keeps the app (and the CLIs) alive here.
// Real quit is from the tray menu or 파일 > 종료, with a confirmation when work would be cut off.
// Tray notifications tell the user when a chat finishes or needs them.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, Tray } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Chat } from "../shared/types";
import { ChatNotifications, type ChatNotice } from "./chat-notifications";

export interface TrayHost {
  window(): BrowserWindow | null;
  createWindow(): void;
  chats(): Chat[];
  quit(): void;
}

const busy = (c: Chat) => c.status === "working" || c.status === "approval";

export class AppTray {
  private tray?: Tray;
  private notifications: ChatNotifications;
  private hiddenNoticeShown = false;

  constructor(private host: TrayHost) {
    this.notifications = new ChatNotifications((chat, notice) => this.notify(chat, notice), host.chats());
  }

  private icon() {
    const file = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build", "icon.png");
    return existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  }

  start() {
    this.tray = new Tray(this.icon().resize({ width: 16, height: 16 }));
    this.tray.on("click", () => this.show());
    this.refresh();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "파일", submenu: [{ label: "창 닫기", accelerator: "Ctrl+W", click: () => this.host.window()?.close() }, { type: "separator" }, { label: "종료", accelerator: "Ctrl+Q", click: () => void this.confirmQuit() }] },
        {
          label: "보기",
          submenu: [
            { role: "reload", label: "새로 고침" },
            { role: "toggleDevTools", label: "개발자 도구" },
            { type: "separator" },
            { role: "zoomIn", label: "크게" },
            { role: "zoomOut", label: "작게" },
            { role: "resetZoom", label: "원래 크기" },
          ],
        },
      ]),
    );
  }

  busyCount() {
    return this.host.chats().filter(busy).length;
  }

  /** Keep the tray tooltip/menu current and notify on finish / needs-user transitions. */
  chatChanged(chat: Chat) {
    this.refresh();
    this.notifications.chatChanged(chat);
  }

  private notify(chat: Chat, notice: ChatNotice) {
    const win = this.host.window();
    const away = !win || !win.isVisible() || !win.isFocused();
    if ((notice === "error" && !away) || !Notification.isSupported()) return;
    const body = {
      approval: "마스터가 작업 승인 또는 답변을 기다립니다.",
      reminder: "1분 동안 확인되지 않은 요청이 있습니다. 마스터 대화에서 확인해 주세요.",
      done: "마스터가 전체 작업과 최종 취합을 완료했습니다.",
      error: "작업 중 오류가 났습니다.",
    }[notice];
    const n = new Notification({ title: chat.title, body, icon: this.icon() });
    n.on("click", () => {
      this.show();
      this.host.window()?.webContents.send("select-chat", chat.id);
    });
    n.show();
  }

  private refresh() {
    if (!this.tray) return;
    const n = this.busyCount();
    this.tray.setToolTip(n ? `AI_ChatterBox · 작업 중 ${n}개` : "AI_ChatterBox");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: n ? `작업 중 ${n}개` : "진행 중인 작업 없음", enabled: false },
        { type: "separator" },
        { label: "열기", click: () => this.show() },
        { label: "종료", click: () => void this.confirmQuit() },
      ]),
    );
  }

  show() {
    let win = this.host.window();
    if (!win) {
      this.host.createWindow();
      win = this.host.window();
    }
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
  }

  /** Window close while working: hide to the tray instead of quitting. Returns true if handled. */
  hideIfBusy(): boolean {
    if (this.busyCount() === 0) return false;
    this.host.window()?.hide();
    if (!this.hiddenNoticeShown && Notification.isSupported()) {
      this.hiddenNoticeShown = true;
      new Notification({ title: "AI_ChatterBox", body: "작업이 끝날 때까지 트레이에서 계속 실행됩니다.", icon: this.icon() }).show();
    }
    return true;
  }

  async confirmQuit() {
    if (this.busyCount() > 0) {
      const win = this.host.window();
      const opts = {
        type: "warning" as const,
        buttons: ["종료", "취소"],
        defaultId: 1,
        cancelId: 1,
        title: "AI_ChatterBox",
        message: "진행 중인 작업이 중단됩니다.",
        detail: "다시 실행하면 채팅의 \"이어서 진행\"으로 계속할 수 있습니다. 종료할까요?",
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return;
    }
    this.host.quit();
  }

  destroy() {
    this.notifications.destroy();
    this.tray?.destroy();
    this.tray = undefined;
  }
}

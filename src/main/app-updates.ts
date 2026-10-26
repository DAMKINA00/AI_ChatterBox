import type { AppUpdateState } from "../shared/app-updates";

export interface UpdaterBackend {
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

export interface AppUpdatesHost {
  version: string;
  enabled: boolean;
  changed(state: Readonly<AppUpdateState>): void;
  downloaded(state: Readonly<AppUpdateState>): void;
}

export const APP_UPDATE_OPTIONS = Object.freeze({
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  allowDowngrade: false,
});

const INITIAL_CHECK_DELAY = 30_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1_000;

const versionFrom = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
};

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "업데이트 확인에 실패했습니다.";
  if (!message || /https?:\/\/|\b(?:authorization|bearer|cookie|password|token|api[-_ ]?key)\b/i.test(message)) {
    return "업데이트 확인에 실패했습니다.";
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

export class AppUpdates {
  private current: AppUpdateState;
  private firstTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private running = false;
  private generation = 0;
  private notifiedVersion?: string;

  private readonly onCheckingForUpdate = () => {
    this.publish({ status: "checking" }, ["version", "percent", "checkedAt", "error"]);
  };
  private readonly onUpdateAvailable = (info: unknown) => {
    const version = versionFrom(info);
    this.publish({ status: "downloading", ...(version ? { version } : {}) }, ["version", "percent", "checkedAt", "error"]);
  };
  private readonly onUpdateNotAvailable = () => {
    this.publish({ status: "idle", checkedAt: Date.now() }, ["version", "percent", "error"]);
  };
  private readonly onDownloadProgress = (progress: unknown) => {
    const percent = progress && typeof progress === "object" ? (progress as { percent?: unknown }).percent : undefined;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    this.publish({ status: "downloading", percent: Math.max(0, Math.min(100, percent)) }, ["error"]);
  };
  private readonly onUpdateDownloaded = (info: unknown) => {
    const version = versionFrom(info) ?? this.current.version;
    this.publish({ status: "ready", ...(version ? { version } : {}), percent: 100 }, ["error", "checkedAt"]);
    const key = version ?? "";
    if (this.notifiedVersion === key) return;
    this.notifiedVersion = key;
    this.host.downloaded(this.snapshot());
  };
  private readonly onError = (error: unknown) => {
    this.publish({ status: "error", checkedAt: Date.now(), error: safeError(error) });
  };

  constructor(private readonly backend: UpdaterBackend, private readonly host: AppUpdatesHost) {
    backend.autoDownload = APP_UPDATE_OPTIONS.autoDownload;
    backend.autoInstallOnAppQuit = APP_UPDATE_OPTIONS.autoInstallOnAppQuit;
    backend.allowPrerelease = APP_UPDATE_OPTIONS.allowPrerelease;
    backend.allowDowngrade = APP_UPDATE_OPTIONS.allowDowngrade;
    this.current = { status: host.enabled ? "idle" : "disabled", currentVersion: host.version };
  }

  snapshot(): Readonly<AppUpdateState> {
    return Object.freeze({ ...this.current });
  }

  get state(): Readonly<AppUpdateState> {
    return this.snapshot();
  }

  start() {
    if (!this.host.enabled || this.running) return;
    this.running = true;
    this.backend.on("checking-for-update", this.onCheckingForUpdate);
    this.backend.on("update-available", this.onUpdateAvailable);
    this.backend.on("update-not-available", this.onUpdateNotAvailable);
    this.backend.on("download-progress", this.onDownloadProgress);
    this.backend.on("update-downloaded", this.onUpdateDownloaded);
    this.backend.on("error", this.onError);
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.check();
      if (!this.running) return;
      this.interval = setInterval(() => void this.check(), CHECK_INTERVAL);
      this.interval.unref?.();
    }, INITIAL_CHECK_DELAY);
    this.firstTimer.unref?.();
  }

  check(): Promise<void> {
    if (!this.host.enabled || this.current.status === "ready" || this.current.status === "downloading" || this.current.status === "installing") return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.publish({ status: "checking" }, ["version", "percent", "checkedAt", "error"]);
    let request: Promise<unknown>;
    try {
      request = Promise.resolve(this.backend.checkForUpdates());
    } catch (error) {
      request = Promise.reject(error);
    }
    const pending = request.then(
      () => {
        if (generation === this.generation && this.current.status === "checking") this.publish({ status: "idle", checkedAt: Date.now() }, ["version", "percent", "error"]);
      },
      (error: unknown) => {
        if (generation === this.generation && !["ready", "downloading", "installing"].includes(this.current.status)) this.publish({ status: "error", checkedAt: Date.now(), error: safeError(error) });
      },
    ).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  install(): boolean {
    if (!this.host.enabled || this.current.status !== "ready") return false;
    this.publish({ status: "installing" });
    try {
      this.backend.quitAndInstall(true, true);
      return true;
    } catch (error) {
      this.publish({ status: "error", checkedAt: Date.now(), error: safeError(error) });
      return false;
    }
  }

  stop() {
    this.running = false;
    this.generation++;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.interval) clearInterval(this.interval);
    this.firstTimer = undefined;
    this.interval = undefined;
    this.backend.removeListener("checking-for-update", this.onCheckingForUpdate);
    this.backend.removeListener("update-available", this.onUpdateAvailable);
    this.backend.removeListener("update-not-available", this.onUpdateNotAvailable);
    this.backend.removeListener("download-progress", this.onDownloadProgress);
    this.backend.removeListener("update-downloaded", this.onUpdateDownloaded);
    this.backend.removeListener("error", this.onError);
  }

  private publish(patch: Partial<AppUpdateState>, clear: (keyof AppUpdateState)[] = []) {
    const next = { ...this.current };
    for (const key of clear) delete next[key];
    Object.assign(next, patch);
    this.current = next;
    this.host.changed(this.snapshot());
  }
}

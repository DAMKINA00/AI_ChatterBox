import { BrowserWindow, session } from "electron";
import { join } from "node:path";
import type { GeminiWebAccountId, GeminiWebStatus, GeminiWebUsage } from "../../shared/types";
import { SNAPSHOT_SCRIPT, USAGE_SCRIPT, GEMINI_ORIGIN, buttonScript, webUsage, webUsagePage, webConversationUrl, webConversationId, type WebSnapshot } from "./gemini-web-protocol";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const allowedNavigation = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (["gemini.google.com", "accounts.google.com", "myaccount.google.com"].includes(u.hostname)
      || (["www.google.com", "www.google.co.kr", "accounts.youtube.com"].includes(u.hostname) && /^\/accounts\/(SetSID|CheckCookie)$/.test(u.pathname))
      || (u.hostname === "www.google.com" && u.pathname.startsWith("/sorry/")));
  } catch { return false; }
};
/** One isolated persistent Google account. No remote debugging listener or shared app preload. */
export class GeminiWebBrowser {
  private win?: BrowserWindow;
  private authWindows = new Set<BrowserWindow>();
  private opening?: Promise<BrowserWindow>;
  private owner?: string;
  private disposed = false;
  private usageWindow?: BrowserWindow;
  private studioWindow?: BrowserWindow;
  private usageReading?: Promise<GeminiWebUsage>;
  private verificationRequired = false;
  private lastUsageReadAt = 0;
  private loginWatch?: { win: BrowserWindow; timer?: ReturnType<typeof setTimeout>; returning?: boolean };
  private last: GeminiWebStatus = { accountId: "gemini-1", state: "closed", message: "로그인 상태를 확인하세요.", checkedAt: 0, usage: webUsage([]) };
  constructor(private dataDir: string, private onUsage: (usage: GeminiWebUsage) => void, readonly accountId: GeminiWebAccountId = "gemini-1", usage?: GeminiWebUsage,
    private onLogin: (status: GeminiWebStatus) => void = () => {}) {
    this.last = { ...this.last, accountId, message: `웹 ${this.accountName}에 로그인하세요.`, usage: usage ?? this.last.usage };
  }
  private get accountName() { return `계정 ${this.accountId.slice(7)}`; }
  get busy() { return !!this.owner; }

  async imageBytes(owner: string, url: string, signal: AbortSignal): Promise<string> {
    if (this.owner !== owner || !this.win || this.win.isDestroyed()) throw new Error("웹 이미지 소유 작업을 확인하지 못했습니다.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".googleusercontent.com") || parsed.username || parsed.password) throw new Error("지원하지 않는 웹 이미지 주소입니다.");
    const response = await this.win.webContents.session.fetch(url, { signal, redirect: "error" });
    if (!response.ok || !/^image\/(png|jpeg|webp)/i.test(response.headers.get("content-type") ?? "")) throw new Error("웹 이미지 다운로드를 확인하지 못했습니다.");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 32 * 1024 * 1024) throw new Error("웹 이미지가 32MB를 초과합니다.");
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString("base64");
  }

  status() { return this.last; }
  /** Same isolated account partition as Gemini Web; authentication material stays in the main process. */
  async studioState(show = true): Promise<{ email: string; cookies: Record<string, unknown>[]; origins: never[] }> {
    if (this.disposed) throw new Error("웹 계정 연결이 종료되었습니다.");
    if (!this.studioWindow || this.studioWindow.isDestroyed()) {
      const ses = session.fromPath(join(this.dataDir, "web-accounts", this.accountId));
      const win = new BrowserWindow({ width: 1100, height: 850, show: false, autoHideMenuBar: true,
        title: `ChatterBox · AI Studio ${this.accountName}`, webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true } });
      this.studioWindow = win;
      const allowed = (raw: string) => { try { const u = new URL(raw); return u.protocol === "https:" && ["aistudio.google.com", "accounts.google.com", "myaccount.google.com", "consent.google.com"].includes(u.hostname); } catch { return false; } };
      win.webContents.on("will-navigate", (e, url) => { if (!allowed(url)) e.preventDefault(); });
      win.webContents.on("will-redirect", (e, url) => { if (!allowed(url)) e.preventDefault(); });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.on("page-title-updated", e => e.preventDefault());
      await win.loadURL("https://aistudio.google.com/?authuser=0");
    }
    const win = this.studioWindow;
    if (show && !win.isVisible()) { win.show(); win.focus(); }
    await delay(750);
    if (win.isDestroyed() || !win.webContents.getURL().startsWith("https://aistudio.google.com/")) throw new Error("같은 Google 계정으로 AI Studio 로그인을 완료한 뒤 ‘AI Studio 동기화’를 다시 누르세요.");
    const studioUrl = new URL(win.webContents.getURL());
    const authUser = studioUrl.searchParams.get("authuser") ?? /\/u\/(\d+)(?:\/|$)/.exec(studioUrl.pathname)?.[1] ?? "0";
    if (authUser !== "0") throw new Error("각 Web 계정 창의 첫 번째 Google 계정을 사용하세요. 다른 계정은 Web 관리에서 별도 계정 카드로 로그인하세요.");
    const email: string = await win.webContents.executeJavaScript(`(() => {
      const elements = document.querySelectorAll('a[href*="SignOutOptions"],a[href*="accounts.google.com"][aria-label],button[aria-label*="@"],button[data-email]');
      for (const e of elements) {
        const label = [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-email')].filter(Boolean).join(' ');
        const match = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i);
        if (match) return match[0].toLowerCase();
      }
      return '';
    })()`);
    if (!email) throw new Error("AI Studio에서 로그인 계정을 확인하지 못했습니다. 계정 아이콘과 이용 동의를 확인한 뒤 다시 동기화하세요.");
    const all = await win.webContents.session.cookies.get({});
    const cookies = all.filter(c => /(^|\.)google\.com$/.test((c.domain ?? "").replace(/^\./, "")))
      .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expirationDate ?? -1, httpOnly: c.httpOnly, secure: c.secure,
        sameSite: c.sameSite === "strict" ? "Strict" : c.sameSite === "lax" ? "Lax" : "None" }));
    if (!["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"].every(name => cookies.some(c => c.name === name))) throw new Error("Google 인증 세션이 만료되었습니다. 제미나이 웹 계정 관리에서 다시 로그인하세요.");
    if (!show) win.hide();
    return { email, cookies, origins: [] };
  }
  private setUsage(usage: GeminiWebUsage) {
    this.last = { ...this.last, usage };
    this.onUsage(usage);
    return usage;
  }
  observe(snapshot: WebSnapshot) {
    const notice = webUsage(snapshot.notices);
    const low = notice.remaining !== undefined && notice.limit !== undefined && notice.remaining <= notice.limit * 0.1;
    if ((notice.status === "limited" || low) && (notice.detail !== this.last.usage.detail || notice.status !== this.last.usage.status)) this.setUsage(notice);
    return notice;
  }
  private publish(state: GeminiWebStatus["state"], message: string, snapshot?: WebSnapshot) {
    if (snapshot) this.observe(snapshot);
    if (state === "login_required" || state === "error") this.setUsage({ status: state === "error" ? "error" : "unknown", detail: message, checkedAt: Date.now() });
    this.last = { ...this.last, state, message, model: snapshot?.model, checkedAt: Date.now() };
    return this.last;
  }
  async open(show = true): Promise<GeminiWebStatus> {
    if (this.disposed) throw new Error("웹 연결이 종료되었습니다.");
    if (show) this.cancelLoginWatch();
    if (this.opening) await this.opening;
    else if (!this.win || this.win.isDestroyed()) {
      if (!this.opening) this.opening = this.createWindow(show).finally(() => { this.opening = undefined; });
      await this.opening;
    }
    if (this.disposed || !this.win || this.win.isDestroyed()) throw new Error("웹 연결이 종료되었습니다.");
    if (show) {
      this.win.show(); this.win.focus();
      if (this.verificationRequired) {
        const existing = await this.snapshot();
        if (!existing?.draft.trim() && !existing?.generating) await this.win.loadURL(GEMINI_ORIGIN + "/app");
      }
    }
    const status = await this.refresh(false);
    if (status.state === "ready" || status.state === "busy") void this.refreshUsage();
    return status;
  }
  /** Only an explicit login action may close this account's visible browser. */
  async login(): Promise<GeminiWebStatus> {
    await this.open(true);
    if (this.disposed || !this.win || this.win.isDestroyed()) { this.cancelLoginWatch(); return this.last; }
    if (this.owner) return this.last;
    const watch: NonNullable<GeminiWebBrowser["loginWatch"]> = { win: this.win! };
    this.loginWatch = watch;
    await this.checkLogin(watch);
    return this.last;
  }
  private cancelLoginWatch() {
    if (this.loginWatch?.timer) clearTimeout(this.loginWatch.timer);
    this.loginWatch = undefined;
  }
  private async checkLogin(watch: NonNullable<GeminiWebBrowser["loginWatch"]>) {
    if (this.loginWatch !== watch) return;
    if (this.disposed || watch.win.isDestroyed() || this.owner) { this.cancelLoginWatch(); return; }
    try {
      const s = await this.snapshot();
      if (this.loginWatch !== watch || watch.win.isDestroyed() || this.disposed) return;
      if (this.owner) { this.cancelLoginWatch(); return; }
      if (!s || s.login || !s.composer || !s.model) {
        // A target=_blank sign-in may finish in its popup while the opener still shows Sign in.
        if (this.authWindows.size && !watch.returning && watch.win.webContents.getURL().startsWith(GEMINI_ORIGIN + "/") && !s?.draft.trim() && !s?.generating) {
          for (const popup of this.authWindows) {
            if (popup.isDestroyed() || !popup.webContents.getURL().startsWith(GEMINI_ORIGIN + "/")) continue;
            const signedIn: WebSnapshot = await popup.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
            if (this.loginWatch !== watch || this.disposed || this.owner || watch.win.isDestroyed()) return;
            if (!signedIn.login && signedIn.composer && signedIn.model) {
              if (signedIn.draft.trim() || signedIn.generating) {
                this.publish("busy", "로그인됨 · 로그인 창에서 작성 중인 내용을 마무리하면 연결이 완료됩니다.", signedIn);
                return;
              }
              const current = await this.snapshot();
              if (this.loginWatch !== watch || this.disposed || this.owner || watch.win.isDestroyed()) return;
              if (!watch.win.webContents.getURL().startsWith(GEMINI_ORIGIN + "/") || current?.draft.trim() || current?.generating || (current && !current.login && current.composer && current.model)) return;
              watch.returning = true;
              try { await watch.win.loadURL(GEMINI_ORIGIN + "/app"); }
              catch (error) {
                const aborted = (error as { code?: string; errno?: number }).code === "ERR_ABORTED" || (error as { errno?: number }).errno === -3;
                if (!aborted && this.loginWatch === watch && !this.disposed && !this.owner && !watch.win.isDestroyed()) {
                  this.cancelLoginWatch();
                  this.publish("error", "로그인은 확인됐지만 Gemini 화면을 열지 못했습니다. 로그인 / 브라우저를 눌러 다시 확인해 주세요.");
                }
              }
              return;
            }
          }
        }
        const message = this.verificationRequired
          ? "Google 보안 확인을 완료해 주세요. 확인 후 연결 상태가 자동으로 갱신됩니다."
          : "브라우저에서 로그인해 주세요. 완료되면 연결을 확인하고 창을 자동으로 닫습니다.";
        if (this.last.state !== "login_required" || this.last.message !== message) this.publish("login_required", message);
        return;
      }
      let popupBusy = false;
      for (const popup of this.authWindows) {
        if (popup.isDestroyed()) continue;
        const content: WebSnapshot | undefined = popup.webContents.getURL().startsWith(GEMINI_ORIGIN + "/")
          ? await popup.webContents.executeJavaScript(SNAPSHOT_SCRIPT) : undefined;
        if (this.loginWatch !== watch || this.disposed || this.owner || watch.win.isDestroyed()) return;
        if (content?.draft.trim() || content?.generating) popupBusy = true;
        else if (!popup.isDestroyed()) popup.destroy();
      }
      this.cancelLoginWatch();
      this.verificationRequired = false;
      const keepOpen = popupBusy || !!s.draft.trim() || s.generating;
      if (!keepOpen) {
        watch.win.webContents.session.flushStorageData();
        watch.win.hide();
      }
      const status = this.publish(keepOpen ? "busy" : "ready", keepOpen
        ? "로그인 완료 · 작성 중인 내용이 있어 브라우저를 유지합니다."
        : "로그인 완료 · 브라우저 창을 닫았습니다.", s);
      this.onLogin(status);
      void this.refreshUsage();
    } catch {
      if (this.loginWatch === watch && !watch.win.isDestroyed() && this.last.message !== "로그인 완료를 확인하는 중입니다. 브라우저의 안내를 확인해 주세요.")
        this.publish("login_required", "로그인 완료를 확인하는 중입니다. 브라우저의 안내를 확인해 주세요.");
    } finally {
      if (this.loginWatch === watch) watch.timer = setTimeout(() => void this.checkLogin(watch), 1000);
    }
  }
  private makeWindow(show: boolean) {
    const ses = session.fromPath(join(this.dataDir, "web-accounts", this.accountId));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ width: 1100, height: 850, show, autoHideMenuBar: true,
      title: `ChatterBox · Gemini 웹 ${this.accountName}`, webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    this.protectNavigation(win);
    return win;
  }
  private protectNavigation(win: BrowserWindow) {
    const guard = (event: Electron.Event, url: string) => {
      if (allowedNavigation(url)) return;
      event.preventDefault();
      this.cancelLoginWatch();
      let destination = "지원하지 않는 주소";
      try { const u = new URL(url); destination = u.hostname + u.pathname; } catch { /* No query or credentials in feedback. */ }
      this.publish("error", `로그인 이동이 차단되었습니다: ${destination}. 앱에서 연결 상태를 확인해 주세요.`);
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", (event, url) => {
      if (/^https:\/\/www\.google\.com\/sorry\//.test(url)) {
        this.verificationRequired = true;
        this.publish("login_required", `Google 보안 확인이 필요합니다. ${this.accountName} 브라우저를 열어 직접 확인해 주세요.`);
      }
      guard(event, url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (this.disposed || this.owner || (win !== this.win && !this.authWindows.has(win)) || !allowedNavigation(url)) return { action: "deny" };
      // Preserve window.opener and POST bodies rather than restarting navigation in the parent.
      return { action: "allow", overrideBrowserWindowOptions: { parent: this.win, width: 800, height: 850, autoHideMenuBar: true,
        title: `ChatterBox · Gemini 웹 ${this.accountName} 로그인`, webPreferences: { session: win.webContents.session, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } } };
    });
    win.webContents.on("did-create-window", popup => {
      this.authWindows.add(popup);
      this.protectNavigation(popup);
      popup.once("closed", () => this.authWindows.delete(popup));
    });
    win.on("page-title-updated", (event) => event.preventDefault());
  }
  private async createWindow(show: boolean) {
    const win = this.makeWindow(show);
    this.win = win;
    win.on("close", (event) => { if (this.owner && !this.disposed) { event.preventDefault(); win.hide(); } });
    win.on("closed", () => {
      if (this.loginWatch?.win === win) this.cancelLoginWatch();
      if (this.win === win) this.win = undefined;
      this.publish("closed", "브라우저가 닫혔습니다. 로그인 세션은 유지됩니다.");
    });
    let redirected = false;
    const contents = win.webContents;
    const navigating = (_event: Electron.Event, url: string, _inPlace: boolean, main: boolean) => {
      if (main && url !== GEMINI_ORIGIN + "/app" && allowedNavigation(url)) redirected = true;
    };
    contents.on("did-start-navigation", navigating);
    try { await win.loadURL(GEMINI_ORIGIN + "/app"); }
    catch (error) {
      const code = (error as { code?: string; errno?: number }).code;
      if (this.disposed || this.owner || win.isDestroyed() || this.last.state === "error" || !redirected || (code !== "ERR_ABORTED" && (error as { errno?: number }).errno !== -3)) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      }
    } finally { contents.removeListener("did-start-navigation", navigating); }
    await delay(600);
    return win;
  }
  async snapshot(): Promise<WebSnapshot | null> {
    if (!this.win || this.win.isDestroyed()) return null;
    if (!this.win.webContents.getURL().startsWith(GEMINI_ORIGIN + "/")) return null;
    return this.win.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
  }
  async refresh(readUsage = true): Promise<GeminiWebStatus> {
    try {
      const s = await this.snapshot();
      if (this.verificationRequired && (!readUsage || !s || s.login)) return this.publish("login_required", `Google 보안 확인이 필요합니다. ${this.accountName} 브라우저에서 직접 확인한 뒤 새로 확인을 눌러 주세요.`);
      if (!this.win) {
        this.publish("closed", `브라우저를 열어 웹 ${this.accountName}의 상태를 확인하세요.`);
        if (readUsage) await this.refreshUsage(true);
        return this.last;
      }
      if (!s || s.login) return this.publish("login_required", "전용 브라우저에서 Google 계정 로그인을 완료하세요.");
      if (!s.composer && s.url !== GEMINI_ORIGIN + "/usage") return this.publish("error", "Gemini 입력창을 확인하지 못했습니다. 브라우저의 안내를 확인하세요.");
      this.verificationRequired = false;
      const manual = !this.owner && (s.generating || !!s.draft.trim());
      this.publish(this.owner || manual ? "busy" : "ready", this.owner ? `웹 ${this.accountName} 작업 중` : manual ? `${this.accountName} 브라우저에서 직접 작성 중입니다.` : /argon/i.test(s.model) ? `${this.accountName} · Argon 연결 준비 완료` : "로그인됨 · 작업 시작 전에 Argon을 확인합니다.", s);
      if (readUsage) await this.refreshUsage(true);
      return this.last;
    } catch { return this.publish("error", "웹 상태를 읽지 못했습니다. 브라우저에서 연결을 확인하세요."); }
  }
  /** A separate hidden page shares this account's session; never navigate the active chat. */
  refreshUsage(force = false): Promise<GeminiWebUsage> {
    if (this.usageReading) return this.usageReading;
    if (this.disposed || this.verificationRequired) return Promise.resolve(this.last.usage);
    if (!force && Date.now() - this.lastUsageReadAt < 60000) return Promise.resolve(this.last.usage);
    this.lastUsageReadAt = Date.now();
    this.usageReading = this.readUsage().finally(() => { this.usageReading = undefined; });
    return this.usageReading;
  }
  private async readUsage(): Promise<GeminiWebUsage> {
    const win = this.makeWindow(false);
    this.usageWindow = win;
    const timer = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 20000);
    try {
      await win.loadURL(GEMINI_ORIGIN + "/usage");
      let usage = webUsage([]);
      for (let n = 0; n < 30; n++) {
        if (this.disposed || win.isDestroyed()) throw new Error("사용량 연결이 종료되었습니다.");
        if (this.verificationRequired) return this.last.usage;
        if (!win.webContents.getURL().startsWith(GEMINI_ORIGIN + "/")) return this.setUsage({ status: "unknown", detail: `웹 ${this.accountName} 로그인이 필요합니다.`, checkedAt: Date.now() });
        const s = await win.webContents.executeJavaScript(USAGE_SCRIPT);
        if (s?.login) return this.setUsage({ status: "unknown", detail: `웹 ${this.accountName} 로그인이 필요합니다.`, checkedAt: Date.now() });
        usage = webUsagePage(s?.current ?? "", s?.weekly ?? "");
        // Card headings render before quota numbers; current and weekly may arrive separately.
        if (usage.current && usage.weekly) return this.setUsage(usage);
        await delay(400);
      }
      return this.setUsage(usage);
    } catch {
      return this.setUsage({ status: "error", detail: "웹 사용량을 읽지 못했습니다. 로그인과 연결 상태를 확인하세요.", checkedAt: Date.now() });
    } finally {
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (this.usageWindow === win) this.usageWindow = undefined;
    }
  }
  async claim(owner: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.verificationRequired) throw new Error(`Google 보안 확인이 필요합니다. ${this.accountName} 브라우저를 열어 직접 확인한 뒤 새로 확인을 눌러 주세요.`);
    if (this.owner) throw new Error(`Gemini 웹 ${this.accountName}이 다른 작업을 처리 중입니다. 완료 후 다시 배정하세요.`);
    if (this.authWindows.size) throw new Error(`Gemini 웹 ${this.accountName} 로그인 창을 먼저 마무리해 주세요. 로그인 중에는 작업을 배정하지 않습니다.`);
    this.cancelLoginWatch();
    this.owner = owner;
    const abort = () => { if (this.owner === owner && this.win && !this.win.isDestroyed()) this.win.webContents.stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    try { await this.open(false); signal?.throwIfAborted(); }
    catch (error) { this.release(owner); throw error; }
    finally { signal?.removeEventListener("abort", abort); }
  }
  release(owner: string) { if (this.owner === owner) { this.owner = undefined; void this.refresh(false); void this.refreshUsage(); } }
  private check(owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.owner !== owner || !this.win || this.win.isDestroyed()) throw new Error("웹 작업자 연결이 종료되었습니다.");
  }
  async prepare(owner: string, nativeId: string | null, signal: AbortSignal) {
    this.check(owner, signal);
    if (this.verificationRequired) throw new Error(`Google 보안 확인이 필요합니다. ${this.accountName} 브라우저에서 직접 확인해 주세요.`);
    const existing = await this.snapshot();
    if (existing?.generating || existing?.draft.trim()) throw new Error("웹 채팅에 직접 작성 중인 내용이나 응답이 있습니다. 브라우저에서 마무리한 뒤 다시 요청하세요.");
    const target = webConversationUrl(nativeId, this.accountId);
    if (this.win!.webContents.getURL().split(/[?#]/)[0] !== target || !nativeId) {
      const contents = this.win!.webContents;
      const abort = () => { if (!contents.isDestroyed()) contents.stop(); };
      signal.addEventListener("abort", abort, { once: true });
      try { await this.win!.loadURL(target); } finally { signal.removeEventListener("abort", abort); }
    }
    for (let n = 0; n < 40; n++) {
      this.check(owner, signal);
      const s = await this.snapshot();
      if (s?.login) throw new Error(`Gemini 웹 로그인이 필요합니다. ${this.accountName} 브라우저를 열어 로그인하세요.`);
      // Gemini mounts the editor before the model selector; never mistake that loading state for a different model.
      if (s?.composer && s.model) {
        if (s.generating || s.draft.trim()) throw new Error("웹 채팅에 직접 작성 중인 내용이나 응답이 있습니다. 브라우저에서 마무리한 뒤 다시 요청하세요.");
        if (nativeId && this.nativeId(s) !== nativeId) throw new Error("저장된 웹 대화를 다시 열지 못했습니다. 새 대화로 대신 실행하지 않습니다.");
        if (!s.chatMode) {
          await this.win!.webContents.executeJavaScript(buttonScript("^\\s*(채팅|Chat)\\s*$"));
          await delay(250); this.check(owner, signal);
        }
        if (!/argon/i.test(s.model)) {
          await this.win!.webContents.executeJavaScript(buttonScript("모드 선택|mode picker|model picker|choose.*model|select.*model"));
          await delay(250); this.check(owner, signal);
          const selected = await this.win!.webContents.executeJavaScript(buttonScript("\\bArgon\\b"));
          if (!selected) throw new Error("이 웹 계정에서 Argon을 선택할 수 없습니다. 계정 구독과 모델 메뉴를 확인하세요.");
          await delay(300);
        }
        const verified = await this.snapshot();
        if (!verified || !/argon/i.test(verified.model) || !verified.chatMode) throw new Error("Argon 채팅 모드를 확인하지 못했습니다. 다른 모델이나 작업 모드로 대신 실행하지 않습니다.");
        this.publish("busy", `웹 ${this.accountName} 작업 중`, verified);
        if (this.last.usage.status === "error") await this.refreshUsage(true);
        this.check(owner, signal);
        return verified;
      }
      await delay(500);
    }
    throw new Error("웹 입력창을 불러오지 못했습니다. 로그인과 연결 상태를 확인하세요.");
  }
  async submit(owner: string, text: string, signal: AbortSignal) {
    this.check(owner, signal);
    const focused = await this.win!.webContents.executeJavaScript(`(() => { if(location.origin !== ${JSON.stringify(GEMINI_ORIGIN)}) return false; const el = document.querySelector('rich-textarea [contenteditable=true],[contenteditable=true][role=textbox]'); if(!el || el.innerText.trim()) return false; el.focus(); return true; })()`);
    if (!focused) throw new Error("웹 입력창이 비어 있지 않거나 사용할 수 없습니다.");
    this.check(owner, signal);
    await this.win!.webContents.insertText(text);
    this.check(owner, signal);
    const sent = await this.win!.webContents.executeJavaScript(buttonScript("^\\s*(프롬프트 전송|메시지 보내기|보내기|Send message|Send prompt|Send)\\s*$"));
    if (!sent) throw new Error("Gemini 전송 버튼을 확인하지 못했습니다. 입력된 초안은 전용 브라우저에 남아 있습니다.");
  }
  async interrupt(owner: string) {
    if (this.owner !== owner || !this.win || this.win.isDestroyed()) return;
    await this.win.webContents.executeJavaScript(buttonScript("응답 중지|답변 중지|생성 중지|stop response|stop generating")).catch(() => false);
  }
  nativeId(snapshot: WebSnapshot) { return webConversationId(snapshot.url, this.accountId); }
  async dispose() {
    this.cancelLoginWatch();
    this.disposed = true; this.owner = undefined;
    for (const popup of this.authWindows) if (!popup.isDestroyed()) popup.destroy();
    if (this.usageWindow && !this.usageWindow.isDestroyed()) this.usageWindow.destroy();
    if (this.studioWindow && !this.studioWindow.isDestroyed()) this.studioWindow.destroy();
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.stop();
      this.win.webContents.session.flushStorageData();
      this.win.destroy();
    }
    await this.usageReading;
  }
}

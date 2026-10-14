import { BrowserWindow, session } from "electron";
import { join } from "node:path";
import type { GeminiWebStatus, GeminiWebUsage } from "../../shared/types";
import { SNAPSHOT_SCRIPT, USAGE_SCRIPT, GEMINI_ORIGIN, buttonScript, webUsage, webUsagePage, webConversationUrl, webConversationId, type WebSnapshot } from "./gemini-web-protocol";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** One isolated persistent Google account. No remote debugging listener or shared app preload. */
export class GeminiWebBrowser {
  private win?: BrowserWindow;
  private opening?: Promise<BrowserWindow>;
  private owner?: string;
  private disposed = false;
  private usageWindow?: BrowserWindow;
  private usageReading?: Promise<GeminiWebUsage>;
  private verificationRequired = false;
  private lastUsageReadAt = 0;
  private last: GeminiWebStatus = { accountId: "gemini-1", state: "closed", message: "웹 계정 1에 로그인하세요.", checkedAt: 0, usage: webUsage([]) };
  constructor(private dataDir: string, private onUsage: (usage: GeminiWebUsage) => void) {}

  status() { return this.last; }
  private setUsage(usage: GeminiWebUsage) {
    this.last = { ...this.last, usage };
    this.onUsage(usage);
    return usage;
  }
  observe(snapshot: WebSnapshot) {
    const notice = webUsage(snapshot.notices);
    if (notice.status === "limited" && notice.detail !== this.last.usage.detail) this.setUsage(notice);
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
  private makeWindow(show: boolean) {
    const ses = session.fromPath(join(this.dataDir, "web-accounts", "gemini-1"));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ width: 1100, height: 850, show, autoHideMenuBar: true,
      title: "ChatterBox · Gemini 웹 계정 1", webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    const allowed = (url: string) => { try { const u = new URL(url); return u.protocol === "https:" && (["gemini.google.com", "accounts.google.com", "myaccount.google.com"].includes(u.hostname) || (u.hostname === "www.google.com" && u.pathname.startsWith("/sorry/"))); } catch { return false; } };
    win.webContents.on("will-navigate", (event, url) => { if (!allowed(url)) event.preventDefault(); });
    win.webContents.on("will-redirect", (event, url) => {
      if (/^https:\/\/www\.google\.com\/sorry\//.test(url)) {
        this.verificationRequired = true;
        this.publish("login_required", "Google 보안 확인이 필요합니다. 계정 1 브라우저를 열어 직접 확인해 주세요.");
      }
      if (!allowed(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (win === this.win && allowed(url) && !this.owner) void win.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    win.on("page-title-updated", (event) => event.preventDefault());
    return win;
  }
  private async createWindow(show: boolean) {
    const win = this.makeWindow(show);
    this.win = win;
    win.on("close", (event) => { if (this.owner && !this.disposed) { event.preventDefault(); win.hide(); } });
    win.on("closed", () => { if (this.win === win) this.win = undefined; this.publish("closed", "브라우저가 닫혔습니다. 로그인 세션은 유지됩니다."); });
    try { await win.loadURL(GEMINI_ORIGIN + "/app"); }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
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
      if (this.verificationRequired && (!readUsage || !s || s.login)) return this.publish("login_required", "Google 보안 확인이 필요합니다. 계정 1 브라우저에서 직접 확인한 뒤 새로 확인을 눌러 주세요.");
      if (!this.win) {
        this.publish("closed", "브라우저를 열어 웹 계정 1의 상태를 확인하세요.");
        if (readUsage) await this.refreshUsage(true);
        return this.last;
      }
      if (!s || s.login) return this.publish("login_required", "전용 브라우저에서 Google 계정 로그인을 완료하세요.");
      if (!s.composer) return this.publish("error", "Gemini 입력창을 확인하지 못했습니다. 브라우저의 안내를 확인하세요.");
      this.verificationRequired = false;
      this.publish(this.owner ? "busy" : "ready", this.owner ? "웹 계정 1 작업 중" : /argon/i.test(s.model) ? "계정 1 · Argon 연결 준비 완료" : "로그인됨 · 작업 시작 전에 Argon을 확인합니다.", s);
      if (readUsage) await this.refreshUsage(true);
      return this.last;
    } catch { return this.publish("error", "웹 상태를 읽지 못했습니다. 브라우저에서 연결을 확인하세요."); }
  }
  /** A separate hidden page shares only account 1's session; never navigate the active chat. */
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
      for (let n = 0; n < 30; n++) {
        if (this.disposed || win.isDestroyed()) throw new Error("사용량 연결이 종료되었습니다.");
        if (this.verificationRequired) return this.last.usage;
        if (!win.webContents.getURL().startsWith(GEMINI_ORIGIN + "/")) return this.setUsage({ status: "unknown", detail: "웹 계정 1 로그인이 필요합니다.", checkedAt: Date.now() });
        const s = await win.webContents.executeJavaScript(USAGE_SCRIPT);
        if (s?.login) return this.setUsage({ status: "unknown", detail: "웹 계정 1 로그인이 필요합니다.", checkedAt: Date.now() });
        if (s?.current || s?.weekly) return this.setUsage(webUsagePage(s.current, s.weekly));
        await delay(400);
      }
      return this.setUsage(webUsage([]));
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
    if (this.verificationRequired) throw new Error("Google 보안 확인이 필요합니다. 계정 1 브라우저를 열어 직접 확인한 뒤 새로 확인을 눌러 주세요.");
    if (this.owner) throw new Error("Gemini 웹 계정 1이 다른 작업을 처리 중입니다. 완료 후 다시 배정하세요.");
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
    if (this.verificationRequired) throw new Error("Google 보안 확인이 필요합니다. 계정 1 브라우저에서 직접 확인해 주세요.");
    const existing = await this.snapshot();
    if (existing?.generating || existing?.draft.trim()) throw new Error("웹 채팅에 직접 작성 중인 내용이나 응답이 있습니다. 브라우저에서 마무리한 뒤 다시 요청하세요.");
    const target = webConversationUrl(nativeId);
    if (this.win!.webContents.getURL().split(/[?#]/)[0] !== target || !nativeId) {
      const contents = this.win!.webContents;
      const abort = () => { if (!contents.isDestroyed()) contents.stop(); };
      signal.addEventListener("abort", abort, { once: true });
      try { await this.win!.loadURL(target); } finally { signal.removeEventListener("abort", abort); }
    }
    for (let n = 0; n < 40; n++) {
      this.check(owner, signal);
      const s = await this.snapshot();
      if (s?.login) throw new Error("Gemini 웹 로그인이 필요합니다. 계정 1 브라우저를 열어 로그인하세요.");
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
  nativeId(snapshot: WebSnapshot) { return webConversationId(snapshot.url); }
  async dispose() {
    this.disposed = true; this.owner = undefined;
    if (this.usageWindow && !this.usageWindow.isDestroyed()) this.usageWindow.destroy();
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.stop();
      this.win.webContents.session.flushStorageData();
      this.win.destroy();
    }
    await this.usageReading;
  }
}

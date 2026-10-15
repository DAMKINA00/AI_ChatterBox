import type { GeminiWebAccountId, GeminiWebAccountStatus, GeminiWebUsage, GeminiWebStatus } from "../../shared/types";
import { GeminiWebBrowser } from "./gemini-web-browser";
import { webAccountId } from "./gemini-web-protocol";

export const WEB_LOW_REMAINING = 10;
export const WEB_RECHECK_MS = 10_000;
interface SavedAccount { accountId: GeminiWebAccountId; label: string; enabled: boolean; usage?: GeminiWebUsage }
interface Settings { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }
const SETTING = "geminiWebAccounts";

/** Both quota windows constrain work. Unknown or stale values are never counted as a full balance. */
export function webRemaining(usage: GeminiWebUsage, now = Date.now()): number | undefined {
  if (usage.status === "limited") return 0;
  if (usage.status !== "available" || !Number.isFinite(usage.checkedAt) || now - usage.checkedAt > 600_000 || usage.checkedAt > now + 60_000) return undefined;
  const values = [usage.current?.usedPercent, usage.weekly?.usedPercent]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100).map(v => 100 - v);
  if (typeof usage.remaining === "number" && typeof usage.limit === "number" && Number.isFinite(usage.remaining) && Number.isFinite(usage.limit) && usage.limit > 0 && usage.remaining >= 0 && usage.remaining <= usage.limit)
    values.push(100 * usage.remaining / usage.limit);
  return values.length ? Math.min(...values) : undefined;
}

/** One browser/lock per persistent profile; account 1 keeps its existing directory. */
export class GeminiWebAccounts {
  private accounts: SavedAccount[];
  private browsers = new Map<GeminiWebAccountId, GeminiWebBrowser>();
  private disposed = false;
  private closing = new AbortController();
  constructor(private dataDir: string, private settings: Settings,
    private makeBrowser = (id: GeminiWebAccountId, changed: (usage: GeminiWebUsage) => void, usage?: GeminiWebUsage) => new GeminiWebBrowser(dataDir, changed, id, usage, status => this.onLogin(status)),
    private onLogin: (status: GeminiWebStatus) => void = () => {}) {
    let saved: unknown;
    try { saved = JSON.parse(settings.getSetting(SETTING) ?? "null"); } catch { /* Keep the original account when metadata is damaged. */ }
    const seen = new Set<string>();
    this.accounts = Array.isArray(saved) ? saved.filter(a => a && webAccountId(a.accountId) && !seen.has(a.accountId) && seen.add(a.accountId))
      .map(a => ({ accountId: a.accountId, label: typeof a.label === "string" ? a.label.trim().slice(0, 60) : "", enabled: a.enabled !== false,
        usage: a.usage && ["available", "limited", "unknown", "error"].includes(a.usage.status) && typeof a.usage.detail === "string" && Number.isFinite(a.usage.checkedAt) ? a.usage : undefined })) : [];
    if (!this.accounts.length) this.accounts = [{ accountId: "gemini-1", label: "계정 1", enabled: true }];
  }
  browser(id: GeminiWebAccountId = "gemini-1") {
    if (this.disposed) throw new Error("웹 계정 연결이 종료되었습니다.");
    const account = this.accounts.find(a => a.accountId === id);
    if (!webAccountId(id) || !account) throw new Error("등록되지 않은 Gemini 웹 계정입니다.");
    let browser = this.browsers.get(id);
    if (!browser) {
      browser = this.makeBrowser(id, usage => { account.usage = usage; this.save(); }, account.usage);
      this.browsers.set(id, browser);
    }
    return browser;
  }
  list(): GeminiWebAccountStatus[] {
    return this.accounts.map(account => {
      const browser = this.browser(account.accountId), status = browser.status();
      return { ...status, state: browser.busy ? "busy" : status.state, label: account.label || `계정 ${account.accountId.slice(7)}`, enabled: account.enabled, remainingPercent: webRemaining(status.usage) };
    });
  }
  add() {
    if (this.disposed) throw new Error("웹 계정 연결이 종료되었습니다.");
    const number = Array.from({ length: 10 }, (_, n) => n + 1).find(n => !this.accounts.some(a => a.accountId === `gemini-${n}`));
    if (!number) throw new Error("Gemini 웹 계정은 최대 10개까지 등록할 수 있습니다.");
    this.accounts.push({ accountId: `gemini-${number}` as GeminiWebAccountId, label: `계정 ${number}`, enabled: true });
    this.save();
    return this.list();
  }
  update(id: GeminiWebAccountId, patch: { label?: string; enabled?: boolean }) {
    const account = this.accounts.find(a => a.accountId === id);
    if (!webAccountId(id) || !account || this.disposed) throw new Error("등록되지 않은 Gemini 웹 계정입니다.");
    if (patch.label !== undefined && (typeof patch.label !== "string" || !patch.label.trim() || patch.label.trim().length > 60)) throw new Error("계정 이름은 1~60자로 입력하세요.");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("계정 배정 설정이 잘못되었습니다.");
    if (patch.enabled === false && this.browser(id).busy) throw new Error("작업 중인 계정은 배정에서 제외할 수 없습니다. 작업을 마친 뒤 변경하세요.");
    if (patch.label !== undefined) account.label = patch.label.trim();
    if (patch.enabled !== undefined) account.enabled = patch.enabled;
    this.save();
    return this.list();
  }
  private save() {
    if (!this.disposed) this.settings.setSetting(SETTING, JSON.stringify(this.accounts));
  }
  private async refresh(excluded: Set<GeminiWebAccountId>, signal: AbortSignal) {
    const accounts = this.accounts.filter(a => a.enabled && !excluded.has(a.accountId) && !this.browser(a.accountId).busy);
    // Two pages at a time keeps refreshes bounded; each browser coalesces/throttles its own reads.
    for (let n = 0; n < accounts.length; n += 2) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("웹 배정이 중지되었습니다."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        Promise.all(accounts.slice(n, n + 2).map(async a => {
          const browser = this.browser(a.accountId);
          await browser.refreshUsage().catch(() => undefined);
          if (!browser.busy) await browser.refresh(false);
        }))
          .then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abort));
      });
    }
    signal.throwIfAborted();
  }
  private candidates(excluded: Set<GeminiWebAccountId>) {
    return this.list().filter(a => a.enabled && !excluded.has(a.accountId) && a.state !== "busy" && a.state !== "login_required"
      && a.remainingPercent !== undefined && a.remainingPercent > WEB_LOW_REMAINING)
      .sort((a, b) => b.remainingPercent! - a.remainingPercent! || Number(a.accountId.slice(7)) - Number(b.accountId.slice(7)));
  }
  private async claimAvailable(owner: string, excluded: Set<GeminiWebAccountId>, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.refresh(excluded, signal);
    for (const account of this.candidates(excluded)) {
      signal.throwIfAborted();
      const browser = this.browser(account.accountId);
      try {
        await browser.claim(owner, signal);
        signal.throwIfAborted();
        if (browser.status().state === "login_required") throw new Error(browser.status().message);
        const current = await browser.snapshot();
        signal.throwIfAborted();
        if (current?.generating || current?.draft.trim()) throw new Error("브라우저에서 직접 작성 중인 계정입니다.");
        if (current) browser.observe(current);
        const remaining = webRemaining(browser.status().usage);
        if (remaining === undefined || remaining <= WEB_LOW_REMAINING) throw new Error("작업을 시작할 잔여 한도를 확인하지 못했습니다.");
        return browser;
      } catch (error) {
        browser.release(owner);
        signal.throwIfAborted();
        if (this.disposed) throw error;
      }
    }
  }
  async acquire(owner: string, signal: AbortSignal, preferred: GeminiWebAccountId | null = null, onWaiting?: () => void): Promise<GeminiWebBrowser> {
    signal = AbortSignal.any([signal, this.closing.signal]);
    let waiting = false;
    for (;;) {
      signal.throwIfAborted();
      if (preferred && this.accounts.some(a => a.accountId === preferred && a.enabled)) {
        const others = new Set(this.accounts.filter(a => a.accountId !== preferred).map(a => a.accountId));
        const browser = await this.claimAvailable(owner, others, signal);
        if (browser) return browser;
      }
      const browser = await this.claimAvailable(owner, new Set(preferred ? [preferred] : []), signal);
      if (browser) return browser;
      if (!waiting) { onWaiting?.(); waiting = true; }
      // Reconsider every profile after a reset, including ones used earlier in this request.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, WEB_RECHECK_MS);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  async dispose() {
    this.disposed = true;
    this.closing.abort(new Error("웹 계정 연결이 종료되었습니다."));
    await Promise.all([...this.browsers.values()].map(browser => browser.dispose()));
  }
}

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { AI_STUDIO_ACCOUNT_LIMIT, type AIStudioInput, type AIStudioSettings, type AIStudioStatus, type AIStudioAccount, type AIStudioUsageRange, type AIStudioUsageReport, type AIStudioUsageStats } from "../shared/aistudio";

interface Settings { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }
export interface SecretStorage { encrypt(value: string): string; decrypt(value: string): string }
const KEY = "aiStudio";
interface Saved { baseUrl: string; model: string; executable: string; videoEnabled: boolean; secret?: string }

export function studioOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/", ""].includes(url.pathname))
    throw new Error("AIStudio2API 주소는 로컬 HTTP 주소여야 합니다. 예: http://127.0.0.1:2048");
  return url.origin;
}
function installedRuntime() {
  const root = join(process.env.SystemDrive ?? "C:", "Apps", "AIStudio2API");
  try {
    const dirs = readdirSync(root).filter(n => /^aistudio2api-[\w.-]+-windows-amd64$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return [join(root, "aistudio2api.exe"), ...dirs.map(n => join(root, n, "aistudio2api.exe"))].find(existsSync) ?? "";
  } catch { return ""; }
}

/** AIStudio2API owns generation sessions and quota failover; explicit Web sync stays in the main process. */
export class AIStudioService {
  private saved: Saved;
  private accountChange: Promise<unknown> = Promise.resolve();
  private links: NonNullable<AIStudioStatus["webLinks"]> = {};
  constructor(private store: Settings, private secrets: SecretStorage, private request: typeof fetch = fetch) {
    let stored: Partial<Saved> = {};
    try { stored = JSON.parse(store.getSetting(KEY) ?? "{}"); } catch { /* Use fresh defaults. */ }
    this.saved = { baseUrl: "http://127.0.0.1:2048", model: "gemini-4-argon", executable: installedRuntime(), videoEnabled: false, ...stored };
    this.saved.baseUrl = studioOrigin(this.saved.baseUrl);
    try { this.links = JSON.parse(store.getSetting("aiStudioWebLinks") ?? "{}"); } catch { /* No account association yet. */ }
  }
  private apiKey() {
    if (this.saved.secret) return this.secrets.decrypt(this.saved.secret);
    // The managed local runtime already persists its own key in .env; never return it to the renderer.
    if (this.saved.baseUrl === "http://127.0.0.1:2048" && this.saved.executable === installedRuntime()) {
      try { return /^PROXY_API_KEY=(.+)$/m.exec(readFileSync(join(dirname(this.saved.executable), ".env"), "utf8"))?.[1].trim().split(",")[0] ?? ""; } catch { /* User can configure another key. */ }
    }
    return "";
  }
  settings(): AIStudioSettings {
    const { secret: _, ...plain } = this.saved;
    return { ...plain, hasApiKey: !!this.apiKey() };
  }
  save(input: AIStudioInput) {
    const next = { ...this.saved };
    if (input.baseUrl !== undefined) next.baseUrl = studioOrigin(input.baseUrl);
    if (input.model !== undefined) {
      if (typeof input.model !== "string" || !/^[\w.:-]{1,150}$/.test(input.model)) throw new Error("올바른 AI Studio 모델 ID를 입력하세요.");
      next.model = input.model;
    }
    if (input.executable !== undefined) {
      if (typeof input.executable !== "string" || input.executable.length > 2048) throw new Error("실행 파일 경로가 잘못되었습니다.");
      next.executable = input.executable.trim();
    }
    if (input.videoEnabled !== undefined) {
      if (typeof input.videoEnabled !== "boolean") throw new Error("영상 설정이 잘못되었습니다.");
      next.videoEnabled = input.videoEnabled;
    }
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== "string" || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey)) throw new Error("API 키가 잘못되었습니다.");
      // An empty password input preserves the configured key.
      if (input.apiKey.trim()) next.secret = this.secrets.encrypt(input.apiKey.trim());
    }
    if (next.baseUrl !== this.saved.baseUrl) {
      this.links = {};
      this.store.setSetting("aiStudioWebLinks", "{}");
    }
    this.saved = next;
    this.store.setSetting(KEY, JSON.stringify(next));
  }
  async response(path: string, body?: unknown, signal?: AbortSignal, method?: string) {
    if (!/^\/(api|v1)\//.test(path) || path.includes("..")) throw new Error("지원하지 않는 AI Studio 경로입니다.");
    const key = this.apiKey();
    const response = await this.request(this.saved.baseUrl + path, {
      method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(path.startsWith("/api/accounts") && body !== undefined ? 1_800_000 : 300_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      let message = response.statusText;
      try { const data = await response.json(); message = data.error?.message ?? message; } catch { /* Do not expose HTML or request bodies. */ }
      if (key) message = message.replaceAll(key, "[redacted]");
      throw new Error(`AIStudio2API ${response.status}: ${String(message).slice(0, 600)}`);
    }
    return response;
  }
  async json(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<any> {
    const response = await this.response(path, body, signal, method);
    return response.status === 204 ? {} : response.json();
  }
  async usage(range: AIStudioUsageRange = "24h"): Promise<AIStudioUsageReport> {
    if (!["24h", "7d", "30d"].includes(range)) throw new Error("지원하지 않는 AI Studio 사용량 조회 기간입니다.");
    const to = new Date(), days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
    const query = new URLSearchParams({ from: new Date(to.getTime() - days * 86400000).toISOString(), to: to.toISOString() });
    const report = await this.json(`/api/usage?${query}`, undefined, AbortSignal.timeout(8000));
    const invalid = () => new Error("AI Studio 사용량 응답 형식이 올바르지 않습니다.");
    const timestamp = (value: unknown) => {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid();
      return new Date(value).toISOString();
    };
    const stats = (value: any): AIStudioUsageStats => {
      const fields = { requests: "requests", succeeded: "succeeded", failed: "failed", canceled: "canceled", rateLimited: "rate_limited",
        inputTokens: "input_tokens", cachedTokens: "cached_tokens", reasoningTokens: "reasoning_tokens", replyTokens: "reply_tokens", totalTokens: "total_tokens" } as const;
      const result = {} as AIStudioUsageStats;
      for (const [key, field] of Object.entries(fields)) {
        const count = value?.[field];
        if (!Number.isSafeInteger(count) || count < 0) throw invalid();
        result[key as keyof AIStudioUsageStats] = count;
      }
      return result;
    };
    const groups = {} as AIStudioUsageReport["groups"];
    for (const dimension of ["account", "model", "channel"] as const) {
      const rows = report?.groups?.[dimension];
      if (!Array.isArray(rows)) throw invalid();
      groups[dimension] = rows.map(row => {
        if (typeof row?.key !== "string" || row.key.length > 500) throw invalid();
        return { key: row.key, ...stats(row) };
      });
    }
    // Keep only aggregate counters: no request contents, API keys, or inferred remaining quota.
    return { from: timestamp(report.from), to: timestamp(report.to), generatedAt: timestamp(report.generated_at), totals: stats(report.totals), groups };
  }
  async status(): Promise<AIStudioStatus> {
    const result: AIStudioStatus = { settings: this.settings(), state: "OFFLINE", accounts: [], cooldowns: [], models: [], webLinks: this.links };
    try {
      const signal = AbortSignal.timeout(8000);
      const [status, accounts, cooldowns, models] = await Promise.all([
        this.json("/api/status", undefined, signal), this.json("/api/accounts", undefined, signal),
        this.json("/api/cooldowns", undefined, signal), this.json("/api/models", undefined, signal),
      ]);
      result.state = String(status.state ?? "UNKNOWN"); result.version = status.version;
      result.accounts = (accounts.accounts ?? []).map((a: AIStudioAccount) => ({ id: a.id, label: a.label, enabled: a.enabled, state: a.state, benefit_tier: a.benefit_tier, message: a.message, models: a.models ?? [] }));
      result.cooldowns = cooldowns.cooldowns ?? [];
      result.models = (models.models ?? []).map((m: any) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
    } catch (e) { result.error = e instanceof Error ? e.message : "AIStudio2API에 연결하지 못했습니다."; }
    return result;
  }
  async launch() {
    if (!(await this.status()).error) return;
    const exe = this.saved.executable;
    if (!exe || !existsSync(exe) || !/aistudio2api\.exe$/i.test(exe)) throw new Error("AIStudio2API 실행 파일을 설치하고 경로를 지정하세요.");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ["-open-ui=false"], { cwd: dirname(exe), windowsHide: true, detached: true, stdio: "ignore" });
      child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
    });
    for (let n = 0; n < 20; n++) {
      await new Promise(r => setTimeout(r, 500));
      if (!(await this.status()).error) return;
    }
    throw new Error("AIStudio2API 시작을 확인하지 못했습니다. 관리 로그를 확인하세요.");
  }
  async start() {
    const accounts = (await this.json("/api/accounts")).accounts ?? [];
    if (accounts.filter((a: any) => a.enabled).length > AI_STUDIO_ACCOUNT_LIMIT) throw new Error("활성 AI Studio 계정을 10개 이하로 설정하세요.");
    const config = await this.json("/api/config");
    await this.json("/api/config", { ...config, max_active_workers: 10, per_account_concurrency: 1, routing_strategy: "fill-first", request_body_log: false }, undefined, "PUT");
    await this.json("/api/control/start", {});
  }
  async account(action: "refresh" | "enable", input: AIStudioInput) {
    const run = this.accountChange.then(async () => {
      const accounts = (await this.json("/api/accounts")).accounts ?? [];
      const existing = input.accountId ? accounts.find((a: any) => a.id === input.accountId) : undefined;
      if (input.accountId && !existing) throw new Error("등록되지 않은 AI Studio 계정입니다.");
      if (!existing) throw new Error("AI Studio 계정을 선택하세요.");
      const path = `/api/accounts/${encodeURIComponent(existing.id)}`;
      if (action === "enable") {
        if (typeof input.enabled !== "boolean") throw new Error("계정 활성 설정이 잘못되었습니다.");
        await this.json(path, { label: existing.label, enabled: input.enabled, proxy: existing.proxy ?? "", locale: existing.locale ?? "ko-KR", timezone: existing.timezone ?? "Asia/Seoul" }, undefined, "PUT");
      } else await this.json(`${path}/${action}`, {});
    });
    this.accountChange = run.catch(() => undefined);
    return run;
  }
  linkedAccount(webId: string) { return this.links[webId]?.accountId; }
  linkedWebAccounts(accountId: string) { return Object.keys(this.links).filter(id => this.links[id]?.accountId?.toLowerCase() === accountId.toLowerCase()); }
  async disconnectWeb(webId: string) {
    if (!/^gemini-([1-9]|10)$/.test(webId)) throw new Error("등록되지 않은 웹 계정입니다.");
    const run = this.accountChange.then(async () => {
      const id = this.linkedAccount(webId);
      if (id) {
        if (this.linkedWebAccounts(id).some(other => other !== webId)) throw new Error("다른 웹 슬롯에도 연결된 AI Studio 계정입니다. 연결을 먼저 확인하세요.");
        const accounts = (await this.json("/api/accounts")).accounts;
        if (!Array.isArray(accounts)) throw new Error("AI Studio 계정 목록을 확인하지 못했습니다.");
        const account = accounts.find((a: AIStudioAccount) => a.id.toLowerCase() === id.toLowerCase());
        if (account?.state === "busy") throw new Error("AI Studio에서 사용 중인 계정입니다. 작업을 마친 뒤 다시 시도하세요.");
        // The backend checks its scheduler lease atomically and removes its own saved login.
        if (account) await this.json(`/api/accounts/${encodeURIComponent(account.id)}`, undefined, AbortSignal.timeout(15_000), "DELETE");
      }
      delete this.links[webId];
      this.store.setSetting("aiStudioWebLinks", JSON.stringify(this.links));
    });
    this.accountChange = run.catch(() => undefined);
    return run;
  }
  async syncWeb(webId: string, enabled: boolean, getState: () => Promise<{ email: string; cookies: Record<string, unknown>[]; origins: never[] }>) {
    if (!/^gemini-([1-9]|10)$/.test(webId)) throw new Error("등록되지 않은 웹 계정입니다.");
    const run = this.accountChange.then(async () => {
      try {
        const state = await getState();
        if (!/^[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(state.email)) throw new Error("Google 계정 이메일을 확인하지 못했습니다.");
        const accounts = (await this.json("/api/accounts")).accounts ?? [];
        const existing = accounts.find((a: any) => a.id.toLowerCase() === state.email.toLowerCase());
        if (this.linkedWebAccounts(state.email).some(id => id !== webId)) throw new Error("이미 다른 Web 계정 카드에 연결된 Google 계정입니다. 기존 카드를 사용하세요.");
        if (!existing && accounts.length >= AI_STUDIO_ACCOUNT_LIMIT) throw new Error("AI Studio에는 이미 10개 계정이 연결되어 있습니다.");
        const oldId = this.linkedAccount(webId);
        const oldAccount = oldId && oldId.toLowerCase() !== state.email.toLowerCase() && accounts.find((a: any) => a.id === oldId);
        if (oldAccount) {
          // A replaced Google identity must no longer receive this Web slot's requests.
          await this.json(`/api/accounts/${encodeURIComponent(oldAccount.id)}`, { label: oldAccount.label, enabled: false,
            proxy: oldAccount.proxy ?? "", locale: oldAccount.locale ?? "ko-KR", timezone: oldAccount.timezone ?? "Asia/Seoul" }, undefined, "PUT");
        }
        const storageState = { cookies: state.cookies, origins: state.origins };
        if (!existing) {
          const pairing = await this.json("/api/pairing", {});
          const result = await this.request(this.saved.baseUrl + "/api/pairing/accounts", {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.token}` },
            body: JSON.stringify({ label: state.email, locale: "ko-KR", timezone: "Asia/Seoul", storage_state: storageState }),
          });
          if (!result.ok) throw new Error(`AI Studio 계정 동기화 실패 (${result.status}). 관리 화면에서 연결 상태를 확인하세요.`);
          const imported = (await result.json()).account;
          if (imported?.id?.toLowerCase() !== state.email.toLowerCase()) throw new Error("동기화된 Google 계정이 요청한 계정과 일치하지 않습니다.");
          if (!enabled) await this.json(`/api/accounts/${encodeURIComponent(imported.id)}`, { ...imported, enabled: false, locale: "ko-KR", timezone: "Asia/Seoul", proxy: imported.proxy ?? "" }, undefined, "PUT");
        } else {
          // The upstream import API only creates accounts. Refresh an existing local account's
          // standard storage-state atomically while its scheduler lease is disabled.
          if (!this.saved.executable || this.saved.executable !== installedRuntime() || this.saved.baseUrl !== "http://127.0.0.1:2048")
            throw new Error("이 계정의 재동기화는 ChatterBox가 설치한 로컬 AIStudio2API에서 지원합니다.");
          const config = await this.json("/api/config");
          const runtime = realpathSync(dirname(this.saved.executable));
          const statePath = realpathSync(resolve(runtime, config.auth_states || "auth", existing.id, "storage-state.json"));
          const rel = relative(runtime, statePath);
          if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error("관리되는 AI Studio 계정 저장 경로가 아닙니다.");
          const patch = { label: existing.label, proxy: existing.proxy ?? "", locale: existing.locale ?? "ko-KR", timezone: existing.timezone ?? "Asia/Seoul" };
          await this.json(`/api/accounts/${encodeURIComponent(existing.id)}`, { ...patch, enabled: false }, undefined, "PUT");
          const temporary = statePath + "." + randomUUID() + ".tmp";
          try {
            const previous = JSON.parse(readFileSync(statePath, "utf8"));
            writeFileSync(temporary, JSON.stringify({ ...previous, ...storageState }), { encoding: "utf8", mode: 0o600, flag: "wx" });
            renameSync(temporary, statePath);
          } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
            await this.json(`/api/accounts/${encodeURIComponent(existing.id)}`, { ...patch, enabled }, undefined, "PUT");
          }
          await this.json(`/api/accounts/${encodeURIComponent(existing.id)}/refresh`, {});
        }
        this.links[webId] = { accountId: state.email, state: "connected", message: "같은 Google 계정으로 AI Studio 연결됨", checkedAt: Date.now() };
      } catch (e) {
        const message = e instanceof Error ? e.message : "계정 동기화에 실패했습니다.";
        this.links[webId] = { accountId: this.links[webId]?.accountId, state: "error", message, checkedAt: Date.now() };
        throw e;
      } finally { this.store.setSetting("aiStudioWebLinks", JSON.stringify(this.links)); }
    });
    this.accountChange = run.catch(() => undefined);
    return run;
  }
  /** Import through Custom Model Enabler's own UI so existing vendor settings and credentials stay intact. */
  antigravityConfig() {
    return { models: [{ name: "models/chatterbox-aistudio-argon", displayName: "AI Studio · Argon", provider: "custom", externalModelName: this.saved.model,
      apiUrl: this.saved.baseUrl + "/v1", apiKey: "", apiFormat: "openai", enabled: true }] };
  }
}

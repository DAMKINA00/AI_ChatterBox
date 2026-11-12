// Remote web access: a loopback-only HTTP server in the UI process. Caddy terminates TLS for the
// public origin (https://ai.damkina.net) and proxies here; the server itself never binds outside 127.0.0.1.
// Every API call reuses the same core RPC channels as the desktop window, so approvals, ask_user answers
// and extra instructions go through the existing (duplicate-safe) handlers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { isIP } from "node:net";
import {
  REMOTE_UPLOAD_STORAGE, REMOTE_WEB_DEFAULT_ORIGIN, REMOTE_WEB_DEFAULT_PORT, REMOTE_WEB_MIN_PASSWORD, clampUploadStorageGb,
  type RemoteAuditEntry, type RemoteAuthProvider, type RemoteProjectRoot, type RemoteWebAction, type RemoteWebInput, type RemoteWebLoginFailure, type RemoteWebSession, type RemoteWebStatus,
} from "../shared/remote-web";
import { HttpError, RemoteFeatures, folderId, stripLocalPaths } from "./remote-features";
import type { EventPage } from "../shared/event-page";
import { DSM_DEFAULT_URL, DsmProvider, normalizeDsmUrl, normalizeFingerprint, probeDsm, type AuthProvider, type DsmSettings, type LoginResult } from "./remote-auth";

export type CoreCall = (channel: string, args: unknown[]) => Promise<any>;

interface PasswordHash { salt: string; hash: string; N: number; r: number; p: number }
interface Config { enabled: boolean; port: number; publicOrigin: string; password?: PasswordHash; provider: RemoteAuthProvider; dsm: DsmSettings; trustProxy: boolean; dsmFailureLimit: number; projectRoots: RemoteProjectRoot[];
  /** Local emergency password from internet client IPs (default off: private/loopback IPs only). */
  allowInternetEmergency: boolean;
  /** The local password was at least 20 characters when set (length only, never the password). */
  passwordLong: boolean;
  /** Cap on all remote uploads' disk use (REMOTE_UPLOAD_STORAGE). */
  uploadStorageGb: number;
}
type ClientKind = "local" | "lan" | "internet" | "unknown";
/** provider/clientKind: an internet session made with the local password ends when that permission is withdrawn. */
interface Session extends RemoteWebSession { key: string; csrf: string; provider: RemoteAuthProvider; clientKind: ClientKind }
interface Stream { res: ServerResponse; sessionKey: string; chatId: number | null }
interface Failures { count: number; first: number; lockedUntil: number }

export const COOKIE = "__Host-cbx_session";
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
/** Per client IP: hard lock. */
export const FAIL_LIMIT_IP = 5;
/**
 * Per NAS account: hard lock of that account only; other accounts and the local emergency login stay usable.
 * The local password has no account dimension (locking it would lock everyone), so it relies on the
 * per-IP lock and the global delay.
 */
export const FAIL_LIMIT_ACCOUNT = 8;
/**
 * Global: no hard lock (an attacker with two IPs could otherwise lock everyone out). Past this many
 * failures in the window each request waits longer before it queues, up to GLOBAL_DELAY_MAX_MS.
 * The wait is per request and holds no queue slot.
 */
export const GLOBAL_DELAY_AFTER = 8;
export const GLOBAL_DELAY_STEP_MS = 1_000;
export const GLOBAL_DELAY_MAX_MS = 10_000;
/**
 * Login answers are padded up to the next of these totals, so an unlisted id (no NAS round trip) and a
 * listed one answer alike while the NAS responds normally. A NAS timeout still lands in a later bucket.
 */
export const LOGIN_TIME_BUCKETS_MS = [1_500, 6_000, 12_000, 20_000];
export const loginPaddingMs = (elapsed: number) => Math.max(0, (LOGIN_TIME_BUCKETS_MS.find(b => b >= elapsed) ?? elapsed) - elapsed);
/** NAS logins rejected by the NAS within this window are capped (DSM auto-block counts per source IP). */
export const DSM_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const DSM_FAILURE_LIMIT_DEFAULT = 6;
/** Waiting-time limits: a request that waits longer is dropped from its queue. */
export const DSM_QUEUE_WAIT_MS = 15_000;
export const LOCAL_QUEUE_WAIT_MS = 10_000;
export const LOGIN_FAILED = "로그인 실패: 아이디·비밀번호·OTP를 확인하세요.";
const SETTINGS_CHANGED = "로그인 설정이 바뀌었습니다. 다시 로그인하세요.";
export const globalDelayMs = (failures: number) => Math.min(Math.max(0, failures - GLOBAL_DELAY_AFTER) * GLOBAL_DELAY_STEP_MS, GLOBAL_DELAY_MAX_MS);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const CLIENT_IP_HEADER = "x-chatterbox-client-ip";
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 50_000;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");
const scryptAsync = (password: string, salt: Buffer, opts: ScryptOptions) => new Promise<Buffer>((ok, fail) =>
  scrypt(password, salt, 32, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (error, key) => error ? fail(error) : ok(key)));

/** Loopback, RFC 1918, CGNAT-free private ranges and IPv6 ULA/link-local (IPv4-mapped forms included). */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return isIP(v6) === 6 && (v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6));
}

const projectRootId =(path: string) => createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 12);

/**
 * Runs tasks with bounded concurrency. A task still waiting is dropped when it waits too long or its
 * client disconnects, and the number of waiting tasks is capped, so one stuck path cannot pile up.
 */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private concurrency: number, private maxWaiting: number) {}

  get size() { return this.active + this.waiting.length; }

  run<T>(task: () => Promise<T>, { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }): Promise<T> {
    if (signal.aborted) return Promise.reject(new HttpError(499, "요청이 취소되었습니다."));
    if (this.active >= this.concurrency && this.waiting.length >= this.maxWaiting)
      return Promise.reject(new HttpError(503, "로그인 요청이 많습니다. 잠시 후 다시 시도하세요.", { "Retry-After": "10" }));
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        clear();
        this.active++;
        // Free the slot before the caller resumes, so the next waiting task starts at once.
        const done = () => { this.active--; this.waiting.shift()?.(); };
        task().then(value => { done(); resolve(value); }, error => { done(); reject(error); });
      };
      const drop = (error: HttpError) => {
        const i = this.waiting.indexOf(start);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        clear();
        reject(error);
      };
      const timer = setTimeout(() => drop(new HttpError(503, "로그인 확인이 지연되고 있습니다. 잠시 후 다시 시도하세요.", { "Retry-After": "10" })), timeoutMs);
      const onAbort = () => drop(new HttpError(499, "요청이 취소되었습니다."));
      const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
      signal.addEventListener("abort", onAbort);
      if (this.active < this.concurrency) start();
      else this.waiting.push(start);
    });
  }
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), ...SCRYPT };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(stored.salt, "base64"), { N: stored.N, r: stored.r, p: stored.p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Origin only (scheme://host[:port]); https required except loopback. */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("접속 주소 형식이 올바르지 않습니다. 예: https://ai.damkina.net"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("접속 주소는 https:// 로 시작해야 합니다.");
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("접속 주소에는 경로 없이 도메인만 입력하세요.");
  return url.origin;
}

/** Minimum gap between run-statistics requests of one session. */
const RUN_STATS_INTERVAL_MS = 3000;

export class RemoteWeb {
  private config: Config;
  private server?: Server;
  private listening = false;
  private error?: string;
  private sessions = new Map<string, Session>();
  /** Last run-statistics request per session (they read a whole chat in the core). */
  private runStatsAt = new Map<string, number>();
  private streams = new Set<Stream>();
  private failures = new Map<string, Failures>();
  private allFailures: Failures = { count: 0, first: 0, lockedUntil: 0 };
  /** NAS checks run one at a time (precise per-account and NAS-wide limits); local scrypt checks run separately. */
  private dsmLimiter = new Limiter(1, 8);
  private localLimiter = new Limiter(4, 32);
  /**
   * When a NAS login was rejected, or sent with an unknown outcome (for the NAS-wide cap). Failures before
   * the login request is written are not counted (see DsmProvider.verify).
   */
  private dsmFailures: number[] = [];
  private pendingLogins = new Set<string>();
  /** Bumped by every password/policy change, logout-all and disable; an older verification cannot open a session. */
  private authGeneration = 0;
  /** Detailed reasons of recent failed logins, for the app's settings screen only. */
  private loginLog: RemoteWebLoginFailure[] = [];
  /** Remote state changes (desktop dialog only), newest first. */
  private auditLog: RemoteAuditEntry[] = [];
  private readonly features: RemoteFeatures;
  /** SSE message counter; snapshots carry the value at their start so clients replay only newer messages. */
  private seq = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private opts: {
    file: string; staticDir: string; call: CoreCall; now?: () => number; sleep?: (ms: number) => Promise<void>;
    /** Tell the desktop window about remote changes the core does not announce (chat:deleted, projects:updated). */
    notifyDesktop?: (channel: string, args: unknown[]) => void;
  }) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? (ms => new Promise(ok => setTimeout(ok, ms)));
    this.config = this.load();
    this.features = new RemoteFeatures({
      call: opts.call,
      body: (req, maxBytes) => this.body(req, maxBytes),
      send: (res, status, body, headers) => this.send(res, status, body, headers),
      publish: (channel, args) => { this.publish(channel, args); opts.notifyDesktop?.(channel, args); },
      audit: (session, action, target, detail) => {
        this.auditLog = [{ at: this.now(), user: session.user, ip: session.ip, action, target, detail: detail?.slice(0, 300) }, ...this.auditLog].slice(0, 50);
      },
      roots: () => this.config.projectRoots,
      uploadStorageBytes: () => Math.round(this.config.uploadStorageGb * 1024 ** 3),
      now: () => this.now(),
    });
  }

  private load(): Config {
    const fallback: Config = { enabled: false, port: REMOTE_WEB_DEFAULT_PORT, publicOrigin: REMOTE_WEB_DEFAULT_ORIGIN, provider: "local", dsm: { url: DSM_DEFAULT_URL, allowedUsers: [] }, trustProxy: true, dsmFailureLimit: DSM_FAILURE_LIMIT_DEFAULT, projectRoots: [], allowInternetEmergency: false, passwordLong: false, uploadStorageGb: REMOTE_UPLOAD_STORAGE.defaultGb };
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, "utf8"));
      const password = raw.password && typeof raw.password.salt === "string" && typeof raw.password.hash === "string" ? raw.password : undefined;
      const dsm: DsmSettings = {
        url: typeof raw.dsm?.url === "string" ? normalizeDsmUrl(raw.dsm.url) : DSM_DEFAULT_URL,
        certSha256: typeof raw.dsm?.certSha256 === "string" && raw.dsm.certSha256 ? normalizeFingerprint(raw.dsm.certSha256) : undefined,
        allowedUsers: Array.isArray(raw.dsm?.allowedUsers) ? raw.dsm.allowedUsers.filter((u: unknown) => typeof u === "string" && u) : [],
      };
      return {
        enabled: raw.enabled === true && !!password,
        port: Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? raw.port : fallback.port,
        publicOrigin: typeof raw.publicOrigin === "string" ? normalizeOrigin(raw.publicOrigin) : fallback.publicOrigin,
        password,
        provider: raw.provider === "synology-dsm" ? "synology-dsm" : "local",
        dsm,
        trustProxy: raw.trustProxy !== false,
        dsmFailureLimit: Number.isInteger(raw.dsmFailureLimit) && raw.dsmFailureLimit >= 1 && raw.dsmFailureLimit <= 9 ? raw.dsmFailureLimit : DSM_FAILURE_LIMIT_DEFAULT,
        projectRoots: Array.isArray(raw.projectRoots)
          ? raw.projectRoots.filter((r: any) => r && typeof r.path === "string" && isAbsolute(r.path) && typeof r.label === "string")
            .map((r: any) => ({ id: projectRootId(r.path), label: r.label.slice(0, 60), path: resolve(r.path), real: typeof r.real === "string" ? r.real : undefined, fileId: typeof r.fileId === "string" ? r.fileId : undefined }))
          : [],
        allowInternetEmergency: raw.allowInternetEmergency === true && raw.passwordLong === true,
        passwordLong: raw.passwordLong === true,
        uploadStorageGb: clampUploadStorageGb(raw.uploadStorageGb),
      };
    } catch { return fallback; }
  }

  private provider(id: RemoteAuthProvider): AuthProvider {
    if (id === "synology-dsm") return new DsmProvider(this.config.dsm);
    const stored = this.config.password;
    return {
      verify: async ({ password }): Promise<LoginResult> => stored && password.length <= 1024 && await verifyPassword(password, stored)
        ? { ok: true, user: "local" }
        : { ok: false, detail: "로컬 비밀번호 불일치", failure: true },
    };
  }

  private save() {
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.opts.file);
  }

  /** Actual listening port (differs from config only while restarting). */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : this.config.port;
  }

  status(): RemoteWebStatus {
    this.prune();
    return {
      enabled: this.config.enabled, port: this.config.port, publicOrigin: this.config.publicOrigin,
      passwordSet: !!this.config.password, running: this.listening, error: this.error,
      provider: this.config.provider,
      dsm: { url: this.config.dsm.url, certSha256: this.config.dsm.certSha256 ?? "", allowedUsers: this.config.dsm.allowedUsers },
      trustProxy: this.config.trustProxy,
      dsmFailureLimit: this.config.dsmFailureLimit,
      loginFailures: this.loginLog,
      projectRoots: this.config.projectRoots,
      audit: this.auditLog,
      allowInternetEmergency: this.config.allowInternetEmergency,
      emergencyPasswordLong: this.config.passwordLong,
      uploadStorageGb: this.config.uploadStorageGb,
      sessions: [...this.sessions.values()].map(({ id, user, createdAt, lastSeenAt, ip, userAgent }) => ({ id, user, createdAt, lastSeenAt, ip, userAgent }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    };
  }

  async action(action: RemoteWebAction, input: RemoteWebInput = {}): Promise<RemoteWebStatus> {
    if (action === "set-password") {
      const password = input.password ?? "";
      if (typeof password !== "string" || password.length < REMOTE_WEB_MIN_PASSWORD) throw new Error(`비밀번호는 ${REMOTE_WEB_MIN_PASSWORD}자 이상이어야 합니다.`);
      if (password.length > 1024) throw new Error("비밀번호가 너무 깁니다.");
      const passwordLong = password.length >= 20;
      // A shorter password cannot stay open to the internet.
      this.config = { ...this.config, password: await hashPassword(password), passwordLong, allowInternetEmergency: this.config.allowInternetEmergency && passwordLong };
      if (!this.config.allowInternetEmergency) this.endInternetEmergencySessions();
      this.save();
      this.logoutAll();
    } else if (action === "update") {
      const next = { ...this.config };
      if (input.port !== undefined) {
        if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error("포트는 1024~65535 사이의 정수여야 합니다.");
        next.port = input.port;
      }
      if (input.publicOrigin !== undefined) next.publicOrigin = normalizeOrigin(input.publicOrigin);
      const dsm = { ...next.dsm };
      if (input.dsmUrl !== undefined) dsm.url = normalizeDsmUrl(input.dsmUrl);
      if (input.dsmCertSha256 !== undefined) dsm.certSha256 = input.dsmCertSha256.trim() ? normalizeFingerprint(input.dsmCertSha256) : undefined;
      if (input.dsmAllowedUsers !== undefined) {
        if (!Array.isArray(input.dsmAllowedUsers) || input.dsmAllowedUsers.some(u => typeof u !== "string" || u.length > 128)) throw new Error("허용 계정 목록이 올바르지 않습니다.");
        dsm.allowedUsers = [...new Set(input.dsmAllowedUsers.map(u => u.trim().toLowerCase()).filter(Boolean))];
      }
      next.dsm = dsm;
      if (input.provider !== undefined) {
        if (input.provider !== "local" && input.provider !== "synology-dsm") throw new Error("지원하지 않는 로그인 방식입니다.");
        next.provider = input.provider;
      }
      if (next.provider === "synology-dsm" && !next.dsm.allowedUsers.length) throw new Error("NAS 로그인을 쓰려면 허용 계정을 한 개 이상 입력하세요.");
      if (input.trustProxy !== undefined) next.trustProxy = input.trustProxy === true;
      if (input.projectRoots !== undefined) {
        // D1: desktop-only list of folders under which remote users may create one new project folder.
        if (!Array.isArray(input.projectRoots) || input.projectRoots.length > 10) throw new Error("허용 위치 목록이 올바르지 않습니다.");
        next.projectRoots = input.projectRoots.map(r => {
          if (!r || typeof r.path !== "string" || !isAbsolute(r.path) || !existsSync(r.path) || !statSync(r.path).isDirectory()) throw new Error(`폴더를 찾을 수 없습니다: ${r?.path ?? ""}`);
          const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 60) : resolve(r.path).split(sep).pop() || r.path;
          // Keep an already registered root's pin; a new root is pinned to what it resolves to now.
          const known = this.config.projectRoots.find(x => x.path === resolve(r.path));
          const real = known?.real ?? realpathSync(r.path);
          return { id: projectRootId(r.path), label, path: resolve(r.path), real, fileId: known?.fileId ?? folderId(real) };
        });
      }
      if (input.allowInternetEmergency !== undefined) {
        if (input.allowInternetEmergency === true && !next.passwordLong) throw new Error("인터넷에서 비상용 로그인을 허용하려면 먼저 20자 이상의 비상용 비밀번호를 설정하세요.");
        next.allowInternetEmergency = input.allowInternetEmergency === true;
        if (!next.allowInternetEmergency) this.endInternetEmergencySessions();
      }
      if (input.uploadStorageGb !== undefined) {
        const gb = input.uploadStorageGb;
        if (typeof gb !== "number" || !Number.isFinite(gb) || gb < REMOTE_UPLOAD_STORAGE.minGb || gb > REMOTE_UPLOAD_STORAGE.maxGb)
          throw new Error(`원격 첨부 저장 한도는 ${REMOTE_UPLOAD_STORAGE.minGb}~${REMOTE_UPLOAD_STORAGE.maxGb}GB 사이여야 합니다.`);
        next.uploadStorageGb = gb;
      }
      if (input.dsmFailureLimit !== undefined) {
        if (!Number.isInteger(input.dsmFailureLimit) || input.dsmFailureLimit < 1 || input.dsmFailureLimit > 9) throw new Error("NAS 실패 상한은 1~9 사이의 정수여야 합니다.");
        next.dsmFailureLimit = input.dsmFailureLimit;
      }
      if (input.enabled !== undefined) {
        // The local password stays as the emergency login even when the NAS checks accounts.
        if (input.enabled && !next.password) throw new Error("먼저 원격 접속 비상용 비밀번호를 설정하세요.");
        next.enabled = input.enabled;
      }
      const restart = next.port !== this.config.port || next.enabled !== this.config.enabled;
      // A different origin or login rule changes who may hold a session.
      if (next.publicOrigin !== this.config.publicOrigin || !next.enabled || JSON.stringify([next.provider, next.dsm]) !== JSON.stringify([this.config.provider, this.config.dsm])) this.logoutAll();
      this.config = next;
      this.save();
      if (restart) await this.apply();
    } else if (action === "dsm-probe") {
      const url = input.dsmUrl ?? this.config.dsm.url;
      try {
        const probe = await probeDsm(url);
        const pinned = this.config.dsm.certSha256;
        return { ...this.status(), dsmProbe: { fingerprint: probe.fingerprint, trusted: pinned ? pinned === probe.fingerprint : probe.trusted, authPath: probe.authPath } };
      } catch (error) {
        return { ...this.status(), dsmProbe: { fingerprint: "", trusted: false, error: error instanceof Error ? error.message : String(error) } };
      }
    } else if (action === "logout-all") this.logoutAll();
    else if (action === "revoke") {
      for (const session of this.sessions.values()) if (session.id === input.sessionId) this.endSession(session.key);
    } else if (action !== "status") throw new Error("지원하지 않는 원격 웹 설정 작업입니다.");
    return this.status();
  }

  /** Start or stop the listener to match the saved settings. */
  async apply(): Promise<void> {
    await this.close();
    this.error = undefined;
    if (!this.config.enabled || !this.config.password) return;
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 30_000;
    try {
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(this.config.port, "127.0.0.1", () => { server.off("error", fail); ok(); });
      });
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `포트 ${this.config.port}을(를) 다른 프로그램이 사용 중입니다.` : String((error as Error).message ?? error);
      return;
    }
    this.server = server;
    this.listening = true;
    this.heartbeat = setInterval(() => {
      this.prune();
      for (const stream of this.streams) stream.res.write(": ping\n\n");
    }, 25_000);
  }

  private async close() {
    clearInterval(this.heartbeat);
    for (const stream of this.streams) stream.res.end();
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = false;
    if (server) await new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections(); });
  }

  async stop() { await this.close(); }

  /** Ends every session and invalidates logins still being verified (password/policy change, disable, logout-all). */
  logoutAll() {
    this.authGeneration++;
    for (const key of [...this.sessions.keys()]) this.endSession(key);
  }

  /** Internet use of the emergency password was withdrawn: end those sessions and void logins in flight. */
  private endInternetEmergencySessions() {
    this.authGeneration++;
    for (const s of [...this.sessions.values()]) if (s.provider === "local" && (s.clientKind === "internet" || s.clientKind === "unknown")) this.endSession(s.key);
  }

  private endSession(key: string) {
    this.sessions.delete(key);
    for (const stream of this.streams) if (stream.sessionKey === key) { stream.res.end(); this.streams.delete(stream); }
  }

  private prune() {
    const now = this.now();
    for (const session of [...this.sessions.values()])
      if (now - session.lastSeenAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_MS) this.endSession(session.key);
  }

  /** Forward core change events (the same ones the desktop window receives) to open streams. */
  publish(channel: string, args: unknown[]) {
    const seq = ++this.seq;
    if (!this.streams.size) return;
    const chatId = channel === "chat:event" ? (args[0] as { chatId?: number })?.chatId
      : channel === "agents:updated" ? args[0] as number
      : channel === "consult:updated" ? (args[0] as { chatId?: number })?.chatId
      : undefined;
    // chat:updated, chat:deleted and projects:updated go to every stream; other events only to their chat.
    const broadcast = channel === "chat:updated" || channel === "chat:deleted" || channel === "projects:updated";
    if (!broadcast && chatId === undefined) return;
    const data = `id: ${seq}\nevent: ${channel}\ndata: ${JSON.stringify(channel === "chat:event" ? stripLocalPaths(args) : args)}\n\n`;
    for (const stream of this.streams) if (broadcast || stream.chatId === chatId) stream.res.write(data);
  }

  // ---------- HTTP

  private allowedHosts() {
    return new Set([new URL(this.config.publicOrigin).host, `127.0.0.1:${this.port}`, `localhost:${this.port}`]);
  }

  private allowedOrigins() {
    return new Set([this.config.publicOrigin, `http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
  }

  /**
   * The client IP comes from X-ChatterBox-Client-IP, which the Caddy site block sets from its own
   * verified {client_ip} (header_up replaces anything the browser sent). It is used only when the
   * setting says Caddy sits in front and the peer really is loopback; X-Forwarded-For is never used.
   */
  clientIp(req: Pick<IncomingMessage, "headers" | "socket">): string {
    return this.client(req).ip;
  }

  /**
   * Where a request comes from. Fails closed: anything that is not clearly this PC or a known client
   * IP is "unknown" (one shared lock bucket, never treated as LAN).
   * - local: direct loopback access to 127.0.0.1/localhost:port without the proxy header (this PC)
   * - lan / internet: the Caddy header, trusted only with trustProxy and a loopback peer
   * - unknown: the header is missing (e.g. a public Host without it), invalid, or not trusted
   */
  client(req: Pick<IncomingMessage, "headers" | "socket">): { ip: string; kind: ClientKind } {
    const peer = req.socket.remoteAddress ?? "";
    const header = req.headers[CLIENT_IP_HEADER];
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!LOOPBACK.has(peer)) return { ip: peer.slice(0, 64) || "unknown", kind: isPrivateIp(peer) ? "lan" : "internet" };
    if (header === undefined)
      return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}` ? { ip: peer, kind: "local" } : { ip: "unknown", kind: "unknown" };
    const value = typeof header === "string" ? header.trim() : "";
    if (!this.config.trustProxy || !isIP(value)) return { ip: "unknown", kind: "unknown" };
    return { ip: value, kind: isPrivateIp(value) ? "lan" : "internet" };
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      // DNS rebinding: only our own hostnames may address this server.
      if (!this.allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) throw new HttpError(421, "허용되지 않은 호스트입니다.");
      const url = new URL(req.url ?? "/", "http://local");
      const method = req.method ?? "GET";
      if (method === "POST") this.checkOrigin(req);
      else if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "지원하지 않는 요청입니다.");
      if (!url.pathname.startsWith("/api/")) return this.serveStatic(url.pathname, res);
      if (url.pathname === "/api/login" && method === "POST") return await this.login(req, res);
      // Part of the login page: which form to show. No account or settings detail.
      if (url.pathname === "/api/auth-info" && method === "GET") return this.send(res, 200, { provider: this.config.provider });
      const session = this.authenticate(req);
      if (method === "POST" && !this.csrfOk(req, session)) throw new HttpError(403, "보안 토큰이 맞지 않습니다. 페이지를 새로고침하세요.");
      await this.route(method, url, req, res, session);
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof HttpError) return this.send(res, error.status, { error: error.message }, error.headers);
      this.send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private checkOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (typeof origin !== "string" || !this.allowedOrigins().has(origin) || (site !== undefined && site !== "same-origin"))
      throw new HttpError(403, "허용되지 않은 출처의 요청입니다.");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON 요청만 받습니다.");
  }

  private csrfOk(req: IncomingMessage, session: Session) {
    const supplied = Buffer.from(String(req.headers["x-csrf-token"] ?? ""));
    const expected = Buffer.from(session.csrf);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private authenticate(req: IncomingMessage): Session {
    const cookie = String(req.headers.cookie ?? "").split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    this.prune();
    const session = cookie ? this.sessions.get(sha256(cookie)) : undefined;
    if (!session) throw new HttpError(401, "로그인이 필요합니다.");
    session.lastSeenAt = this.now();
    return session;
  }

  private async body(req: IncomingMessage, maxBytes = MAX_BODY): Promise<any> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "요청이 너무 큽니다.");
      chunks.push(chunk as Buffer);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new HttpError(400, "요청 형식이 올바르지 않습니다."); }
  }

  private locked(failures: Failures | undefined, now: number) {
    return failures && failures.lockedUntil > now ? failures.lockedUntil : 0;
  }

  private recordFailure(key: string, limit: number, now: number) {
    const failures = key === "all" ? this.allFailures : this.failures.get(key) ?? { count: 0, first: now, lockedUntil: 0 };
    if (key !== "all") this.failures.set(key, failures);
    if (now - failures.first > FAIL_WINDOW_MS) { failures.count = 0; failures.first = now; }
    failures.count++;
    if (failures.count >= limit) failures.lockedUntil = now + LOCK_MS;
  }

  private async login(req: IncomingMessage, res: ServerResponse) {
    const started = performance.now();
    // Captured on arrival: a password/policy change, logout-all or disable after this point voids the
    // request, whether it is still waiting in a queue, being verified, or about to get its session.
    const generation = this.authGeneration;
    const body = await this.body(req);
    const { ip, kind } = this.client(req);
    if (this.pendingLogins.has(ip)) throw new HttpError(429, "이전 로그인 확인이 끝난 뒤 다시 시도하세요.");
    this.pendingLogins.add(ip);
    const left = new AbortController();
    res.once("close", () => { if (!res.writableEnded) left.abort(); });
    let user: string | undefined;
    let failure: unknown;
    try { user = await this.verifyLogin(ip, kind, body, generation, left.signal); }
    catch (error) { failure = error; }
    finally { this.pendingLogins.delete(ip); }
    if (left.signal.aborted) return void res.destroy();
    // Pad to a fixed time bucket; outside every queue so it does not slow other clients.
    await this.sleep(loginPaddingMs(performance.now() - started));
    if (failure) throw failure;
    if (!user || generation !== this.authGeneration || !this.listening) throw new HttpError(401, SETTINGS_CHANGED);
    const now = this.now();
    const secret = token(32);
    const session: Session = {
      key: sha256(secret), csrf: token(24), id: token(9), user, createdAt: now, lastSeenAt: now, ip,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
      provider: body.provider === "local" || this.config.provider === "local" ? "local" : this.config.provider, clientKind: kind,
    };
    this.sessions.set(session.key, session);
    this.send(res, 200, { csrf: session.csrf }, {
      "Set-Cookie": `${COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`,
    });
  }

  private async verifyLogin(ip: string, kind: ClientKind, body: Record<string, unknown>, generation: number, signal: AbortSignal): Promise<string> {
    // The configured provider, or the local password as the emergency login.
    const id = body.provider === undefined ? this.config.provider : body.provider;
    if (id !== "local" && id !== this.config.provider) throw new HttpError(400, "지원하지 않는 로그인 방식입니다.");
    const { password, username, otp } = body;
    const account = id === "local" ? "local" : typeof username === "string" ? username.trim().toLowerCase().slice(0, 128) : "";
    const ipKey = `ip:${ip}`, accountKey = `account:${id}:${account}`;
    const checkLocks = () => {
      const now = this.now();
      const until = Math.max(this.locked(this.failures.get(ipKey), now), this.locked(this.failures.get(accountKey), now));
      if (until) throw new HttpError(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.", { "Retry-After": String(Math.ceil((until - now) / 1000)) });
    };
    checkLocks();
    // Global slow-down: an individual wait before queuing, so it never holds a queue slot.
    const recent = this.now() - this.allFailures.first > FAIL_WINDOW_MS ? 0 : this.allFailures.count;
    const delay = globalDelayMs(recent);
    if (delay) await this.sleep(delay);
    // NAS checks and local scrypt checks have separate queues: a stuck or flooded NAS path never blocks
    // the local emergency login.
    const limiter = id === "local" ? this.localLimiter : this.dsmLimiter;
    return limiter.run(async () => {
      if (generation !== this.authGeneration) throw new HttpError(401, SETTINGS_CHANGED);
      checkLocks();
      const now = this.now();
      this.dsmFailures = this.dsmFailures.filter(at => now - at < DSM_FAILURE_WINDOW_MS);
      // The emergency password has no OTP: by default only this PC or LAN clients may use it, and never
      // a client whose IP is unknown (fail closed).
      const emergencyBlocked = id === "local" && (kind === "unknown" || (kind === "internet" && !this.config.allowInternetEmergency));
      const result: LoginResult = emergencyBlocked
        ? { ok: false, detail: kind === "unknown" ? "접속자 IP를 확인할 수 없어 비상용 로그인을 거부했습니다(프록시 헤더 누락·설정 확인)." : "비상용 로컬 비밀번호는 LAN에서만 사용할 수 있습니다(인터넷 접속 차단).", failure: true }
        : typeof password !== "string" || !password || password.length > 1024
        || (username !== undefined && typeof username !== "string") || (otp !== undefined && otp !== "" && typeof otp !== "string")
        ? { ok: false, detail: "요청 형식 오류(비밀번호 없음 등)", failure: true }
        // NAS-wide cap below DSM's auto-block, across all allowed accounts; the NAS is not contacted.
        : id === "synology-dsm" && this.dsmFailures.length >= this.config.dsmFailureLimit
          ? { ok: false, detail: `NAS 보호: 최근 5분 동안 NAS 로그인 실패 ${this.dsmFailures.length}회로 NAS 확인을 멈췄습니다.`, failure: false }
          : await this.provider(id as RemoteAuthProvider).verify({ username: username as string | undefined, password, otp: (otp as string) || undefined });
      if (!result.ok) {
        this.loginLog = [{ at: now, ip, provider: id as RemoteAuthProvider, user: account || "(빈 아이디)", detail: result.detail }, ...this.loginLog].slice(0, 30);
        if (result.nasRejected) this.dsmFailures.push(now);
        if (result.failure) {
          if (this.failures.size > 10_000) this.failures.clear();
          this.recordFailure(ipKey, FAIL_LIMIT_IP, now);
          if (id !== "local") this.recordFailure(accountKey, FAIL_LIMIT_ACCOUNT, now);
          this.recordFailure("all", Infinity, now);
        }
        // Wrong id, password, OTP, account state or an unreachable NAS all look the same from outside.
        throw new HttpError(401, LOGIN_FAILED);
      }
      this.failures.delete(ipKey);
      this.failures.delete(accountKey);
      return result.user;
    }, { timeoutMs: id === "local" ? LOCAL_QUEUE_WAIT_MS : DSM_QUEUE_WAIT_MS, signal });
  }

  private chatId(value: string): number {
    if (!/^\d{1,12}$/.test(value)) throw new HttpError(404, "채팅이 없습니다.");
    return Number(value);
  }

  private text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field}을(를) 입력하세요.`);
    if (value.length > MAX_TEXT) throw new HttpError(413, `${field}이(가) 너무 깁니다.`);
    return value;
  }

  private async route(method: string, url: URL, req: IncomingMessage, res: ServerResponse, session: Session) {
    const call = this.opts.call;
    const path = url.pathname;
    if (method === "GET" && path === "/api/session") return this.send(res, 200, { csrf: session.csrf, user: session.user, publicOrigin: this.config.publicOrigin });
    if (method === "POST" && path === "/api/logout") {
      this.endSession(session.key);
      return this.send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (method === "GET" && path === "/api/chats") {
      const seq = this.seq;
      const [chats, projects] = await Promise.all([call("chats:list", []), call("projects:list", [])]);
      return this.send(res, 200, { seq, chats, projects: (projects as { id: number; name: string; archived: boolean }[]).map(({ id, name, archived }) => ({ id, name, archived })) });
    }
    if (method === "GET" && path === "/api/stream") {
      const chat = url.searchParams.get("chat");
      const stream: Stream = { res, sessionKey: session.key, chatId: chat ? this.chatId(chat) : null };
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      this.streams.add(stream);
      req.on("close", () => this.streams.delete(stream));
      return;
    }
    // Extended API (docs/remote-web-features.md); same session/CSRF/Origin/Host checks already passed.
    if (await this.features.handle(method, url, req, res, { key: session.key, user: session.user, ip: session.ip })) return;
    const stats = /^\/api\/chats\/(\d{1,12})\/run-stats$/.exec(path);
    if (stats) {
      // Aggregated in the core (the rows only); one request per session every RUN_STATS_INTERVAL_MS.
      if (method !== "GET") throw new HttpError(405, "지원하지 않는 요청입니다.");
      const last = this.runStatsAt.get(session.key) ?? 0;
      if (this.now() - last < RUN_STATS_INTERVAL_MS) throw new HttpError(429, "잠시 뒤 다시 시도하세요.");
      this.runStatsAt.set(session.key, this.now());
      const rows = await call("chats:runStats", [this.chatId(stats[1]), url.searchParams.get("live") === "1" ? Date.now() : undefined]);
      return this.send(res, 200, { rows });
    }
    const m = /^\/api\/chats\/([^/]+)(?:\/(stop|approve|answer))?$/.exec(path);
    if (!m) throw new HttpError(404, "없는 주소입니다.");
    const id = this.chatId(m[1]);
    if (method === "GET" && !m[2]) {
      // Stream messages after this number may be missing from the snapshot; the client replays them.
      const seq = this.seq;
      const chats = await call("chats:list", []) as { id: number }[];
      const chat = chats.find(c => c.id === id);
      if (!chat) throw new HttpError(404, "채팅이 없습니다.");
      // History comes in pages (shared/event-page.ts): the newest one here, older ones with ?before=<event id>.
      const before = url.searchParams.get("before");
      if (before !== null) {
        if (!/^\d{1,15}$/.test(before)) throw new HttpError(400, "기록 위치가 올바르지 않습니다.");
        const page = await call("chats:eventsPage", [id, Number(before)]) as EventPage;
        return this.send(res, 200, { ...page, events: stripLocalPaths(page.events) });
      }
      const [page, agents, consults] = await Promise.all([call("chats:eventsPage", [id]) as Promise<EventPage>, call("chats:agents", [id]), call("chats:consults", [id])]);
      return this.send(res, 200, { seq, chat, events: stripLocalPaths(page.events), context: stripLocalPaths(page.context ?? []), start: page.start, hasMore: page.hasMore, agents, consults });
    }
    if (method !== "POST" || !m[2]) throw new HttpError(405, "지원하지 않는 요청입니다.");
    const body = await this.body(req);
    if (m[2] === "stop") await call("chats:stop", [id]);
    else if (m[2] === "approve") {
      if (typeof body.approvalId !== "string" || !["once", "chat", "deny"].includes(body.decision)) throw new HttpError(400, "승인 응답 형식이 올바르지 않습니다.");
      const decision = await call("chats:approve", [id, body.approvalId, body.decision]);
      if (decision == null) throw new HttpError(409, "이미 처리됐거나 만료된 승인 요청입니다.");
      return this.send(res, 200, { decision });
    } else {
      if (typeof body.askId !== "string") throw new HttpError(400, "답변 형식이 올바르지 않습니다.");
      if (!(await call("chats:answerAsk", [id, body.askId, this.text(body.answer, "답변")]))) throw new HttpError(409, "이미 답변했거나 만료된 질문입니다.");
    }
    this.send(res, 200, { ok: true });
  }

  private serveStatic(pathname: string, res: ServerResponse) {
    const root = resolve(this.opts.staticDir);
    const file = pathname === "/" ? join(root, "remote.html") : pathname.startsWith("/assets/") ? resolve(root, `.${decodeURIComponent(pathname)}`) : "";
    if (!file || !(file === join(root, "remote.html") || file.startsWith(join(root, "assets") + sep)) || !existsSync(file) || !statSync(file).isFile())
      throw new HttpError(404, "없는 주소입니다.");
    const html = file.endsWith(".html");
    res.writeHead(200, {
      ...SECURITY_HEADERS, "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": html ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(readFileSync(file));
  }
}

// Login providers for the remote web server. A provider only checks credentials; sessions, the login
// lockout and CSRF stay in remote-web.ts and apply to every provider alike.
//  - local: the app's own scrypt password (kept as the emergency login)
//  - synology-dsm: the NAS checks id/password/OTP through the DSM Web API (SYNO.API.Auth); nothing is stored
// shortcut: OIDC (Synology SSO Server etc.) is not implemented yet; add another AuthProvider when needed.
import { request as httpRequest } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { isIP } from "node:net";

export type AuthProviderId = "local" | "synology-dsm";
export interface LoginInput { username?: string; password: string; otp?: string }
/**
 * failure = counts toward the login lockout (wrong credentials), not for NAS/network faults.
 * detail is for the app's own settings screen only; the browser always gets one uniform message.
 */
export type LoginResult = { ok: true; user: string } | { ok: false; failure: boolean; detail: string; nasRejected?: boolean };
export interface AuthProvider { verify(input: LoginInput): Promise<LoginResult> }

export interface DsmSettings {
  url: string;
  /** SHA-256 certificate fingerprint (64 hex) for a self-signed DSM certificate; absent = normal CA validation. */
  certSha256?: string;
  /** Lowercase DSM account names allowed to log in. Empty = nobody. */
  allowedUsers: string[];
}
export const DSM_DEFAULT_URL = "https://192.168.0.250:5001";
const DSM_SESSION = "ChatterBoxRemote";
// Per request; a login is two requests (API info + login), so a dead NAS answers within ~5 s.
const TIMEOUT_MS = 2_500;
const BAD_CREDENTIALS = "아이디 또는 비밀번호가 맞지 않습니다.";

/** DSM SYNO.API.Auth error codes → message and whether it is a credential failure. */
const DSM_ERRORS: Record<number, [string, boolean]> = {
  400: [BAD_CREDENTIALS, true],
  401: ["NAS에서 비활성화된 계정입니다.", true],
  402: ["이 계정은 NAS 로그인 권한이 없습니다.", true],
  403: ["2단계 인증 코드(OTP)를 입력하세요.", true],
  404: ["2단계 인증 코드(OTP)가 맞지 않습니다.", true],
  406: ["이 계정은 NAS에서 2단계 인증 설정이 필요합니다.", false],
  407: ["NAS가 이 접속 IP를 차단했습니다. DSM 보안 설정의 자동 차단 목록을 확인하세요.", false],
  408: ["NAS 계정 비밀번호가 만료되었습니다. DSM에서 비밀번호를 바꾸세요.", false],
  409: ["NAS 계정 비밀번호가 만료되었습니다. DSM에서 비밀번호를 바꾸세요.", false],
  410: ["NAS 계정 비밀번호를 바꿔야 합니다. DSM에서 먼저 변경하세요.", false],
};

export function normalizeFingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 64) throw new Error("인증서 지문은 SHA-256 값(16진수 64자리)이어야 합니다.");
  return hex;
}

export function normalizeDsmUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("NAS 주소 형식이 올바르지 않습니다. 예: https://192.168.0.250:5001"); }
  if (url.protocol !== "https:") throw new Error("NAS 주소는 https:// 로 시작해야 합니다. 비밀번호가 평문으로 전송되지 않게 합니다.");
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("NAS 주소에는 경로 없이 호스트와 포트만 입력하세요.");
  return url.origin;
}

interface DsmResponse { fingerprint: string; trusted: boolean; body: any }

/** `sent` = the request had been written to the NAS before the failure (outcome unknown). */
export class DsmRequestError extends Error {
  constructor(message: string, readonly sent: boolean) { super(message); }
}

/**
 * One HTTPS request to DSM. The TLS handshake (and the certificate pin) is checked before any
 * request byte is written, so credentials never reach a server with the wrong certificate.
 * `probe` allows an unverified certificate for the credential-free API info query only.
 */
function dsmRequest(settings: Pick<DsmSettings, "url" | "certSha256">, path: string, form?: URLSearchParams, probe = false): Promise<DsmResponse> {
  const url = new URL(settings.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || 443);
  const pin = settings.certSha256;
  return new Promise((resolve, reject) => {
    let settled = false;
    // Becomes true once request bytes are handed to the verified socket; failures after that point
    // (timeout, lost/garbled answer, dropped connection) may have been processed by the NAS.
    let sent = false;
    const done = (error?: Error, value?: DsmResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { socket.destroy(); reject(new DsmRequestError(error.message, sent)); } else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error("NAS 응답 시간이 초과되었습니다.")), TIMEOUT_MS);
    // A pinned self-signed certificate cannot pass CA validation; the pin replaces it for this socket only.
    const socket: TLSSocket = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: !pin && !probe });
    socket.once("error", error => done(new Error(`NAS에 연결하지 못했습니다: ${error.message}`)));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate().fingerprint256;
      if (!raw) return done(new Error("NAS 인증서를 읽지 못했습니다."));
      const fingerprint = normalizeFingerprint(raw);
      const trusted = pin ? fingerprint === pin : socket.authorized;
      if (!trusted && !probe) return done(new Error("NAS 인증서 지문이 설정과 다릅니다. 인증서가 바뀌었는지 확인한 뒤 지문을 다시 고정하세요."));
      const body = form?.toString();
      const req = httpRequest({
        host, port, path, method: body === undefined ? "GET" : "POST", createConnection: () => socket,
        headers: { Host: url.host, ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }) },
      }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; if (text.length > 1024 * 1024) done(new Error("NAS 응답이 너무 큽니다.")); });
        res.on("end", () => {
          try { done(undefined, { fingerprint, trusted, body: JSON.parse(text) }); }
          catch { done(new Error(`NAS 응답을 해석하지 못했습니다 (HTTP ${res.statusCode}).`)); }
          socket.end();
        });
      });
      req.once("error", error => done(new Error(`NAS 요청에 실패했습니다: ${error.message}`)));
      sent = true;
      req.end(body);
    });
  });
}

interface AuthApi { path: string; version: number }

async function authApi(settings: Pick<DsmSettings, "url" | "certSha256">, probe = false): Promise<AuthApi & { fingerprint: string; trusted: boolean }> {
  const { body, fingerprint, trusted } = await dsmRequest(settings, "/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth", undefined, probe);
  const info = body?.data?.["SYNO.API.Auth"];
  if (!body?.success || typeof info?.path !== "string" || !/^[\w.-]+\.cgi$/.test(info.path)) throw new Error("NAS에서 DSM 로그인 API를 찾지 못했습니다.");
  // Version 6 accepts otp_code and format=sid on DSM 6 and 7.
  const version = Math.max(Number(info.minVersion) || 1, Math.min(Number(info.maxVersion) || 6, 6));
  return { path: info.path, version, fingerprint, trusted };
}

/** Credential-free check: certificate fingerprint and whether the DSM login API answers. */
export async function probeDsm(url: string): Promise<{ fingerprint: string; trusted: boolean; authPath: string; version: number }> {
  const api = await authApi({ url: normalizeDsmUrl(url) }, true);
  return { fingerprint: api.fingerprint, trusted: api.trusted, authPath: api.path, version: api.version };
}

export class DsmProvider implements AuthProvider {
  constructor(private settings: DsmSettings) {}

  async verify({ username, password, otp }: LoginInput): Promise<LoginResult> {
    const account = (username ?? "").trim();
    if (!this.settings.allowedUsers.length) return { ok: false, detail: "원격 접속을 허용한 NAS 계정이 없습니다. 허용 계정을 추가하세요.", failure: false };
    if (!account || account.length > 128) return { ok: false, detail: "NAS 아이디가 비어 있습니다.", failure: true };
    // Unlisted ids never reach the NAS, so this page cannot be used to probe other DSM accounts.
    // (The server pads every login to the same minimum time, so the skipped NAS round trip is not visible.)
    if (!this.settings.allowedUsers.includes(account.toLowerCase())) return { ok: false, detail: `허용 목록에 없는 아이디(${account.slice(0, 64)})`, failure: true };
    if (otp !== undefined && !/^\d{6,8}$/.test(otp)) return { ok: false, detail: "OTP 형식 오류(6~8자리 숫자 아님)", failure: true };
    let api: AuthApi;
    let login: any;
    // Failures before the login request is written (TLS pin mismatch, refused connection, SYNO.API.Info
    // step) cannot raise DSM's failed-login count and are not counted. Once the login request was sent,
    // an unknown outcome (timeout, lost or unparsable answer, dropped connection) is counted toward the
    // NAS-wide cap as if the NAS had rejected it: the NAS may well have counted a failure.
    try {
      api = await authApi(this.settings);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error), failure: false };
    }
    try {
      const form = new URLSearchParams({ api: "SYNO.API.Auth", version: String(api.version), method: "login", account, passwd: password, session: DSM_SESSION, format: "sid" });
      if (otp) form.set("otp_code", otp);
      login = (await dsmRequest(this.settings, `/webapi/${api.path}`, form)).body;
    } catch (error) {
      const sent = error instanceof DsmRequestError && error.sent;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: sent ? `${message} (로그인 요청은 전송됨 · 결과 불명이라 NAS 보호 상한에 포함)` : message, failure: false, nasRejected: sent };
    }
    if (!login?.success) {
      const code = Number(login?.error?.code);
      const [message, failure] = DSM_ERRORS[code] ?? ["NAS 로그인에 실패했습니다.", false];
      // nasRejected: the NAS counted (or may have counted) a failed login; its auto-block counts these per source IP.
      return { ok: false, detail: `${message} (DSM 오류 ${Number.isFinite(code) ? code : "알 수 없음"})`, failure, nasRejected: true };
    }
    // Only the yes/no answer is needed; end the DSM session at once and never keep the sid.
    // Not awaited, so a slow logout does not hold the login queue.
    const sid = typeof login.data?.sid === "string" ? login.data.sid : "";
    if (sid) void dsmRequest(this.settings, `/webapi/${api.path}`, new URLSearchParams({ api: "SYNO.API.Auth", version: String(api.version), method: "logout", session: DSM_SESSION, _sid: sid })).catch(() => undefined);
    return { ok: true, user: account.toLowerCase() };
  }
}

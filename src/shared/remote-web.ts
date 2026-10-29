// Remote web access (browser → Caddy → 127.0.0.1 → this app). Shared by main, preload and renderer.

export const REMOTE_WEB_DEFAULT_PORT = 47821;
export const REMOTE_WEB_DEFAULT_ORIGIN = "https://ai.damkina.net";
export const REMOTE_WEB_MIN_PASSWORD = 12;

/** local = the app's own password (always kept as the emergency login); synology-dsm = NAS account. */
export type RemoteAuthProvider = "local" | "synology-dsm";

export interface RemoteWebSession {
  /** Public id for listing/revoking; never the cookie value. */
  id: string;
  /** "local" or the DSM account name. */
  user: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
  userAgent: string;
}

export interface RemoteWebDsmSettings {
  url: string;
  /** Pinned SHA-256 certificate fingerprint (64 hex); empty = normal CA validation. */
  certSha256: string;
  allowedUsers: string[];
}

export interface RemoteWebDsmProbe {
  fingerprint: string;
  /** Certificate passes CA validation or matches the pinned fingerprint. */
  trusted: boolean;
  authPath?: string;
  error?: string;
}

/** A failed login with its real reason; shown only in the app (the browser gets one uniform message). */
export interface RemoteWebLoginFailure {
  at: number;
  ip: string;
  provider: RemoteAuthProvider;
  user: string;
  detail: string;
}

export interface RemoteWebStatus {
  enabled: boolean;
  port: number;
  /** Browser origin allowed for state-changing requests, e.g. https://ai.damkina.net */
  publicOrigin: string;
  /** Local (emergency) password. */
  passwordSet: boolean;
  provider: RemoteAuthProvider;
  dsm: RemoteWebDsmSettings;
  /** Use X-ChatterBox-Client-IP set by the loopback reverse proxy (Caddy) as the client IP. */
  trustProxy: boolean;
  /** Max NAS-rejected logins per 5 minutes before NAS checks pause (below DSM's auto-block). */
  dsmFailureLimit: number;
  /** Most recent first. */
  loginFailures: RemoteWebLoginFailure[];
  /** Listening on 127.0.0.1:port right now. */
  running: boolean;
  error?: string;
  sessions: RemoteWebSession[];
  /** Only on the "dsm-probe" action. */
  dsmProbe?: RemoteWebDsmProbe;
}

export type RemoteWebAction = "status" | "update" | "set-password" | "logout-all" | "revoke" | "dsm-probe";
export interface RemoteWebInput {
  enabled?: boolean;
  port?: number;
  publicOrigin?: string;
  password?: string;
  sessionId?: string;
  provider?: RemoteAuthProvider;
  dsmUrl?: string;
  /** "" clears the pin. */
  dsmCertSha256?: string;
  dsmAllowedUsers?: string[];
  trustProxy?: boolean;
  dsmFailureLimit?: number;
}

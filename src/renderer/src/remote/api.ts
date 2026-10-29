// Browser client for the remote web server (src/main/remote-web.ts). Same-origin only.
import { remotePath, type RemoteApiPath } from "../../../shared/remote-web";

export class AuthError extends Error {}
/** Any other non-2xx answer; `status` lets callers react to 409/413/428/429/507 (the message is shown as is). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let csrf = "";
export const setCsrf = (value: string) => { csrf = value; };

export async function request<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error ?? "로그인이 필요합니다.");
  if (!res.ok) throw new ApiError(data.error ?? `요청 실패 (${res.status})`, res.status);
  return data as T;
}

/** REMOTE_API path with `:id` filled and an optional query string. */
export function url(path: RemoteApiPath, id?: number, query?: Record<string, string>): string {
  const base = remotePath(path, id);
  return query ? `${base}?${new URLSearchParams(query)}` : base;
}

/**
 * POST that may need the D3 confirmation: the server answers 428 when a change raises autonomy.
 * `confirm` asks the user; on yes the same body is sent again with `confirm: true`.
 * Resolves to undefined when the user declines.
 */
export async function postConfirmed<T>(path: string, body: Record<string, unknown>, confirm: (message: string) => Promise<boolean>): Promise<T | undefined> {
  try {
    return await request<T>(path, body);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 428) throw e;
    if (!(await confirm(e.message))) return undefined;
    return request<T>(path, { ...body, confirm: true });
  }
}

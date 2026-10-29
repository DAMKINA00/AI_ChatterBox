// Browser client for the remote web server (src/main/remote-web.ts). Same-origin only.
export class AuthError extends Error {}

let csrf = "";
export const setCsrf = (value: string) => { csrf = value; };

export async function request<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined
    ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error ?? "로그인이 필요합니다.");
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data as T;
}

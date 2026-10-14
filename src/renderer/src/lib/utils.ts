import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { timeAgo } from "./time";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const api = window.chatterbox;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // ipcRenderer.invoke wraps main-process errors: "Error invoking remote method 'x': Error: msg"
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

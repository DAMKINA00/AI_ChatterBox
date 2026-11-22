// Remote web mode: the desktop renderer (App, Sidebar, ChatView…) running in a browser on top of the
// remote API adapter (src/renderer/src/remote/desktop-api.ts) instead of the Electron preload.
// The remote entry sets window.__CBX_REMOTE__ before any renderer module loads; the desktop never does.
// Must not import lib/utils (utils reads window.chatterbox when it loads).
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import type { RemoteForkAnchorResponse, RemoteProjectPatch, RemoteUsageGroup } from "../../../shared/remote-web";
import type { Project } from "../../../shared/types";

declare global {
  interface Window { __CBX_REMOTE__?: boolean }
}

export const isRemote = (): boolean => typeof window !== "undefined" && window.__CBX_REMOTE__ === true;

export class RemoteDeleteTargetChanged extends Error {}

/** Unsent remote uploads (id → uuid): their bytes are readable only with the uuid. */
export const pendingUploads = new Map<number, string>();

/** Image source of an attachment: the app protocol on the desktop, the authenticated download route on the web. */
export function attachmentSrc(id: number, chatId: number | undefined): string {
  if (!isRemote()) return `cbx://attachment/${id}`;
  const uuid = pendingUploads.get(id);
  return `/api/attachments/${id}?${new URLSearchParams({ chat: String(chatId ?? 0), ...(uuid ? { uuid } : {}) })}`;
}

/** Usage view the remote server computes (GET /api/usage): the desktop panel's groups, read-only. */
export const useRemoteUsage = create<{ groups: RemoteUsageGroup[]; loaded: boolean }>(() => ({ groups: [], loaded: false }));

/** Phone-sized remote page (the desktop app never switches to the mobile layout). */
export const MOBILE_QUERY = "(max-width: 767px)";
const subscribeMobile = (cb: () => void) => {
  if (!isRemote()) return () => undefined;
  const m = window.matchMedia(MOBILE_QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const mobileNow = () => isRemote() && window.matchMedia(MOBILE_QUERY).matches;
export const useMobile = (): boolean => useSyncExternalStore(subscribeMobile, mobileNow, () => false);

/** Actions only the remote page has; set by the page shell (remote/DesktopShell.tsx). */
export const remoteActions: {
  signOut?: () => Promise<void>;
  saveProject?: (id: number, patch: RemoteProjectPatch) => Promise<Project>;
  forkAnchor?: (id: number) => Promise<RemoteForkAnchorResponse["anchor"]>;
} = {};

/** Message shown for desktop-only actions in the remote page. */
export const REMOTE_UNSUPPORTED = "원격 웹에서는 지원하지 않는 기능입니다. PC 앱에서 하세요.";

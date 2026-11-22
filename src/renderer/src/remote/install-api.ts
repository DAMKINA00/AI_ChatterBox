// First module of the remote page: provides window.chatterbox (the desktop renderer's API) on top of the
// remote web routes before any renderer module reads it (lib/utils captures it when it loads).
import { createRemoteApi, type RemoteApiHooks } from "./desktop-api";

window.__CBX_REMOTE__ = true;

/** Filled in by the page shell once the renderer store exists; safe defaults until then. */
export const remoteHooks: RemoteApiHooks = {
  onAuthLost: () => location.reload(),
  confirm: async message => window.confirm(message),
  notify: () => undefined,
  findEvent: () => undefined,
  onResync: () => undefined,
};

export const remoteApi = createRemoteApi({
  onAuthLost: () => remoteHooks.onAuthLost(),
  confirm: message => remoteHooks.confirm(message),
  notify: message => remoteHooks.notify(message),
  findEvent: (chatId, eventId) => remoteHooks.findEvent(chatId, eventId),
  onResync: chatId => remoteHooks.onResync(chatId),
});

window.chatterbox = remoteApi;

// The remote page: login, then the desktop app's own UI (App) on the remote API adapter. Keeps the
// renderer store in step with what the stream cannot deliver (it carries chat events of the open chat only).
import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { App } from "../App";
import { retryHistory, useStore } from "../store";
import { remoteActions } from "../lib/remote-mode";
import { logout, request, setCsrf } from "./api";
import { remoteApi, remoteHooks } from "./install-api";
import { Login } from "./Login";

export function DesktopShell() {
  const [auth, setAuth] = useState<"checking" | "login" | "ok">("checking");
  useEffect(() => {
    request<{ csrf: string }>("/api/session").then(s => { setCsrf(s.csrf); setAuth("ok"); }).catch(() => setAuth("login"));
  }, []);
  if (auth === "checking") return <div className="flex h-dvh items-center justify-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>;
  if (auth === "login") return <Login onDone={() => setAuth("ok")} />;
  return <RemoteDesktop />;
}

/** Drops a chat's loaded history so the next visit reads it again (its events stopped streaming). */
function forget(chatId: number) {
  useStore.setState(s => {
    if (!s.events[chatId]) return s;
    const { [chatId]: _e, ...events } = s.events;
    const { [chatId]: _h, ...history } = s.history;
    return { events, history };
  });
}

function RemoteDesktop() {
  useEffect(() => {
    // A lost session resets the whole page (the store holds data of the ended session).
    remoteHooks.onAuthLost = () => location.reload();
    remoteHooks.notify = message => useStore.getState().toast(message, "info");
    remoteHooks.findEvent = (chatId, eventId) => useStore.getState().events[chatId]?.find(e => e.id === eventId);
    remoteHooks.onResync = chatId => {
      void remoteApi.listChats().then(chats => useStore.setState({ chats })).catch(() => undefined);
      void remoteApi.listProjects().then(projects => useStore.setState({ projects })).catch(() => undefined);
      if (chatId !== null && useStore.getState().selection?.chatId === chatId) { forget(chatId); void retryHistory(chatId); }
    };
    // Back to the login page only once the server ended the session (or it had already ended); any other
    // answer leaves the session alive, so the caller shows the failure and the button can be pressed again.
    remoteActions.signOut = async () => {
      await logout();
      setCsrf("");
      location.reload();
    };
    remoteActions.saveProject = remoteApi.saveProject;
    remoteActions.forkAnchor = remoteApi.forkAnchor;
    remoteApi.start();

    // The stream follows the selected chat itself (not the history cache): switched synchronously with the
    // selection, before the store decides whether to read the history. A chat left behind no longer
    // receives its events, so its history is forgotten and read fresh when it is opened again.
    let previous = useStore.getState().selection?.chatId ?? null;
    remoteApi.follow(previous);
    const unsubscribe = useStore.subscribe(s => {
      const current = s.selection?.chatId ?? null;
      if (current === previous) return;
      const left = previous;
      previous = current;
      remoteApi.follow(current);
      if (left !== null) queueMicrotask(() => forget(left));
    });

    // Phones: the browser's back button leaves the open chat for the chat list.
    const onPop = () => { if (useStore.getState().selection) void useStore.getState().select(null); };
    window.addEventListener("popstate", onPop);
    const unsubscribeHistory = useStore.subscribe((s, before) => {
      if (s.selection?.chatId && s.selection.chatId !== before.selection?.chatId && !history.state?.cbxChat)
        history.pushState({ cbxChat: s.selection.chatId }, "");
      // Closed with the page's own back button: drop the entry so history does not grow.
      else if (!s.selection && before.selection && history.state?.cbxChat) history.back();
    });
    return () => { unsubscribe(); unsubscribeHistory(); window.removeEventListener("popstate", onPop); };
  }, []);
  return <App />;
}

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentEvent, ChatterBoxApi, Session } from "../shared/types";

const api: ChatterBoxApi & { addWorkspace(path: string): Promise<unknown> } = {
  listWorkspaces: () => ipcRenderer.invoke("workspaces:list"),
  pickWorkspace: () => ipcRenderer.invoke("workspaces:pick"),
  addWorkspace: (path) => ipcRenderer.invoke("workspaces:add", path),
  listSessions: (workspaceId) => ipcRenderer.invoke("sessions:list", workspaceId),
  createSession: (workspaceId, agent) => ipcRenderer.invoke("sessions:create", workspaceId, agent),
  loadEvents: (sessionId) => ipcRenderer.invoke("sessions:events", sessionId),
  send: (sessionId, text) => ipcRenderer.invoke("sessions:send", sessionId, text),
  stop: (sessionId) => ipcRenderer.invoke("sessions:stop", sessionId),
  answerApproval: (sessionId, approvalId, decision) => ipcRenderer.invoke("sessions:approve", sessionId, approvalId, decision),
  cliInfo: () => ipcRenderer.invoke("cli:info"),
  onEvent: (cb) => {
    const h = (_e: IpcRendererEvent, sessionId: number, event: AgentEvent) => cb(sessionId, event);
    ipcRenderer.on("session:event", h);
    return () => ipcRenderer.removeListener("session:event", h);
  },
  onSessionUpdated: (cb) => {
    const h = (_e: IpcRendererEvent, session: Session) => cb(session);
    ipcRenderer.on("session:updated", h);
    return () => ipcRenderer.removeListener("session:updated", h);
  },
};

contextBridge.exposeInMainWorld("chatterbox", api);

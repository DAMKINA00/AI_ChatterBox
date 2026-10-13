import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { ChatterBoxApi } from "../shared/types";

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, h);
  return () => {
    ipcRenderer.removeListener(channel, h);
  };
}

const api: ChatterBoxApi = {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  createProject: (input) => ipcRenderer.invoke("projects:create", input),
  updateProject: (id, patch) => ipcRenderer.invoke("projects:update", id, patch),
  deleteProject: (id) => ipcRenderer.invoke("projects:delete", id),
  pickFolder: () => ipcRenderer.invoke("projects:pickFolder"),

  listChats: () => ipcRenderer.invoke("chats:list"),
  createChat: (projectId) => ipcRenderer.invoke("chats:create", projectId),
  updateChat: (id, patch) => ipcRenderer.invoke("chats:update", id, patch),
  deleteChat: (id) => ipcRenderer.invoke("chats:delete", id),
  markViewed: (id) => ipcRenderer.invoke("chats:viewed", id),
  listConsults: (chatId) => ipcRenderer.invoke("chats:consults", chatId),
  loadEvents: (chatId) => ipcRenderer.invoke("chats:events", chatId),
  send: (chatId, text, attachmentIds) => ipcRenderer.invoke("chats:send", chatId, text, attachmentIds),
  stop: (chatId) => ipcRenderer.invoke("chats:stop", chatId),
  answerApproval: (chatId, approvalId, decision) => ipcRenderer.invoke("chats:approve", chatId, approvalId, decision),
  answerAskUser: (chatId, askId, answer) => ipcRenderer.invoke("chats:answerAsk", chatId, askId, answer),

  attachFromPaths: (chatId, paths) => ipcRenderer.invoke("att:paths", chatId, paths),
  attachFromBytes: (chatId, name, mime, bytes) => ipcRenderer.invoke("att:bytes", chatId, name, mime, bytes),
  pickAttachments: (chatId) => ipcRenderer.invoke("att:pick", chatId),
  removeAttachment: (id) => ipcRenderer.invoke("att:remove", id),
  pathForFile: (file) => webUtils.getPathForFile(file),

  cliInfo: () => ipcRenderer.invoke("cli:info"),
  models: (agent) => ipcRenderer.invoke("models:list", agent),
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  usage: () => ipcRenderer.invoke("usage:get"),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),

  onEvent: (cb) => on("chat:event", cb),
  onChatUpdated: (cb) => on("chat:updated", cb),
  onConsultUpdated: (cb) => on("consult:updated", cb),
  onUsage: (cb) => on("usage", cb),
};

contextBridge.exposeInMainWorld("chatterbox", api);

import { create } from "zustand";
import type {
  AgentKind,
  Chat,
  ChatAgent,
  ChatForkOptions,
  CliInfo,
  CliAccountStatus,
  Consult,
  ModelOption,
  NodeId,
  Project,
  ProjectSettings,
  Theme,
  TimelineEvent,
  UsageInfo,
} from "../../shared/types";
import { api, errorMessage } from "./lib/utils";
import { appendEvent, chatTimelines } from "./timeline";

export interface Selection {
  chatId: number;
  /** undefined = the chat's unified timeline */
  node?: NodeId;
}

interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
}

interface State {
  ready: boolean;
  projects: Project[];
  chats: Chat[];
  consults: Record<number, Consult[]>;
  agents: Record<number, ChatAgent[]>;
  events: Record<number, TimelineEvent[]>;
  selection: Selection | null;
  expanded: Record<string, boolean>;
  usage: UsageInfo;
  cli: CliInfo[];
  cliAccounts: CliAccountStatus[];
  theme: Theme;
  models: Partial<Record<AgentKind, ModelOption[]>>;
  modelErrors: Partial<Record<AgentKind, string>>;
  toasts: Toast[];
  search: string;

  init(): Promise<void>;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: number): void;
  setTheme(t: Theme): void;
  setSearch(s: string): void;
  toggle(key: string, value?: boolean): void;
  select(sel: Selection | null): Promise<void>;
  loadModels(agent: AgentKind): Promise<void>;
  refreshCli(): Promise<void>;

  createProject(input: { name: string; folder: string; settings: ProjectSettings }): Promise<Project | null>;
  updateProject(id: number, patch: Parameters<typeof api.updateProject>[1]): Promise<boolean>;
  deleteProject(id: number): Promise<void>;
  createChat(projectId: number): Promise<Chat | null>;
  updateChat(id: number, patch: Parameters<typeof api.updateChat>[1]): Promise<void>;
  deleteChat(id: number): Promise<void>;
  /** New idle chat holding a read-only transcript of the source; opens it. null on failure (toast shown). */
  forkChat(sourceChatId: number, options: ChatForkOptions): Promise<Chat | null>;
}

let toastSeq = 0;

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("expanded") ?? "{}");
  } catch {
    return {};
  }
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: [],
  chats: [],
  consults: {},
  agents: {},
  events: {},
  selection: null,
  expanded: loadExpanded(),
  usage: {},
  cli: [],
  cliAccounts: [],
  theme: "dark",
  models: {},
  modelErrors: {},
  toasts: [],
  search: "",

  async init() {
    let receivedUsage: UsageInfo | undefined;
    // Subscribe before slow CLI/auth initialization so fresh limits cannot be lost to a cached error.
    // Usage bars read each account's stored reading from the account list, so re-read it with every
    // usage update (at most once a second; the list call is a synchronous read in the core).
    let accountsTimer: number | undefined;
    api.onUsage((usage) => {
      receivedUsage = usage;
      set({ usage });
      accountsTimer ??= window.setTimeout(() => {
        accountsTimer = undefined;
        void api.cliAccounts.list().then(cliAccounts => set({ cliAccounts })).catch(() => undefined);
      }, 1000);
    });
    const [projects, chats, cli, theme, usage] = await Promise.all([
      api.listProjects(),
      api.listChats(),
      api.cliInfo(),
      api.getTheme(),
      api.usage(),
    ]);
    document.documentElement.classList.toggle("dark", theme === "dark");
    set({ projects, chats, cli, theme, usage: receivedUsage ?? usage, ready: true });
    void get().refreshCli().catch(() => undefined);

    const pendingEvents: TimelineEvent[] = [];
    let eventTimer: number | undefined;
    const flushEvents = () => {
      window.clearTimeout(eventTimer);
      eventTimer = undefined;
      const batch = pendingEvents.splice(0);
      if (!batch.length) return;
      set((s) => {
        const changed = new Map<number, TimelineEvent[]>();
        for (const e of batch) {
          const list = changed.get(e.chatId) ?? s.events[e.chatId];
          if (list) changed.set(e.chatId, appendEvent(list, e));
        }
        return changed.size ? { events: { ...s.events, ...Object.fromEntries(changed) } } : s;
      });
    };
    api.onEvent((e) => {
      pendingEvents.push(e);
      // Keep approvals/results immediate; paint token bursts at most twenty times a second.
      if (e.event.type !== "text_delta") flushEvents();
      else eventTimer ??= window.setTimeout(flushEvents, 50);
    });
    api.onChatUpdated((c) => {
      set((s) => ({ chats: s.chats.some((x) => x.id === c.id) ? s.chats.map((x) => (x.id === c.id ? c : x)) : [c, ...s.chats] }));
      // The chat on screen is read as soon as it finishes.
      if (c.unread && get().selection?.chatId === c.id && document.hasFocus()) void api.markViewed(c.id);
    });
    api.onConsultUpdated((c) =>
      set((s) => {
        const list = s.consults[c.chatId] ?? [];
        const next = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
        return { consults: { ...s.consults, [c.chatId]: next } };
      }),
    );
    api.onGeminiWebLogin((status) => get().toast(`제미나이 웹 계정 ${status.accountId.slice(7)} · ${status.message}`, "info"));
    api.onAgentsUpdated((chatId, list) => set((s) => ({ agents: { ...s.agents, [chatId]: list } })));
    // Sidebar activity colors also need workers from chats that have not been opened.
    for (const chat of chats.filter(c => c.status === "working")) {
      void Promise.all([api.listAgents(chat.id), api.listConsults(chat.id)]).then(([agents, consults]) => set(s => ({
        agents: { ...s.agents, [chat.id]: s.agents[chat.id] ?? agents },
        consults: { ...s.consults, [chat.id]: [...new Map([...consults, ...(s.consults[chat.id] ?? [])].map(c => [c.id, c])).values()] },
      }))).catch(() => undefined);
    }
    api.onSelectChat((chatId) => void get().select({ chatId }));
    // Remote web changes the desktop did not make itself (chat delete, project create/update).
    api.onChatDeleted((id) => {
      chatTimelines.delete(id);
      set((s) => ({ chats: s.chats.filter((c) => c.id !== id), selection: s.selection?.chatId === id ? null : s.selection }));
    });
    api.onProjectsUpdated(() => void api.listProjects().then((projects) => set({ projects })).catch(() => undefined));
    window.addEventListener("focus", () => {
      const sel = get().selection;
      if (sel && get().chats.find((c) => c.id === sel.chatId)?.unread) void api.markViewed(sel.chatId);
      void get().refreshCli().catch(() => undefined);
    });

    // Reopen the last chat.
    const last = Number(localStorage.getItem("lastChat"));
    if (last && chats.some((c) => c.id === last)) await get().select({ chatId: last });
  },

  toast(text, tone = "error") {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 7000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setTheme(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    set({ theme });
    void api.setTheme(theme);
  },
  setSearch(search) {
    set({ search });
  },
  toggle(key, value) {
    set((s) => {
      const expanded = { ...s.expanded, [key]: value ?? !s.expanded[key] };
      localStorage.setItem("expanded", JSON.stringify(expanded));
      return { expanded };
    });
  },

  async select(sel) {
    set({ selection: sel });
    if (!sel) return;
    localStorage.setItem("lastChat", String(sel.chatId));
    const chat = get().chats.find((c) => c.id === sel.chatId);
    if (chat) {
      get().toggle(`p${chat.projectId}`, true);
      if (sel.node) get().toggle(`c${chat.id}`, true);
    }
    if (!get().events[sel.chatId]) {
      const [events, consults, agents] = await Promise.all([api.loadEvents(sel.chatId), api.listConsults(sel.chatId), api.listAgents(sel.chatId)]);
      set((s) => ({
        events: { ...s.events, [sel.chatId]: events },
        consults: { ...s.consults, [sel.chatId]: consults },
        agents: { ...s.agents, [sel.chatId]: agents },
      }));
    }
    if (chat?.unread) void api.markViewed(sel.chatId);
  },

  async refreshCli() {
    set({ cli: await api.cliInfo(true) });
  },

  async loadModels(agent) {
    if (get().models[agent]) return;
    set((s) => ({ modelErrors: { ...s.modelErrors, [agent]: undefined } }));
    try {
      void get().refreshCli().catch(() => undefined);
      const list = await api.models(agent);
      set((s) => ({ models: { ...s.models, [agent]: list }, modelErrors: { ...s.modelErrors, [agent]: undefined } }));
    } catch (e) {
      set((s) => ({ modelErrors: { ...s.modelErrors, [agent]: errorMessage(e) } }));
    }
  },

  async createProject(input) {
    try {
      const p = await api.createProject(input);
      set((s) => ({ projects: [...s.projects, p] }));
      get().toggle(`p${p.id}`, true);
      return p;
    } catch (e) {
      get().toast(errorMessage(e));
      return null;
    }
  },
  async updateProject(id, patch) {
    try {
      const p = await api.updateProject(id, patch);
      set((s) => ({ projects: s.projects.map((x) => (x.id === id ? p : x)) }));
      return true;
    } catch (e) {
      get().toast(errorMessage(e));
      return false;
    }
  },
  async deleteProject(id) {
    await api.deleteProject(id);
    set((s) => {
      const gone = new Set(s.chats.filter((c) => c.projectId === id).map((c) => c.id));
      for (const chatId of gone) chatTimelines.delete(chatId);
      return {
        projects: s.projects.filter((p) => p.id !== id),
        chats: s.chats.filter((c) => c.projectId !== id),
        selection: s.selection && gone.has(s.selection.chatId) ? null : s.selection,
      };
    });
  },
  async createChat(projectId) {
    try {
      const c = await api.createChat(projectId);
      set((s) => ({ chats: [c, ...s.chats], events: { ...s.events, [c.id]: [] }, consults: { ...s.consults, [c.id]: [] }, agents: { ...s.agents, [c.id]: [] } }));
      await get().select({ chatId: c.id });
      return c;
    } catch (e) {
      get().toast(errorMessage(e));
      return null;
    }
  },
  async updateChat(id, patch) {
    try {
      const c = await api.updateChat(id, patch);
      set((s) => ({ chats: s.chats.map((x) => (x.id === id ? c : x)) }));
    } catch (e) {
      get().toast(errorMessage(e));
    }
  },
  async forkChat(sourceChatId, options) {
    try {
      const c = await api.forkChat(sourceChatId, options);
      // onChatUpdated may already have added it; keep one entry.
      set((s) => ({ chats: [c, ...s.chats.filter((x) => x.id !== c.id)] }));
      await get().select({ chatId: c.id });
      return c;
    } catch (e) {
      get().toast(errorMessage(e));
      return null;
    }
  },
  async deleteChat(id) {
    await api.deleteChat(id);
    chatTimelines.delete(id);
    set((s) => ({ chats: s.chats.filter((c) => c.id !== id), selection: s.selection?.chatId === id ? null : s.selection }));
  },
}));

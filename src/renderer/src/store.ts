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
import { historyFromPage, prependPage, replayLive, stateEvents, type StateSnapshot } from "../../shared/event-page";
import { emptyTeamUpdates, mergeTeamUpdates, type TeamUpdates } from "./lib/history-load";
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

/** Paging state of a loaded chat (its events are in `events`). */
export interface HistoryState {
  /** Current state where the first page began (bounded aggregate from the core) and that point. */
  snapshot?: StateSnapshot;
  snapshotAt?: number;
  /** Context events older than `start` (pinned state only; never rendered). */
  context: TimelineEvent[];
  start: number;
  hasMore: boolean;
  loadingOlder?: boolean;
}

interface State {
  ready: boolean;
  projects: Project[];
  chats: Chat[];
  consults: Record<number, Consult[]>;
  agents: Record<number, ChatAgent[]>;
  events: Record<number, TimelineEvent[]>;
  history: Record<number, HistoryState>;
  /** Why a chat's history could not be loaded (shown with a retry instead of an endless spinner). */
  loadErrors: Record<number, string>;
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
  /** Load the page before the oldest loaded event; resolves false when nothing more could be loaded. */
  loadOlder(chatId: number): Promise<boolean>;
  /** Load older pages until `found` holds for the loaded events (e.g. a consult's start) or the history ends. */
  loadUntil(chatId: number, found: (events: TimelineEvent[]) => boolean): Promise<void>;
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
/** Live events of chats whose first page is still loading; replayed on top of the page. */
const loadingLive = new Map<number, TimelineEvent[]>();
/** Worker/consult updates of chats whose first page is still loading; they win over the slower list answers. */
const loadingTeam = new Map<number, TeamUpdates>();
const loadingPages = new Map<number, Promise<void>>();

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("expanded") ?? "{}");
  } catch {
    return {};
  }
}

/**
 * Newest page of a chat (with its context), workers and consults. A failure is kept in loadErrors so the
 * chat shows the reason and a retry; concurrent selects of the same chat share one request.
 */
function loadFirstPage(chatId: number): Promise<void> {
  const running = loadingPages.get(chatId);
  if (running) return running;
  loadingLive.set(chatId, []);
  loadingTeam.set(chatId, emptyTeamUpdates());
  useStore.setState((s) => {
    const { [chatId]: _, ...loadErrors } = s.loadErrors;
    return { loadErrors };
  });
  const task = Promise.all([api.loadEventsPage(chatId), api.listConsults(chatId), api.listAgents(chatId)])
    .then(([page, consults, agents]) => {
      const loaded = historyFromPage(page);
      // Events that arrived while the page was read: newer persisted ones and live previews (a preview
      // whose final text the page already holds is dropped).
      const events = replayLive(loaded.events, loadingLive.get(chatId) ?? [], appendEvent);
      const team = mergeTeamUpdates(agents, consults, loadingTeam.get(chatId));
      useStore.setState((s) => ({
        events: { ...s.events, [chatId]: events },
        history: { ...s.history, [chatId]: { context: loaded.context, start: loaded.start, hasMore: loaded.hasMore, snapshot: loaded.snapshot, snapshotAt: loaded.snapshotAt } },
        consults: { ...s.consults, [chatId]: team.consults },
        agents: { ...s.agents, [chatId]: team.agents },
      }));
    })
    .catch((e) => {
      useStore.setState((s) => ({ loadErrors: { ...s.loadErrors, [chatId]: errorMessage(e) } }));
    })
    .finally(() => {
      loadingLive.delete(chatId);
      loadingTeam.delete(chatId);
      loadingPages.delete(chatId);
    });
  loadingPages.set(chatId, task);
  return task;
}

/** The history to load again after a failure (retry button). */
export const retryHistory = (chatId: number) => loadFirstPage(chatId);

/** Loaded events plus the older context, for state that depends on the whole history (plan, reviews, expressions). */
export function stateEventsOf(events: TimelineEvent[] | undefined, history: HistoryState | undefined): TimelineEvent[] {
  return events ? stateEvents({ events, context: history?.context ?? [], snapshot: history?.snapshot, snapshotAt: history?.snapshotAt }) : [];
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  projects: [],
  chats: [],
  consults: {},
  agents: {},
  events: {},
  history: {},
  loadErrors: {},
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
          else loadingLive.get(e.chatId)?.push(e);
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
        loadingTeam.get(c.chatId)?.consults.set(c.id, c);
        const list = s.consults[c.chatId] ?? [];
        const next = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
        return { consults: { ...s.consults, [c.chatId]: next } };
      }),
    );
    api.onGeminiWebLogin((status) => get().toast(`제미나이 웹 계정 ${status.accountId.slice(7)} · ${status.message}`, "info"));
    api.onAgentsUpdated((chatId, list) => {
      const loading = loadingTeam.get(chatId);
      if (loading) loading.agents = list;
      set((s) => ({ agents: { ...s.agents, [chatId]: list } }));
    });
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
    if (!get().events[sel.chatId]) await loadFirstPage(sel.chatId);
    if (chat?.unread) void api.markViewed(sel.chatId);
  },

  async loadOlder(chatId) {
    const history = get().history[chatId];
    if (!history?.hasMore || history.loadingOlder) return false;
    set((s) => ({ history: { ...s.history, [chatId]: { ...history, loadingOlder: true } } }));
    try {
      const page = await api.loadEventsPage(chatId, history.start);
      set((s) => {
        const current = s.history[chatId];
        const events = s.events[chatId];
        if (!current || !events) return s;
        const merged = prependPage({ ...current, events }, page);
        return { events: { ...s.events, [chatId]: merged.events }, history: { ...s.history, [chatId]: { context: merged.context, start: merged.start, hasMore: merged.hasMore, snapshot: merged.snapshot, snapshotAt: merged.snapshotAt } } };
      });
      return true;
    } catch (e) {
      get().toast(`이전 기록을 불러오지 못했습니다: ${errorMessage(e)}`);
      set((s) => (s.history[chatId] ? { history: { ...s.history, [chatId]: { ...s.history[chatId], loadingOlder: false } } } : s));
      return false;
    }
  },

  async loadUntil(chatId, found) {
    for (;;) {
      const events = get().events[chatId];
      if (!events || found(events) || !get().history[chatId]?.hasMore) return;
      if (!(await get().loadOlder(chatId))) return;
    }
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
      set((s) => ({ chats: [c, ...s.chats], events: { ...s.events, [c.id]: [] }, history: { ...s.history, [c.id]: { context: [], start: 0, hasMore: false } }, consults: { ...s.consults, [c.id]: [] }, agents: { ...s.agents, [c.id]: [] } }));
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

// Owns the live drivers per chat (one per role: orchestrator, Claude worker, GPT worker),
// persists normalized events, tracks chat status, and forwards everything to the renderer.
// The Orchestrator (orchestrator.ts) plugs in through the hooks at the bottom.
import { mkdirSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { safeStorage } from "electron";
import { join, dirname } from "node:path";
import {
  GEMINI_WEB_MODEL,
  chatOrchestrator,
  cliAccountKindForAgent,
  cliAccountKindOf,
  defaultCliAccountId,
  isCliAccountId,
  type CliAccountId,
  type CliAccountKind,
  type CliAccountPolicies,
  type CliAccountStatus,
  type ProjectSettings,
  type ResolvedCliAccount,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalRequest,
  type Chat,
  type ChatAgent,
  type CliInfo,
  type Consult,
  type NodeId,
  type Project,
  type Role,
  type TimelineEvent,
  type UsageInfo,
  type ModelOption,
  type GeminiWebStatus,
} from "../shared/types";
import type { ChatPatch, Store } from "./db";
import { LocalBridge } from "./local-bridge";
import { ApprovalService, type ApprovalInput, type JudgeAnswer } from "./approvals";
import { findClaude, findCodex, findGrok } from "./locate";
import { GrokDriver, listGrokModels, readGrokAuth, readGrokUsage } from "./drivers/grok";
import { readClaudeAuth, readClaudeAuthDetail } from "./cli-auth";
import { CLI_LOGIN_ARGS, CLI_LOGOUT_ARGS, CliAccounts, accountEnv, cliRemaining, resolveAccountPolicy, sanitizePolicies } from "./cli-accounts";
import { GeminiWebDriver, type WebContext } from "./drivers/gemini-web";
import { GeminiWebAccounts } from "./drivers/gemini-web-accounts";
import { conversationAccount } from "./drivers/gemini-web-protocol";
import type { GeminiWebAccountId } from "../shared/types";
import { ClaudeDriver, claudeUsageText, listClaudeModels } from "./drivers/claude";
import { resolveEffort, workerEffort, WORKER_EFFORTS } from "./effort";
import { parseClaudeUsageText } from "../shared/usage";
import { CodexDriver, CodexServer } from "./drivers/codex";
import { AttachmentStore } from "./attachments";
import type { AgentDriver, AgentInput, DriverHost } from "./drivers/types";
import { AIStudioService } from "./aistudio";
import { ChatCompletionDriver, type StudioMessage } from "./drivers/aistudio";
import { DeepSeekService } from "./deepseek";
import { AISTUDIO_MODEL, isAIStudioModel } from "../shared/aistudio";

export interface Sink {
  agents(chatId: number, agents: ChatAgent[]): void;
  event(e: TimelineEvent): void;
  chat(chat: Chat): void;
  consult(c: Consult): void;
  usage(u: UsageInfo): void;
  webLogin?(status: GeminiWebStatus): void;
}

/** Live-only events (not persisted). */
const TRANSIENT = new Set<AgentEvent["type"]>(["text_delta"]);

interface Live {
  driver: AgentDriver;
  agent: AgentKind;
  model: string;
  effort: string;
  instructions?: string;
  /** CLI account the process runs on (Claude/Codex/Grok only). */
  accountId?: CliAccountId;
  accountToken?: string;
}

export interface RoleConfig {
  agent: AgentKind;
  model: string;
  effort: string;
}

export class ChatManager {
  readonly bridge = new LocalBridge();
  readonly approvals: ApprovalService;
  private live = new Map<number, Partial<Record<Role, Live>>>();
  /** One app-server per Codex account (CODEX_HOME); `gpt-1` is the CLI default. */
  private codexServers = new Map<CliAccountId, { server: CodexServer; token: string; closing?: Promise<void>; closeError?: Error }>();
  private accountChanges = new Set<CliAccountId>();
  private accountJudges = new Map<CliAccountId, number>();
  releaseAccountJudges?: (id: CliAccountId) => Promise<void>;

  holdJudgeAccount(id: CliAccountId): () => void {
    this.assertAccountAvailable(id);
    const account = this.cliAccountOrThrow(id);
    if (!account.enabled) throw new Error("배정에서 제외된 CLI 계정입니다.");
    this.accountJudges.set(id, (this.accountJudges.get(id) ?? 0) + 1);
    return () => { const count = this.accountJudges.get(id) ?? 0; if (count <= 1) this.accountJudges.delete(id); else this.accountJudges.set(id, count - 1); };
  }
  private cliAccountStore?: CliAccounts;
  /** Bumped by logout/removal; readings started under an older epoch are discarded. */
  private accountEpochs = new Map<CliAccountId, number>();
  /** Opens a visible console running the CLI sign-in (replaceable in tests). */
  consoleLauncher: (exe: string, args: string[], env: Record<string, string>, cwd: string) => void = (exe, args, env, cwd) => {
    const options = { cwd, env: { ...process.env, ...env }, detached: true, stdio: "ignore" as const, windowsHide: false };
    const child = process.platform === "win32" ? spawn(process.env.ComSpec || "cmd.exe", ["/k", exe, ...args], options) : spawn(exe, args, options);
    child.on("error", () => undefined);
    child.unref();
  };
  /** Keyed by agent and, for CLI agents, the account (`codex:gpt-2`). */
  private modelLists = new Map<string, { expires: number; promise: Promise<ModelOption[]> }>();
  private authChecks = new Map<string, { expires: number; promise: Promise<CliInfo["authStatus"]> }>();
  readonly tmpDir: string;
  private usageState: UsageInfo = {};
  private grokUsageRefresh = new Map<CliAccountId, Promise<void>>();
  private deepseekBalanceRefresh?: { key: string | undefined; promise: Promise<void> };
  private webAccounts?: GeminiWebAccounts;
  private studio?: AIStudioService;
  private deepseek?: DeepSeekService;
  private attachments: AttachmentStore;
  /** Where a role's events currently go (its own node, or a consult it is serving). */
  private routes = new Map<number, Partial<Record<Role, NodeId>>>();

  constructor(
    readonly store: Store,
    readonly sink: Sink,
    readonly dataDir: string,
    readonly bridgeScript: string,
  ) {
    this.attachments = new AttachmentStore(join(dataDir, "attachments"), store);
    this.tmpDir = join(dataDir, "tmp");
    mkdirSync(this.tmpDir, { recursive: true });
    try {
      this.usageState = JSON.parse(store.getSetting("usage") ?? "{}");
    } catch {
      this.usageState = {};
    }
    // API balances must be refreshed with the currently configured credential.
    delete this.usageState.deepseek;
    delete this.usageState.gemini; // Retire cached Antigravity usage without touching Web/AIS accounts.
    this.approvals = new ApprovalService({
      emit: (chatId, node, role, event) => this.emit(chatId, node, role, event),
      log: (chatId, role, action, risk, decision, scope, by, reason) =>
        this.store.logApproval(chatId, role, action, risk, decision, scope, by, reason),
      pendingChanged: (chatId, pending) => this.refreshStatus(chatId, pending),
      mode: (chatId) => {
        const chat = this.store.chat(chatId);
        const project = chat && this.store.project(chat.projectId);
        return {
          mode: chat?.approvalModeOverride ?? project?.settings.approvalMode ?? "orchestrator",
          delegateHighRisk: (chat?.approvalModeOverride ?? project?.settings.approvalMode) === "orchestrator-all",
        };
      },
      judge: (chatId, request, input) => this.judge?.(chatId, request, input) ?? Promise.resolve(null),
      guard: (chatId, input) => this.approvalGuard?.(chatId, input) ?? null,
      writeScope: (chatId, role) => {
        const s = this.writeScope?.(chatId, role);
        if (!s) return null;
        const chat = this.store.chat(chatId);
        const project = chat && this.store.project(chat.projectId);
        return project ? { ...s, folder: project.folder } : null;
      },
    });
  }

  start() {
    return this.bridge.start();
  }

  // ---------- CLIs
  cliInfo(): CliInfo[] {
    const claude = findClaude(this.store.getSetting("claudePath"));
    const codex = findCodex(this.store.getSetting("codexPath"));
    const grok = findGrok(this.store.getSetting("grokPath"));
    return [
      {
        agent: "claude",
        path: claude,
        error: claude ? undefined : "claude.exe를 찾지 못했습니다. PowerShell에서 irm https://claude.ai/install.ps1 | iex 로 설치하고 로그인하세요.",
      },
      { agent: "codex", path: codex, error: codex ? undefined : "codex.exe를 찾지 못했습니다. Codex 앱 또는 Codex CLI를 설치하세요." },
      { agent: "grok", path: grok, error: grok ? undefined : "Grok CLI를 찾지 못했습니다. npm install -g @xai-official/grok 설치 후 grok login을 실행하세요." },
      { agent: "deepseek", path: this.deepSeek().status().apiKeySet ? "DeepSeek API" : null, error: this.deepSeek().status().apiKeySet ? undefined : "DeepSeek API 설정에서 API 키를 저장하세요." },
    ];
  }

  async checkedCliInfo(): Promise<CliInfo[]> {
    return Promise.all(this.cliInfo().map(async info => {
      if (!info.path) return info;
      if (info.agent === "deepseek") {
        const status = await this.deepSeek().check();
        return { ...info, authStatus: status.state === "ready" ? "authenticated" as const : "unknown" as const, error: status.error };
      }
      const account = cliAccountKindForAgent(info.agent);
      const key = `${info.agent}:${info.path}:${account ? defaultCliAccountId(account) : "-"}`;
      let cached = this.authChecks.get(key);
      if (!cached || cached.expires <= Date.now()) {
        const check = async (): Promise<CliInfo["authStatus"]> => {
          if (info.agent === "claude") return readClaudeAuth(info.path!, this.tmpDir);
          if (info.agent === "grok") return readGrokAuth(info.path!, this.tmpDir);
          const server = this.codex();
          await server.ensure();
          const account = await server.request<any>("account/read", { refreshToken: false });
          return account.account || account.requiresOpenaiAuth === false ? "authenticated" : "required";
        };
        const promise = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([check(), new Promise<"unknown">(resolve => { timer = setTimeout(() => resolve("unknown"), 15000); })]);
          } catch { return "unknown" as const; }
          finally { clearTimeout(timer); }
        })();
        cached = { expires: Date.now() + 30000, promise };
        this.authChecks.set(key, cached);
      }
      return { ...info, authStatus: await cached.promise };
    }));
  }

  claudeExe(): string {
    const exe = findClaude(this.store.getSetting("claudePath"));
    if (!exe) throw new Error(this.cliInfo()[0].error);
    return exe;
  }

  grokExe(): string {
    const exe = findGrok(this.store.getSetting("grokPath"));
    if (!exe) throw new Error("Grok CLI를 찾지 못했습니다. npm install -g @xai-official/grok 설치 후 로그인하세요.");
    return exe;
  }

  aiStudio() {
    return this.studio ??= new AIStudioService(this.store, {
      encrypt: value => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 보안 저장소를 사용할 수 없습니다.");
        return safeStorage.encryptString(value).toString("base64");
      },
      decrypt: value => safeStorage.decryptString(Buffer.from(value, "base64")),
    });
  }

  deepSeek() {
    return this.deepseek ??= new DeepSeekService(this.store, {
      encrypt: value => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 보안 저장소를 사용할 수 없습니다.");
        return safeStorage.encryptString(value).toString("base64");
      },
      decrypt: value => safeStorage.decryptString(Buffer.from(value, "base64")),
    });
  }

  geminiWebAccounts() {
    return this.webAccounts ??= new GeminiWebAccounts(this.dataDir, this.store, undefined, status => {
      this.sink.webLogin?.(status);
      if (this.aiStudio().linkedAccount(status.accountId)) void this.syncStudioWeb(status.accountId, false).catch(() => undefined);
    });
  }
  async syncStudioWeb(accountId: GeminiWebAccountId, show = true) {
    const account = this.geminiWebAccounts().list().find(a => a.accountId === accountId);
    if (!account) throw new Error("등록되지 않은 웹 계정입니다.");
    if (show) await this.aiStudio().launch();
    await this.aiStudio().syncWeb(accountId, account.enabled, () => this.geminiWeb(accountId).studioState(show));
  }
  geminiWeb(accountId: GeminiWebAccountId = "gemini-1") {
    return this.geminiWebAccounts().browser(accountId);
  }
  async disconnectWebAccount(accountId: GeminiWebAccountId, remove: boolean) {
    const affected = () => this.store.listChats().flatMap(chat => this.store.listAgents(chat.id)
      .filter(agent => agent.kind === "gemini" && (agent.webAccountId === accountId || conversationAccount(agent.sessionId) === accountId)));
    const ensureIdle = () => {
      const agents = affected();
      if (agents.some(agent => this.liveDriver(agent.chatId, agent.key)?.running))
        throw new Error("이 계정에 연결된 작업자가 실행 중입니다. 작업을 마친 뒤 다시 시도하세요.");
      return agents;
    };
    ensureIdle();
    return this.geminiWebAccounts().disconnect(accountId, remove, async () => {
      ensureIdle();
      await this.aiStudio().disconnectWeb(accountId);
      const agents = ensureIdle();
      this.store.disconnectWebAccount(accountId);
      for (const agent of agents) await this.disposeRole(agent.chatId, agent.key);
      for (const chatId of new Set(agents.map(agent => agent.chatId))) this.agentsChanged(chatId);
    });
  }
  usesGeminiWeb(chat: Chat) {
    return (chat.geminiModelOverride ?? this.store.project(chat.projectId)!.settings.geminiModel) === GEMINI_WEB_MODEL;
  }

  /** Model list as the given CLI account sees it; no account = the default (`*-1`) account. */
  async models(agent: AgentKind, accountId?: CliAccountId): Promise<ModelOption[]> {
    if (agent === "deepseek") return this.deepSeek().models();
    const kind = cliAccountKindForAgent(agent);
    if (kind && accountId !== undefined && !(isCliAccountId(accountId) && cliAccountKindOf(accountId) === kind)) throw new Error(`${String(accountId)}은(는) ${agent} 계정이 아닙니다.`);
    const account = kind ? accountId ?? defaultCliAccountId(kind) : undefined;
    if (account) this.assertAccountAvailable(account);
    const key = account ? `${agent}:${account}` : agent;
    const cached = this.modelLists.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const env = account ? this.cliAccounts().env(account) : {};
    const promise = agent === "grok" ? listGrokModels(this.grokExe(), this.tmpDir, env) : agent === "codex" ? this.codex(account).models() : agent === "gemini" ? Promise.resolve([ { id: GEMINI_WEB_MODEL, label: "웹 · Gemini 4 Argon", reasoningEfforts: [] }, { id: AISTUDIO_MODEL, label: "AI Studio · Argon", reasoningEfforts: [], isDefault: true }])
      : listClaudeModels(this.claudeExe(), this.tmpDir, env).then((list) => list.map((m) => ({
        id: m.value, label: m.displayName, isDefault: m.value === "opus",
        reasoningEfforts: m.supportsEffort ? m.supportedEffortLevels ?? [] : [],
      })));
    this.modelLists.set(key, { expires: Date.now() + 60_000, promise });
    try { return await promise; }
    catch (error) { if (this.modelLists.get(key)?.promise === promise) this.modelLists.delete(key); throw error; }
  }

  async assignmentEffort(chatId: number, role: Role, requested?: string): Promise<{ requestedEffort: string; effort: string }> {
    const chat = this.store.chat(chatId)!;
    const cfg = this.roleConfig(chat, this.store.project(chat.projectId)!, role);
    if (cfg.agent === "gemini" && (cfg.model === GEMINI_WEB_MODEL || isAIStudioModel(cfg.model))) {
      if (role !== "orch") workerEffort("auto", requested); // Workers still record the master's assignment; this transport uses default thinking.
      return { requestedEffort: requested ?? "", effort: "" };
    }
    const choice = role === "orch" ? cfg.effort === "auto" ? "" : cfg.effort : workerEffort(cfg.effort, requested);
    if (!choice) return { requestedEffort: requested ?? "", effort: "" };
    // Validate against the account that will actually run the role.
    const models = await this.models(cfg.agent, this.roleAccount(chatId, role)?.accountId);
    const model = cfg.model ? models.find((m) => m.id === cfg.model) : models.find((m) => m.isDefault);
    if (!model) throw new Error("선택한 모델의 추론 수준을 확인하지 못했습니다. 모델을 다시 선택하세요.");
    if (!model.reasoningEfforts?.length) return { requestedEffort: requested ?? choice, effort: "" };
    return { requestedEffort: requested ?? choice, effort: resolveEffort(choice, model) };
  }

  webAccountInfo(chatId: number) {
    const workers = this.store.listAgents(chatId).filter(a => a.kind === "gemini");
    return this.geminiWebAccounts().list().map(account => ({
      ...account,
      workers: workers.filter(a => a.webAccountId === account.accountId || conversationAccount(a.sessionId) === account.accountId)
        .map(a => ({ nickname: a.nickname, status: a.status, assignedAccountId: a.webAccountId ?? null, lastConversationAccountId: conversationAccount(a.sessionId) })),
    }));
  }

  async teamCapabilities(chat: Chat) {
    const project = this.store.project(chat.projectId)!;
    const installed = this.cliInfo();
    const gptModel = chat.codexModelOverride ?? project.settings.codexModel;
    const geminiWeb = this.usesGeminiWeb(chat);
    const geminiStudio = isAIStudioModel(chat.geminiModelOverride ?? project.settings.geminiModel);
    let imageGeneration: boolean | null = null;
    let codexAuthenticated: boolean | null = null;
    if (installed.find((c) => c.agent === "codex")?.path) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const s = this.codex();
            await s.ensure();
            const [caps, config, models, account] = await Promise.all([
              s.request<any>("modelProvider/capabilities/read", {}),
              s.request<any>("config/read", { cwd: project.folder, includeLayers: false }),
              s.request<any>("model/list", { includeHidden: true }),
              s.request<any>("account/read", { refreshToken: false }),
            ]);
            codexAuthenticated = !!account.account || account.requiresOpenaiAuth === false;
            const model = models.data?.find((m: any) => m.id === gptModel || m.model === gptModel);
            imageGeneration = !!caps.imageGeneration && config.config?.features?.image_generation !== false
              && account.account?.planType !== "free" && !!codexAuthenticated && !!model?.inputModalities?.includes("image");
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("capabilities timeout")), 15000); }),
        ]);
      } catch { /* Unknown is not a confirmed capability. */ }
      finally { if (timer) clearTimeout(timer); }
    }
    const effortLevels: Partial<Record<AgentKind, string[]>> = {};
    await Promise.all(installed.filter((c) => c.path).map(async ({ agent }) => {
      try {
        const models = await this.models(agent);
        const id = agent === "claude" ? chat.claudeModelOverride ?? project.settings.claudeModel : agent === "codex" ? gptModel : agent === "grok" ? chat.grokModelOverride ?? project.settings.grokModel : agent === "deepseek" ? chat.deepseekModelOverride ?? project.settings.deepseekModel : chat.geminiModelOverride ?? project.settings.geminiModel;
        const model = id ? models.find((m) => m.id === id) : models.find((m) => m.isDefault);
        effortLevels[agent] = WORKER_EFFORTS.filter((level) => model?.reasoningEfforts?.includes(level));
      } catch { /* Unknown levels remain unavailable, never invent support. */ }
    }));
    return {
      deepseek: { installed: this.deepSeek().status().apiKeySet, model: chat.deepseekModelOverride ?? project.settings.deepseekModel, reasoningEfforts: effortLevels.deepseek, effortSetting: project.settings.deepseekEffort, imageGeneration: false, videoGeneration: false, authentication: this.deepSeek().status(), localTools: true, fileWrites: true, enabled: project.settings.maxDeepseekWorkers > 0 },
      claude: { installed: !!installed.find((c) => c.agent === "claude")?.path, model: chat.claudeModelOverride ?? project.settings.claudeModel, reasoningEfforts: effortLevels.claude, effortSetting: project.settings.claudeEffort, imageGeneration: false, authentication: "실행 시 확인", usage: this.usageState.claude },
      gpt: { installed: !!installed.find((c) => c.agent === "codex")?.path, model: gptModel, reasoningEfforts: effortLevels.codex, effortSetting: project.settings.codexEffort, imageGeneration, authenticated: codexAuthenticated, usage: this.usageState.codex },
      grok: { installed: !!installed.find(c => c.agent === "grok")?.path, model: chat.grokModelOverride ?? project.settings.grokModel, reasoningEfforts: effortLevels.grok, effortSetting: project.settings.grokEffort, imageGeneration: null, authentication: "Grok 로그인과 도구는 실행 시 확인", usage: this.usageState.grok },
      gemini: { installed: true, model: chat.geminiModelOverride ?? project.settings.geminiModel, reasoningEfforts: [], effortSetting: geminiWeb ? "웹 모델 설정" : "AI Studio 모델 설정", imageGeneration: null, aiStudio: geminiStudio ? await this.aiStudio().status() : undefined, videoGeneration: geminiStudio && this.aiStudio().settings().videoEnabled, authentication: geminiStudio ? "호출 시 AIStudio2API를 자동 설치·실행하고 연결된 계정으로 서비스를 시작한다. OFFLINE만으로 배정을 거부하지 않는다. 계정이 없으면 Gemini 웹 계정 관리의 AI Studio 연결을 안내한다." : "계정별 로그인·잔여량은 webAccounts에서 확인하고 gemini_web_accounts로 갱신", enabled: project.settings.maxGeminiWorkers > 0, webAccounts: geminiWeb ? this.webAccountInfo(chat.id) : undefined, webOnly: geminiWeb, localTools: !geminiWeb, fileWrites: !geminiWeb, supportedKinds: geminiWeb ? ["writing", "opinion", "review"] : ["implement", "writing", "opinion", "review"], role: "기본은 글쓰기, 사용자가 지정하면 해당 작업 우선" },
    };
  }

  /** The app-server of one Codex account; the default argument is the CLI's own CODEX_HOME. */
  codex(accountId: CliAccountId = defaultCliAccountId("gpt")): CodexServer {
    this.assertAccountAvailable(accountId);
    const token = this.accountToken(accountId);
    let current = this.codexServers.get(accountId);
    if (current?.closing) throw new Error("이전 Codex 서버 종료 중입니다. 완료 후 다시 시도하세요.");
    if (current?.closeError) throw current.closeError;
    if (current?.server.stopping) throw new Error("Codex 서버 종료가 확인되지 않았습니다. 계정 변경을 다시 시도하세요.");
    if (current && current.token !== token) {
      // Keep the only server reference until exit is confirmed; a synchronous caller must retry.
      void this.closeCodexServer(accountId).catch(() => undefined);
      throw new Error("계정이 변경되어 이전 Codex 서버 종료 중입니다. 완료 후 다시 시도하세요.");
    }
    if (!current) {
      const exe = findCodex(this.store.getSetting("codexPath"));
      if (!exe) throw new Error(this.cliInfo()[1].error);
      const server = new CodexServer(exe, this.cliAccounts().env(accountId));
      server.onUsage = (u) => this.mergeUsage(u, accountId, token);
      current = { server, token };
      this.codexServers.set(accountId, current);
    }
    return current.server;
  }

  /**
   * `accountId` names the CLI account that reported the reading. The family keys keep the default
   * (`*-1`) account's values so a single-account setup reads exactly as before.
   */
  mergeUsage(u: UsageInfo, accountId?: CliAccountId, token?: string) {
    const family = { claude: "claude", codex: "gpt", grok: "grok" } as const;
    if (accountId && !isCliAccountId(accountId)) accountId = undefined;
    // A reading that started before the account was logged out, removed or re-created is dropped.
    if (accountId && token !== undefined && !this.isCurrentAccount(accountId, token)) return;
    const isDefault = !accountId || accountId === defaultCliAccountId(cliAccountKindOf(accountId));
    for (const k of ["claude", "codex", "grok"] as const) {
      const next = u[k];
      if (!next) continue;
      const id = accountId && cliAccountKindOf(accountId) === family[k] ? accountId : defaultCliAccountId(family[k]);
      // Claude/Codex live updates can be partial (one window only); Grok is a complete snapshot.
      const partial = k !== "grok";
      const accounts = { ...this.usageState.accounts };
      const cur = partial ? accounts[id] ?? {} : {};
      accounts[id] = partial && !next.error ? { ...cur, ...next, fiveHour: next.fiveHour ?? cur.fiveHour, weekly: next.weekly ?? cur.weekly, error: undefined } : next;
      if (accounts[id]!.error === undefined) delete accounts[id]!.error;
      this.usageState = { ...this.usageState, accounts };
      this.cliAccounts().setUsage(id, next, partial);
      if (!isDefault && id === accountId) continue;
      if (partial) {
        const old = this.usageState[k] ?? {};
        this.usageState = { ...this.usageState, [k]: { fiveHour: next.fiveHour ?? old.fiveHour, weekly: next.weekly ?? old.weekly } };
      } else this.usageState = { ...this.usageState, [k]: next };
    }
    if (u.geminiWeb) this.usageState = { ...this.usageState, geminiWeb: u.geminiWeb };
    if (u.deepseek) this.usageState = { ...this.usageState, deepseek: u.deepseek };
    // Remember the last values so the sidebar isn't empty on the next launch.
    if (!this.disposing) this.store.setSetting("usage", JSON.stringify(this.usageState));
    this.sink.usage(this.usageState);
  }
  usage(): UsageInfo {
    return this.usageState;
  }

  /** Claude reports limits only inside a model turn; ask its local /usage command instead (0 tokens). */
  async refreshClaudeUsage(accountId: CliAccountId = defaultCliAccountId("claude")) {
    const exe = findClaude(this.store.getSetting("claudePath"));
    if (!exe) return;
    const token = this.accountToken(accountId);
    const text = await claudeUsageText(exe, this.tmpDir, this.cliAccounts().env(accountId)).catch(() => null);
    const parsed = text ? parseClaudeUsageText(text) : null;
    if (parsed) this.mergeUsage({ claude: parsed }, accountId, token);
  }

  refreshGrokUsage(accountId: CliAccountId = defaultCliAccountId("grok")): Promise<void> {
    const running = this.grokUsageRefresh.get(accountId);
    if (running) return running;
    const exe = findGrok(this.store.getSetting("grokPath"));
    if (!exe) {
      this.mergeUsage({ grok: { error: "Grok CLI를 찾지 못했습니다. 설치 경로를 확인해 주세요." } }, accountId);
      return Promise.resolve();
    }
    const token = this.accountToken(accountId);
    const promise = readGrokUsage(exe, this.tmpDir, this.cliAccounts().env(accountId))
      .then(usage => { if (!this.disposing) this.mergeUsage({ grok: { ...usage, updatedAt: Date.now() } }, accountId, token); })
      .catch(error => { if (!this.disposing) this.mergeUsage({ grok: { error: error instanceof Error ? error.message : "Grok 사용량 조회에 실패했습니다." } }, accountId, token); })
      .finally(() => { this.grokUsageRefresh.delete(accountId); });
    this.grokUsageRefresh.set(accountId, promise);
    return promise;
  }

  resetDeepSeekBalance() {
    this.mergeUsage({ deepseek: { state: this.deepSeek().status().apiKeySet ? "loading" : "unconfigured", balances: [] } });
  }

  refreshDeepSeekBalance(): Promise<void> {
    const key = this.store.getSetting("deepseekApiKey");
    if (this.deepseekBalanceRefresh && this.deepseekBalanceRefresh.key === key) return this.deepseekBalanceRefresh.promise;
    const promise = this.deepSeek().balance().then(balance => {
      if (!this.disposing && this.store.getSetting("deepseekApiKey") === key) this.mergeUsage({ deepseek: balance });
    }).finally(() => { if (this.deepseekBalanceRefresh?.promise === promise) this.deepseekBalanceRefresh = undefined; });
    this.deepseekBalanceRefresh = { key, promise };
    return promise;
  }

  /** Providers refresh independently, even when another CLI is missing. */
  async refreshUsage(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve().then(() => this.codex().readUsage()),
      Promise.resolve().then(() => this.refreshClaudeUsage()),
      Promise.resolve().then(() => this.refreshGrokUsage()),
      Promise.resolve().then(() => this.refreshDeepSeekBalance()),
      // Added CLI accounts: only enabled ones; each reads its own directory.
      ...this.cliAccounts().list().filter(a => a.configDir && a.enabled).map(a => Promise.resolve().then(() => this.refreshAccountUsage(a.accountId))),
    ]);
  }

  // ---------- CLI accounts
  cliAccounts(): CliAccounts {
    return this.cliAccountStore ??= new CliAccounts(join(this.dataDir, "cli-accounts"), this.store);
  }

  /** Identifies one incarnation of an account plus its login epoch; captured when a reading starts. */
  accountToken(id: CliAccountId): string {
    return `${this.cliAccounts().generation(id) ?? "none"}:${this.accountEpochs.get(id) ?? 0}`;
  }
  private isCurrentAccount(id: CliAccountId, token: string): boolean {
    return !this.accountChanges.has(id) && this.cliAccounts().generation(id) !== undefined && this.accountToken(id) === token;
  }
  private assertAccountAvailable(id: CliAccountId) {
    if (this.accountChanges.has(id)) throw new Error(`CLI 계정 ${id} 변경 중입니다. 완료 후 다시 시도하세요.`);
  }

  private beginAccountChange(id: CliAccountId) {
    this.assertAccountAvailable(id);
    if (this.getCliAccount(id)!.runningWorkers > 0) throw new Error("이 계정으로 실행 중인 작업자가 있습니다. 작업을 마친 뒤 다시 시도하세요.");
    this.accountChanges.add(id);
    this.bumpAccount(id);
  }

  /** Invalidates every reading in flight for the account (login/logout/removal start and end). */
  private bumpAccount(id: CliAccountId) {
    this.accountEpochs.set(id, (this.accountEpochs.get(id) ?? 0) + 1);
    this.grokUsageRefresh.delete(id);
    this.authChecks.clear();
    for (const key of [...this.modelLists.keys()]) if (key.endsWith(`:${id}`)) this.modelLists.delete(key);
  }

  /** Project policies keep only well-formed entries naming registered accounts. */
  sanitizeAccountPolicy(value: unknown): CliAccountPolicies {
    const policies = sanitizePolicies(value);
    for (const kind of Object.keys(policies) as CliAccountKind[]) {
      const id = policies[kind]?.accountId;
      if (id && !this.cliAccounts().get(id)) delete policies[kind];
    }
    return policies;
  }

  private cliStatus(account: ReturnType<CliAccounts["list"]>[number]): CliAccountStatus {
    let runningWorkers = this.accountJudges.get(account.accountId) ?? 0;
    for (const slot of this.live.values()) for (const l of Object.values(slot)) if (l?.accountId === account.accountId && l.driver.running) runningWorkers++;
    const remainingPercent = cliRemaining(account);
    return {
      ...account,
      isDefault: account.accountId === defaultCliAccountId(account.kind),
      authStatus: account.auth ? account.auth.loggedIn ? "authenticated" : "required" : "unknown",
      ...(remainingPercent === undefined ? {} : { remainingPercent }),
      runningWorkers,
    };
  }

  listCliAccounts(kind?: CliAccountKind): CliAccountStatus[] {
    return this.cliAccounts().list(kind).map(a => this.cliStatus(a));
  }

  getCliAccount(id: CliAccountId): CliAccountStatus | undefined {
    const a = isCliAccountId(id) ? this.cliAccounts().get(id) : undefined;
    return a && this.cliStatus(a);
  }

  /** Explicit > project > app-wide > fixed `*-1`. */
  resolveAccountPolicy(kind: CliAccountKind, projectSettings: ProjectSettings | undefined, explicitId?: CliAccountId): ResolvedCliAccount {
    return resolveAccountPolicy(kind, projectSettings?.accountPolicy, this.cliAccounts().policies(), explicitId);
  }

  /** For explicit assignments only: unknown login state passes; a confirmed logout does not. */
  assertCliAccount(id: unknown, kind: CliAccountKind): CliAccountStatus {
    if (!isCliAccountId(id)) throw new Error(`CLI 계정 ID 형식이 올바르지 않습니다: ${String(id)} (예: ${kind}-1)`);
    if (cliAccountKindOf(id) !== kind) throw new Error(`${id}은(는) ${kind} 계열 계정이 아닙니다.`);
    const account = this.getCliAccount(id);
    if (!account) throw new Error(`등록되지 않은 CLI 계정입니다: ${id}. cli_accounts로 등록된 계정을 확인하세요.`);
    this.assertAccountAvailable(id);
    if (!account.enabled) throw new Error(`CLI 계정 ${id}은(는) 배정에서 제외되어 있습니다.`);
    if (account.authStatus === "required") throw new Error(`CLI 계정 ${id}에 로그인되어 있지 않습니다. 사용자에게 CLI 계정 관리에서 로그인한 뒤 상태 새로고침 또는 cli_accounts(refresh=true)를 실행하도록 알리세요.`);
    return account;
  }

  /** The master's explicit choice for a worker; null returns it to the project/global policy. */
  setWorkerAccount(chatId: number, role: Role, accountId: CliAccountId | null) {
    const agent = this.store.agentByKey(chatId, role);
    if (!agent) throw new Error("작업자를 찾지 못했습니다.");
    if (accountId !== null) {
      const kind = cliAccountKindForAgent(this.roleConfig(this.store.chat(chatId)!, this.store.project(this.store.chat(chatId)!.projectId)!, role).agent);
      if (!kind || cliAccountKindOf(accountId) !== kind) throw new Error(`${agent.nickname}에게는 ${accountId} 계정을 지정할 수 없습니다.`);
    }
    this.store.updateAgent(agent.id, { cliAccountId: accountId });
    this.agentsChanged(chatId);
  }

  /**
   * Account the role would run on now; null for agents without CLI accounts. A user's fixed policy
   * (project or app-wide) always wins; a stored master assignment applies only under auto or the
   * default policy.
   */
  roleAccount(chatId: number, role: Role): ResolvedCliAccount | null {
    const chat = this.store.chat(chatId);
    const project = chat && this.store.project(chat.projectId);
    if (!chat || !project) return null;
    const kind = cliAccountKindForAgent(this.roleConfig(chat, project, role).agent);
    if (!kind) return null;
    const policy = this.resolveAccountPolicy(kind, project.settings);
    if (policy.mode === "fixed" && policy.source !== "default") return policy;
    const stored = role === "orch" ? undefined : this.store.agentByKey(chatId, role)?.cliAccountId;
    return stored && cliAccountKindOf(stored) === kind ? this.resolveAccountPolicy(kind, project.settings, stored) : policy;
  }

  /** Account of the role's live CLI process, if any. */
  runningAccount(chatId: number, role: Role): CliAccountId | undefined {
    return this.live.get(chatId)?.[role]?.accountId;
  }

  private cliExe(kind: CliAccountKind): string {
    if (kind === "claude") return this.claudeExe();
    if (kind === "grok") return this.grokExe();
    const exe = findCodex(this.store.getSetting("codexPath"));
    if (!exe) throw new Error(this.cliInfo()[1].error);
    return exe;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
  }

  private async refreshAccountUsage(id: CliAccountId) {
    this.assertAccountAvailable(id);
    const kind = cliAccountKindOf(id);
    if (kind === "claude") await this.refreshClaudeUsage(id);
    else if (kind === "grok") await this.refreshGrokUsage(id);
    else await this.codex(id).readUsage();
  }

  private async refreshAccountAuth(id: CliAccountId, token: string) {
    this.assertAccountAvailable(id);
    const accounts = this.cliAccounts();
    const kind = cliAccountKindOf(id);
    const env = accounts.env(id);
    let auth: { loggedIn: boolean; email?: string } | null = null;
    if (kind === "claude") {
      const detail = await readClaudeAuthDetail(this.claudeExe(), this.tmpDir, env);
      if (detail.status !== "unknown") auth = { loggedIn: detail.status === "authenticated", ...(detail.email ? { email: detail.email } : {}) };
    } else if (kind === "grok") {
      const status = await readGrokAuth(this.grokExe(), this.tmpDir, env);
      if (status !== "unknown") auth = { loggedIn: status === "authenticated" };
    } else {
      const server = this.codex(id);
      await server.ensure();
      const account = await server.request<any>("account/read", { refreshToken: false });
      const email = typeof account?.account?.email === "string" ? account.account.email : undefined;
      auth = { loggedIn: !!account?.account || account?.requiresOpenaiAuth === false, ...(email ? { email } : {}) };
    }
    // Logged out, removed or re-created meanwhile: the answer belongs to an earlier incarnation.
    if (!this.isCurrentAccount(id, token)) return null;
    if (auth) accounts.setAuth(id, { ...auth, checkedAt: Date.now() });
    return auth;
  }

  /** Login state and usage of one account (or all); failures are recorded per account, never thrown. */
  async refreshCliAccount(id?: CliAccountId): Promise<CliAccountStatus[]> {
    const ids = id ? [this.cliAccountOrThrow(id).accountId] : this.cliAccounts().list().map(a => a.accountId);
    await Promise.allSettled(ids.map(async accountId => {
      if (this.accountChanges.has(accountId)) return;
      this.authChecks.clear();
      const token = this.accountToken(accountId);
      let auth: { loggedIn: boolean } | null = null;
      try { auth = await this.withTimeout(this.refreshAccountAuth(accountId, token), 20_000, "로그인 상태 확인 시간 초과"); }
      catch { /* unknown stays unknown */ }
      if (!this.isCurrentAccount(accountId, token)) return;
      if (auth && !auth.loggedIn) {
        this.mergeUsage({ [{ claude: "claude", gpt: "codex", grok: "grok" }[cliAccountKindOf(accountId)]]: { error: "로그인이 필요합니다." } } as UsageInfo, accountId, token);
        return;
      }
      try { await this.withTimeout(this.refreshAccountUsage(accountId), 45_000, "사용량 조회 시간 초과"); }
      catch { /* readings already record their own errors */ }
    }));
    if (!this.disposing) this.sink.usage(this.usageState);
    return this.listCliAccounts();
  }

  private cliAccountOrThrow(id: unknown) {
    const account = isCliAccountId(id) ? this.cliAccounts().get(id) : undefined;
    if (!account) throw new Error(`등록되지 않은 CLI 계정입니다: ${String(id)}`);
    return account;
  }

  createCliAccount(kind: CliAccountKind, label?: string): CliAccountStatus[] {
    const created = this.cliAccounts().create(kind, label);
    // A fresh incarnation: nothing cached for an earlier account with this ID survives.
    this.bumpAccount(created.accountId);
    const accounts = { ...this.usageState.accounts };
    delete accounts[created.accountId];
    this.usageState = { ...this.usageState, accounts };
    return this.listCliAccounts();
  }

  updateCliAccount(id: CliAccountId, patch: { label?: string; enabled?: boolean }): CliAccountStatus[] {
    this.cliAccountOrThrow(id);
    if (patch.enabled === false && this.getCliAccount(id)!.runningWorkers > 0) throw new Error("작업 중인 계정은 배정에서 제외할 수 없습니다. 작업을 마친 뒤 변경하세요.");
    this.cliAccounts().update(id, { label: patch?.label, enabled: patch?.enabled });
    return this.listCliAccounts();
  }

  /** New console with the account's CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME; returns immediately. */
  loginCliAccount(id: CliAccountId) {
    const account = this.cliAccountOrThrow(id);
    this.beginAccountChange(id);
    try {
      this.consoleLauncher(this.cliExe(account.kind), CLI_LOGIN_ARGS[account.kind], accountEnv(account), account.configDir ?? homedir());
      this.cliAccounts().setAuth(id, undefined, account.createdAt);
    } finally {
      this.bumpAccount(id);
      this.accountChanges.delete(id);
    }
  }

  private closeCodexServer(id: CliAccountId): Promise<void> {
    const entry = this.codexServers.get(id);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.closing = Promise.resolve().then(() => entry.server.dispose()).then(() => {
      if (this.codexServers.get(id) === entry) this.codexServers.delete(id);
    }).catch((error: unknown) => {
      entry.closeError = new Error(`Codex 서버 종료를 확인하지 못했습니다. 계정 변경을 중단했습니다: ${error instanceof Error ? error.message : String(error)}`);
      throw entry.closeError;
    }).finally(() => { entry.closing = undefined; });
    return entry.closing;
  }

  private async releaseAccountProcesses(id: CliAccountId) {
    await this.releaseAccountJudges?.(id);
    await this.codexServers.get(id)?.closing;
    for (const [chatId, slot] of this.live) for (const [role, l] of Object.entries(slot)) if (l?.accountId === id) await this.disposeRole(chatId, role as Role, true);
    await this.closeCodexServer(id);
  }

  async logoutCliAccount(id: CliAccountId): Promise<CliAccountStatus[]> {
    const account = this.cliAccountOrThrow(id);
    this.beginAccountChange(id);
    try {
      await this.releaseAccountProcesses(id);
      const exe = this.cliExe(account.kind);
      await new Promise<void>((resolve, reject) => execFile(exe, CLI_LOGOUT_ARGS[account.kind], { cwd: account.configDir ?? this.tmpDir, windowsHide: true, timeout: 30_000, env: { ...process.env, ...accountEnv(account) } },
        (error, _stdout, stderr) => error ? reject(new Error(`로그아웃에 실패했습니다: ${String(stderr || error.message).trim().slice(0, 300)}`)) : resolve()));
      this.cliAccounts().setAuth(id, { loggedIn: false, checkedAt: Date.now() }, account.createdAt);
      return this.listCliAccounts();
    } finally {
      this.bumpAccount(id);
      this.accountChanges.delete(id);
    }
  }

  /** Added accounts only; the app deletes just the directory it created. */
  async removeCliAccount(id: CliAccountId): Promise<CliAccountStatus[]> {
    const account = this.cliAccountOrThrow(id);
    if (!account.configDir) throw new Error("기본 계정은 삭제할 수 없습니다.");
    this.beginAccountChange(id);
    try {
      await this.releaseAccountProcesses(id);
      this.cliAccounts().remove(id);
      this.store.clearCliAccount(id);
      const global = this.cliAccounts().policies();
      for (const kind of Object.keys(global) as CliAccountKind[]) if (global[kind]?.accountId === id) delete global[kind];
      this.cliAccounts().setPolicies(global);
      for (const project of this.store.listProjects()) {
        const policy = project.settings.accountPolicy;
        const kinds = (Object.keys(policy ?? {}) as CliAccountKind[]).filter(kind => policy?.[kind]?.accountId === id);
        if (!kinds.length) continue;
        const next = { ...policy };
        for (const kind of kinds) delete next[kind];
        this.store.updateProject(project.id, { settings: { ...project.settings, accountPolicy: next } });
      }
      const accounts = { ...this.usageState.accounts };
      delete accounts[id];
      this.usageState = { ...this.usageState, accounts };
      this.store.setSetting("usage", JSON.stringify(this.usageState));
      this.sink.usage(this.usageState);
      for (const chat of this.store.listChats()) this.agentsChanged(chat.id);
      return this.listCliAccounts();
    } finally {
      this.bumpAccount(id);
      this.accountChanges.delete(id);
    }
  }

  getCliAccountPolicy(): CliAccountPolicies {
    return this.cliAccounts().policies();
  }

  setCliAccountPolicy(policies: CliAccountPolicies): CliAccountPolicies {
    return this.cliAccounts().setPolicies(policies);
  }

  /** Owner of the role's stored session: account and its generation ("id@generation" for masters). */
  private sessionAccountOf(chat: Chat, role: Role, agent: AgentKind): { accountId: CliAccountId; generation?: number } | undefined {
    if (role === "orch") {
      const [id, generation] = (this.store.getSetting(`orchSessionAccount:${chat.id}:${agent}`) ?? "").split("@");
      if (!isCliAccountId(id)) return undefined;
      return generation !== undefined && generation !== "" && Number.isFinite(Number(generation)) ? { accountId: id, generation: Number(generation) } : { accountId: id };
    }
    const agentRow = this.store.agentByKey(chat.id, role);
    if (!agentRow?.sessionAccountId) return undefined;
    return { accountId: agentRow.sessionAccountId, ...(agentRow.sessionAccountGeneration !== undefined ? { generation: agentRow.sessionAccountGeneration } : {}) };
  }

  /** Context for a new session on another account: recent requests and answers, no CLI transcript copy. */
  private handoffText(chatId: number, role: Role, from: string, to: CliAccountId): string {
    const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n)}…` : text;
    let turns: string[];
    if (role === "orch") {
      const events = this.store.events(chatId).filter(e => e.node === "orch" && (e.event.type === "user" || (e.role === "orch" && e.event.type === "text")));
      turns = events.slice(-8).map(e => e.event.type === "user" ? `사용자: ${clip(e.event.text, 1200)}` : `마스터: ${clip((e.event as { text: string }).text, 1200)}`);
    } else {
      turns = this.store.listConsults(chatId).filter(c => c.toRole === role && c.status === "done").slice(-4)
        .map((c, i) => `${i + 1}. 요청: ${clip(c.request, 1500)}\n   응답 요약: ${clip(c.responseSummary ?? "(요약 없음)", 1500)}`);
    }
    return [`[AI_ChatterBox 계정 전환 인계 — CLI 계정 ${from} → ${to}]`,
      "이전 CLI 대화는 다른 계정에 저장되어 이어서 열 수 없어 새 세션으로 시작합니다. 아래는 지난 요청·응답 요약입니다. 필요한 사실은 파일과 결과로 다시 확인하세요.",
      turns.length ? turns.join("\n") : "(인계할 완료 기록이 없습니다.)", "[인계 끝]"].join("\n");
  }

  /** Set by the orchestrator: what a worker may write right now (its implement scope). */
  writeScope?: (chatId: number, role: Role) => { globs: string[] | null; why: string } | null;
  approvalGuard?: (chatId: number, input: import("./approvals").ApprovalInput) => string | null;
  /** Set by the orchestrator: the chat's approval judge. */
  judge?: (chatId: number, request: ApprovalRequest, input: ApprovalInput) => Promise<JudgeAnswer | null>;
  /** Quitting: processes are being torn down; don't record their exits as errors. */
  private disposing = false;

  // ---------- events and status
  emit(chatId: number, node: NodeId, role: Role | null, event: AgentEvent): void {
    if (this.disposing || !this.store.chat(chatId)) return; // quitting, or deleted meanwhile
    const e: TimelineEvent = TRANSIENT.has(event.type)
      ? { id: 0, chatId, node, role, at: Date.now(), event }
      : this.store.addEvent(chatId, node, role, event);
    this.sink.event(e);
    // Streaming can be frequent; persist activity at most every 15s until a full event arrives.
    if (event.type !== "agent_usage" && event.type !== "expression"
      && (event.type !== "text_delta" || e.at - (this.store.chat(chatId)?.lastActiveAt ?? 0) >= 15_000))
      this.updateChat(chatId, { touch: true });
  }

  updateChat(chatId: number, patch: ChatPatch): Chat {
    // While quitting, keep the stored status ("working" → "interrupted" on next launch).
    if (this.disposing) return this.store.chat(chatId)!;
    const chat = this.store.updateChat(chatId, patch);
    if (patch.approvalModeOverride !== undefined || patch.orchestratorModelOverride !== undefined || patch.orchestratorEffortOverride !== undefined)
      this.approvals.invalidate(chatId);
    this.sink.chat(chat);
    return chat;
  }

  private refreshStatus(chatId: number, pending = this.approvals.pendingCount(chatId)) {
    const chat = this.store.chat(chatId);
    if (!chat) return;
    if (chat.status === "pausing" || chat.status === "paused") return;
    if (pending > 0) this.updateChat(chatId, { status: "approval" });
    else if (chat.status === "approval") this.updateChat(chatId, { status: this.isBusy(chatId) ? "working" : "idle" });
  }

  isBusy(chatId: number): boolean {
    return Object.values(this.live.get(chatId) ?? {}).some((l) => l?.driver.running);
  }

  isBusyForUpdate(): boolean {
    return this.store.listChats().some(chat => ["working", "approval", "pausing"].includes(chat.status) || this.isBusy(chat.id));
  }

  // ---------- roles and drivers
  /** Agent + model a role uses right now (orchestrator follows the project; workers may be overridden per chat). */
  roleConfig(chat: Chat, project: Project, role: Role): RoleConfig {
    if (role === "orch") return { ...chatOrchestrator(chat, project), effort: chat.orchestratorEffortOverride ?? project.settings.orchestratorEffort };
    const worker = this.store.agentByKey(chat.id, role);
    if (worker?.kind === "gpt") return { agent: "codex", model: chat.codexModelOverride ?? project.settings.codexModel, effort: project.settings.codexEffort };
    if (worker?.kind === "grok") return { agent: "grok", model: chat.grokModelOverride ?? project.settings.grokModel, effort: project.settings.grokEffort };
    if (worker?.kind === "deepseek") return { agent: "deepseek", model: chat.deepseekModelOverride ?? project.settings.deepseekModel, effort: project.settings.deepseekEffort };
    if (worker?.kind === "gemini") return { agent: "gemini", model: chat.geminiModelOverride ?? project.settings.geminiModel, effort: project.settings.geminiEffort };
    return { agent: "claude", model: chat.claudeModelOverride ?? project.settings.claudeModel, effort: project.settings.claudeEffort };
  }

  private nativeIdOf(chat: Chat, role: Role, agent: AgentKind): string | null {
    if (role === "orch") return agent === "claude" ? chat.orchClaudeSessionId : agent === "codex" ? chat.orchCodexThreadId : this.store.getSetting(`orchSession:${chat.id}:${agent}`) ?? null;
    return this.store.agentByKey(chat.id, role)?.sessionId ?? null;
  }

  private saveNativeId(chatId: number, role: Role, agent: AgentKind, id: string, accountId?: CliAccountId, generation?: number) {
    if (role === "orch") {
      if (agent === "gemini" || agent === "grok" || agent === "deepseek") this.store.setSetting(`orchSession:${chatId}:${agent}`, id);
      else this.updateChat(chatId, agent === "claude" ? { orchClaudeSessionId: id } : { orchCodexThreadId: id });
      if (accountId) this.store.setSetting(`orchSessionAccount:${chatId}:${agent}`, generation === undefined ? accountId : `${accountId}@${generation}`);
      return;
    }
    const w = this.store.agentByKey(chatId, role);
    if (w) {
      this.store.updateAgent(w.id, { sessionId: id, ...(accountId ? { sessionAccountId: accountId, ...(generation !== undefined ? { sessionAccountGeneration: generation } : {}) } : {}) });
      this.agentsChanged(chatId);
    }
  }

  agentsChanged(chatId: number) {
    this.sink.agents(chatId, this.store.listAgents(chatId));
  }

  route(chatId: number, role: Role): NodeId {
    return this.routes.get(chatId)?.[role] ?? role;
  }
  setRoute(chatId: number, role: Role, node: NodeId | undefined) {
    const r = this.routes.get(chatId) ?? {};
    if (node) r[role] = node;
    else delete r[role];
    this.routes.set(chatId, r);
  }

  generatedImage(chatId: number, image: { id: string; path?: string; base64?: string }) {
    return this.attachments.generatedImage(chatId, image);
  }

  /** Hooks for the orchestrator. */
  onDriverEvent?: (chatId: number, role: Role, event: AgentEvent) => void;
  beforeMasterEnd?: (chatId: number, event: Extract<AgentEvent, { type: "turn_end" }>) => Extract<AgentEvent, { type: "turn_end" }> | null;
  instructionsFor?: (chat: Chat, project: Project, role: Role, agent: AgentKind) => string | undefined;
  /** Extra MCP servers for a role: Claude --mcp-config entries and the same entries as Codex config. */
  toolsFor?: (chat: Chat, role: Role, agent: AgentKind) => Record<string, any> | undefined;

  /**
   * Driver for a role, created on demand. If the role's CLI or model changed since the driver was
   * made (project/chat settings), the old one is replaced; the CLI session is resumed, so context stays.
   */
  async driver(chatId: number, role: Role, assignmentEffort?: string): Promise<AgentDriver> {
    const chat = this.store.chat(chatId)!;
    const project = this.store.project(chat.projectId)!;
    const cfg = this.roleConfig(chat, project, role);
    if (role === "orch" && cfg.agent === "gemini" && cfg.model === GEMINI_WEB_MODEL) throw new Error("마스터는 AI Studio 모델을 선택하세요. Gemini 웹은 작업자로 사용할 수 있습니다.");
    const effort = assignmentEffort ?? (await this.assignmentEffort(chatId, role)).effort;
    const instructions = this.instructionsFor?.(chat, project, role, cfg.agent);
    const resolved = this.roleAccount(chatId, role);
    const accountId = resolved?.accountId;
    const account = accountId ? this.cliAccounts().get(accountId) : undefined;
    if (accountId && !account) throw new Error(`CLI 계정 ${accountId}이(가) 등록되어 있지 않습니다. 계정 정책 또는 지정 계정을 확인하세요.`);
    if (accountId) this.assertAccountAvailable(accountId);
    const usageToken = accountId ? this.accountToken(accountId) : undefined;
    if (account && !account.enabled) throw new Error(`CLI 계정 ${accountId}은(는) 배정에서 제외되어 있어 실행하지 않았습니다. CLI 계정 관리에서 배정을 다시 허용하거나 계정 정책을 바꾸세요.`);
    const slot = this.live.get(chatId) ?? {};
    this.live.set(chatId, slot);
    const cur = slot[role];
    if (cur && !cur.driver.running) {
      if (cur.agent !== cfg.agent || cur.accountId !== accountId || cur.accountToken !== usageToken || cur.instructions !== instructions || (cur.agent !== "codex" && (cur.model !== cfg.model || cur.effort !== effort))) {
        await cur.driver.dispose();
        delete slot[role];
      } else if (cur.agent === "codex" && (cur.model !== cfg.model || cur.effort !== effort)) {
        (cur.driver as CodexDriver).setModel(cfg.model || undefined);
        (cur.driver as CodexDriver).setEffort(effort);
        cur.model = cfg.model;
        cur.effort = effort;
      }
    }
    if (slot[role]) return slot[role]!.driver;

    const host: DriverHost = {
      emit: (event) => {
        if (role === "orch" && event.type === "turn_end" && this.beforeMasterEnd) {
          const checked = this.beforeMasterEnd(chatId, event);
          if (!checked) return;
          event = checked;
        }
        this.emit(chatId, this.route(chatId, role), role, event);
        this.onDriverEvent?.(chatId, role, event);
        if (role === "orch" && event.type === "turn_end") this.orchTurnEnded(chatId, event);
        // A worker that outlived the orchestrator settles the chat when it ends.
        else if (event.type === "turn_end" && this.pendingFinal.has(chatId) && !this.isBusy(chatId) && this.store.chat(chatId)?.status === "working") {
          const final = this.pendingFinal.get(chatId) ?? "idle";
          this.pendingFinal.delete(chatId);
          this.updateChat(chatId, { status: final, unread: final !== "idle", touch: true });
        }
      },
      nativeId: (id) => this.saveNativeId(chatId, role, cfg.agent, id, accountId, account?.createdAt),
      approve: (input) => this.approvals.request(chatId, project.folder, { ...input, role, node: this.route(chatId, role) }),
      usage: (u) => this.mergeUsage(u, accountId, usageToken),
      image: (image) => this.generatedImage(chatId, image),
    };
    // A session belongs to the account incarnation that created it (legacy sessions: the default
    // account). Another account, or a removed and re-created one, starts fresh with a handoff.
    let nativeId = this.nativeIdOf(chat, role, cfg.agent);
    let handoff: string | undefined;
    const owner = accountId ? this.sessionAccountOf(chat, role, cfg.agent) : undefined;
    const sessionAccount = accountId ? owner?.accountId ?? defaultCliAccountId(cliAccountKindOf(accountId)) : undefined;
    const staleGeneration = owner?.generation !== undefined && owner.generation !== account?.createdAt;
    if (accountId && nativeId && (sessionAccount !== accountId || staleGeneration)) {
      handoff = this.handoffText(chatId, role, staleGeneration && sessionAccount === accountId ? `${sessionAccount}(삭제된 이전 계정)` : sessionAccount!, accountId);
      nativeId = null;
    }
    const opts = {
      cwd: project.folder,
      nativeId,
      accountEnv: accountEnv(account),
      exePath: "",
      model: cfg.model || undefined,
      effort,
      instructions,
      readOnly: false,
      allowImages: role !== "orch",
      workerSession: role === "orch" ? undefined : {
        projectRoot: join(this.tmpDir, "..", "AI AGENT"),
        name: `[AI AGENT] ${project.name} · ${chat.title} · ${this.store.agentByKey(chatId, role)?.nickname ?? role}`,
      },
      tokenBaseline: nativeId ? this.store.events(chatId).findLast((e) => e.role === role && e.event.type === "agent_usage" && e.event.metrics.nativeId === nativeId)?.event : undefined,
    };
    const baseline = opts.tokenBaseline;
    const driverOpts = { ...opts, tokenBaseline: baseline?.type === "agent_usage" ? baseline.metrics.total : undefined };
    let driver: AgentDriver;
    if (cfg.agent === "claude") {
      driver = new ClaudeDriver(
        { ...driverOpts, exePath: this.claudeExe() },
        {
          bridge: this.bridge,
          bridgeScript: this.bridgeScript,
          tmpDir: this.tmpDir,
          mcpServers: () => this.toolsFor?.(this.store.chat(chatId)!, role, "claude") ?? {},
          // Bridge tools (master: spawn/ask/…; workers: ask/agents) never need a permission prompt.
          allowedTools: ["mcp__chatterbox_bridge"],
        },
        host,
      );
    } else if (cfg.agent === "grok") {
      driver = new GrokDriver({ ...driverOpts, exePath: this.grokExe() }, () => this.toolsFor?.(this.store.chat(chatId)!, role, "grok") ?? {}, host);
    } else if (cfg.agent === "gemini" && cfg.model === GEMINI_WEB_MODEL) {
      const contextKey = `gemini-web-context:${chatId}:${role}`;
      driver = new GeminiWebDriver(driverOpts, this.geminiWebAccounts(), host, {
        load: (): WebContext => {
          try {
            const saved = JSON.parse(this.store.getSetting(contextKey) ?? "null");
            if (saved && Array.isArray(saved.history)) return {
              history: saved.history.filter((turn: any) => typeof turn?.request === "string" && typeof turn?.response === "string"),
              pending: typeof saved.pending?.request === "string" && typeof saved.pending?.partial === "string" ? saved.pending : undefined,
            };
          } catch { /* Existing stored dialogue remains available below. */ }
          const events = this.store.events(chatId);
          return { history: this.store.listConsults(chatId).filter(c => c.toRole === role && c.status === "done").map(c => ({
            request: c.request,
            response: events.filter(e => e.role === role && e.node === `consult:${c.id}` && e.event.type === "text")
              .map(e => e.event.type === "text" ? e.event.text : "").join("\n\n") || c.responseSummary || "",
          })) };
        },
        save: context => this.store.setSetting(contextKey, JSON.stringify(context)),
      });
    } else if (cfg.agent === "deepseek" || (cfg.agent === "gemini" && isAIStudioModel(cfg.model))) {
      const key = `${cfg.agent === "deepseek" ? "deepseek" : "aistudio"}-context:${chatId}:${role}:${cfg.model}`;
      driver = new ChatCompletionDriver(driverOpts, {
        provider: cfg.agent,
        service: cfg.agent === "deepseek" ? this.deepSeek() : this.aiStudio(),
        bridgeUrl: () => this.toolsFor?.(this.store.chat(chatId)!, role, cfg.agent)?.chatterbox_bridge?.env?.CHATTERBOX_URL,
        context: {
          load: (): StudioMessage[] => {
            try { const value = JSON.parse(this.store.getSetting(key) ?? "[]"); return Array.isArray(value) ? value : []; }
            catch { return []; }
          },
          save: messages => this.store.setSetting(key, JSON.stringify(messages)),
        },
      }, host);
    } else {
      const servers = this.toolsFor?.(chat, role, "codex");
      driver = new CodexDriver(
        { ...driverOpts, codexConfig: servers ? codexMcpConfig(servers) : undefined },
        this.codex(accountId),
        host,
      );
    }
    if (handoff) withHandoff(driver, handoff);
    slot[role] = { driver, agent: cfg.agent, model: cfg.model, effort, instructions, ...(accountId ? { accountId, accountToken: usageToken } : {}) };
    // Single-account setups stay silent; another account or a switch is always visible.
    if (accountId && (handoff || accountId !== defaultCliAccountId(cliAccountKindOf(accountId))))
      this.emit(chatId, this.route(chatId, role), role, { type: "notice", cliAccountId: accountId,
        text: `CLI 계정 ${accountId}(${account!.label})로 실행합니다${handoff ? ` · 이전 대화는 ${sessionAccount} 계정에 있어 새 세션으로 시작하고 지난 요청·응답 요약을 인계합니다` : ""}.` });
    return driver;
  }

  liveDriver(chatId: number, role: Role): AgentDriver | undefined {
    return this.live.get(chatId)?.[role]?.driver;
  }

  async archiveWorker(chatId: number, role: Role): Promise<void> {
    if (role === "orch") return;
    const driver = this.liveDriver(chatId, role);
    if (!driver || driver.running) return;
    try { await driver.archive?.(); }
    catch (error) {
      this.emit(chatId, role, role, { type: "notice", text: `CLI 대화 보관 실패: ${error instanceof Error ? error.message : String(error)}. ChatterBox 기록은 유지됩니다.` });
    }
  }

  /** Dispose one role's conversation process (a released worker). */
  async disposeRole(chatId: number, role: Role, propagateError = false) {
    const slot = this.live.get(chatId);
    const l = slot?.[role];
    if (slot) delete slot[role];
    this.setRoute(chatId, role, undefined);
    const cleanup = l?.driver.dispose();
    if (propagateError) await cleanup;
    else await cleanup?.catch(() => undefined);
  }

  /** Drop a chat's drivers (deleted chat, project folder changed). */
  async resetDrivers(chatId: number) {
    const slot = this.live.get(chatId);
    this.live.delete(chatId);
    this.routes.delete(chatId);
    this.approvals.cancelChat(chatId);
    await Promise.all(Object.values(slot ?? {}).map((l) => l?.driver.dispose().catch(() => undefined)));
  }

  // ---------- user actions
  /** Replaced by the orchestrator; default: plain turn on the orchestrator conversation. */
  sendHandler: (chat: Chat, input: AgentInput) => Promise<void> = async (chat, input) => {
    await (await this.driver(chat.id, "orch")).send(input);
  };

  /** Called instead of sendHandler while the chat is working (extra instructions). */
  busySend?: (chat: Chat, input: AgentInput, delivery: "now" | "next") => Promise<void>;

  async send(chatId: number, text: string, attachmentIds: number[], delivery: "now" | "next" = "now") {
    if (!["now", "next"].includes(delivery)) throw new Error("지원하지 않는 전달 방식입니다.");
    const chat = this.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    const attachments = this.store.attachmentsFor(attachmentIds);
    if (chat.status === "pausing") throw new Error("마스터와 작업자의 중지 확인을 기다리고 있습니다.");
    if (chat.status === "working" || chat.status === "approval" || chat.status === "paused" || this.isBusy(chatId)) {
      if (!this.busySend) throw new Error("작업이 진행 중입니다. 끝나거나 중지한 뒤 보내 주세요.");
      const ev = this.store.addEvent(chatId, "orch", null, { type: "user", text, attachments, queued: true, delivery });
      this.store.linkAttachments(attachmentIds, ev.id);
      this.sink.event(ev);
      this.updateChat(chatId, { touch: true });
      await this.busySend(chat, { text, attachments }, delivery);
      return;
    }
    await this.startTurn(chatId, text, attachmentIds, () => this.sendHandler(chat, { text, attachments }));
  }

  /**
   * Record the user's message (as shown) and start an orchestrator run. Commands (/plan, /goal …)
   * use this with their own run; errors end the run with a visible message.
   */
  async startTurn(chatId: number, display: string, attachmentIds: number[], run: () => Promise<void>) {
    const attachments = this.store.attachmentsFor(attachmentIds);
    const isFirst = !this.store.hasUserEvent(chatId);
    const userEvent = this.store.addEvent(chatId, "orch", null, { type: "user", text: display, attachments });
    this.store.linkAttachments(attachmentIds, userEvent.id);
    this.sink.event(userEvent);
    this.updateChat(chatId, {
      status: "working",
      touch: true,
      title: isFirst ? titleFrom(display, attachments.length) : undefined,
    });
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.disposeRole(chatId, "orch");
      this.emit(chatId, "orch", "orch", { type: "error", kind: "process", message });
      const end = { type: "turn_end", ok: false, error: message } as const;
      this.emit(chatId, "orch", "orch", end);
      this.onDriverEvent?.(chatId, "orch", end);
      this.orchTurnEnded(chatId, end);
    }
  }

  /** The orchestrator's turn finished: the instruction is done. */
  /** Final status to apply once still-running workers finish (orchestrator ended first). */
  private pendingFinal = new Map<number, "done" | "error" | "idle">();

  orchTurnEnded(chatId: number, end: Extract<AgentEvent, { type: "turn_end" }>) {
    if (["pausing", "paused"].includes(this.store.chat(chatId)?.status ?? "")) return;
    // A worker is still running (stop winding down, or a consult the orchestrator lost track of):
    // keep showing "working" until it ends.
    if (this.isBusy(chatId)) {
      this.pendingFinal.set(chatId, end.interrupted ? "idle" : end.ok ? "done" : "error");
      return;
    }
    this.approvals.cancelChat(chatId);
    this.updateChat(chatId, {
      status: end.interrupted ? "idle" : end.ok ? "done" : "error",
      unread: true,
      touch: true,
    });
  }

  async stop(chatId: number) {
    this.approvals.cancelChat(chatId);
    await Promise.allSettled(Object.values(this.live.get(chatId) ?? {}).map((l) => l?.driver.stop()));
    this.pendingFinal.delete(chatId);
  }

  answerApproval(chatId: number, id: string, decision: ApprovalDecision) {
    return this.approvals.answer(chatId, id, decision);
  }

  async deleteChat(chatId: number) {
    await this.resetDrivers(chatId);
    this.store.deleteChat(chatId);
  }

  async dispose() {
    this.disposing = true;
    const all = [...this.live.values()].flatMap((s) => Object.values(s));
    this.live.clear();
    await Promise.all(all.map((l) => l?.driver.dispose().catch(() => undefined)));
    await Promise.all([...this.codexServers.keys()].map(id => this.closeCodexServer(id).catch(() => undefined)));
    this.codexServers.clear();
    await this.webAccounts?.dispose();
    this.bridge.stop();
  }
}

/** Prepends the account handoff to the first input the new session accepts. */
function withHandoff(driver: AgentDriver, handoff: string) {
  const send = driver.send.bind(driver);
  let pending: string | undefined = handoff;
  driver.send = async (input: AgentInput) => {
    if (!pending) return send(input);
    await send({ ...input, text: `${pending}\n\n${input.text}` });
    pending = undefined;
  };
}

/** Claude --mcp-config server entries → Codex config overrides (mcp_servers.<name>.*). */
function codexMcpConfig(servers: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    out[`mcp_servers.${name}.command`] = s.command;
    out[`mcp_servers.${name}.args`] = s.args ?? [];
    if (s.env) out[`mcp_servers.${name}.env`] = s.env;
    // App-owned bridge tools enforce their role and scope rules themselves.
    out[`mcp_servers.${name}.default_tools_approval_mode`] = "approve";
    // Consults can run for a long time.
    out[`mcp_servers.${name}.tool_timeout_sec`] = 24 * 3600;
    out[`mcp_servers.${name}.startup_timeout_sec`] = 30;
  }
  return out;
}

function titleFrom(text: string, files: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t) return t.length > 40 ? t.slice(0, 40) + "…" : t;
  return files ? `첨부 ${files}개` : "새 채팅";
}

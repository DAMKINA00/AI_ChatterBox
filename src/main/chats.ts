// Owns the live drivers per chat (one per role: orchestrator, Claude worker, GPT worker),
// persists normalized events, tracks chat status, and forwards everything to the renderer.
// The Orchestrator (orchestrator.ts) plugs in through the hooks at the bottom.
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  chatOrchestrator,
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
} from "../shared/types";
import type { ChatPatch, Store } from "./db";
import { LocalBridge } from "./local-bridge";
import { ApprovalService, type ApprovalInput, type JudgeAnswer } from "./approvals";
import { findClaude, findCodex, findGemini } from "./locate";
import { GeminiDriver } from "./drivers/gemini";
import { listGeminiModels } from "./drivers/gemini-protocol";
import { readGeminiUsage } from "./drivers/gemini-usage";
import { ClaudeDriver, claudeUsageText, listClaudeModels } from "./drivers/claude";
import { resolveEffort, workerEffort, WORKER_EFFORTS } from "./effort";
import { parseClaudeUsageText } from "../shared/usage";
import { CodexDriver, CodexServer } from "./drivers/codex";
import { AttachmentStore } from "./attachments";
import type { AgentDriver, AgentInput, DriverHost } from "./drivers/types";

export interface Sink {
  agents(chatId: number, agents: ChatAgent[]): void;
  event(e: TimelineEvent): void;
  chat(chat: Chat): void;
  consult(c: Consult): void;
  usage(u: UsageInfo): void;
}

/** Live-only events (not persisted). */
const TRANSIENT = new Set<AgentEvent["type"]>(["text_delta"]);

interface Live {
  driver: AgentDriver;
  agent: AgentKind;
  model: string;
  effort: string;
  instructions?: string;
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
  private codexServer?: CodexServer;
  private modelLists = new Map<AgentKind, { expires: number; promise: Promise<ModelOption[]> }>();
  readonly tmpDir: string;
  private usageState: UsageInfo = {};
  private geminiUsageRefresh?: Promise<void>;
  private attachments: AttachmentStore;
  /** Where a role's events currently go (its own node, or a consult it is serving). */
  private routes = new Map<number, Partial<Record<Role, NodeId>>>();

  constructor(
    readonly store: Store,
    readonly sink: Sink,
    dataDir: string,
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
          delegateHighRisk: !!project?.settings.delegateHighRisk,
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
    const gemini = findGemini(this.store.getSetting("geminiPath"));
    return [
      {
        agent: "claude",
        path: claude,
        error: claude ? undefined : "claude.exe를 찾지 못했습니다. PowerShell에서 irm https://claude.ai/install.ps1 | iex 로 설치하고 로그인하세요.",
      },
      { agent: "codex", path: codex, error: codex ? undefined : "codex.exe를 찾지 못했습니다. Codex 앱 또는 Codex CLI를 설치하세요." },
      { agent: "gemini", path: gemini, error: gemini ? undefined : "Antigravity CLI(agy.exe)를 찾지 못했습니다. 설치 경로를 확인한 뒤 ‘목록 다시 확인’을 눌러 주세요." },
    ];
  }

  claudeExe(): string {
    const exe = findClaude(this.store.getSetting("claudePath"));
    if (!exe) throw new Error(this.cliInfo()[0].error);
    return exe;
  }

  geminiExe(): string {
    const exe = findGemini(this.store.getSetting("geminiPath"));
    if (!exe) throw new Error(this.cliInfo().find((c) => c.agent === "gemini")!.error);
    return exe;
  }

  geminiModels() { return listGeminiModels(this.geminiExe(), this.tmpDir); }

  async models(agent: AgentKind): Promise<ModelOption[]> {
    const cached = this.modelLists.get(agent);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = agent === "codex" ? this.codex().models() : agent === "gemini" ? this.geminiModels()
      : listClaudeModels(this.claudeExe(), this.tmpDir).then((list) => list.map((m) => ({
        id: m.value, label: m.displayName, isDefault: m.value === "opus",
        reasoningEfforts: m.supportsEffort ? m.supportedEffortLevels ?? [] : [],
      })));
    this.modelLists.set(agent, { expires: Date.now() + 60_000, promise });
    try { return await promise; }
    catch (error) { if (this.modelLists.get(agent)?.promise === promise) this.modelLists.delete(agent); throw error; }
  }

  async assignmentEffort(chatId: number, role: Role, requested?: string): Promise<{ requestedEffort: string; effort: string }> {
    const chat = this.store.chat(chatId)!;
    const cfg = this.roleConfig(chat, this.store.project(chat.projectId)!, role);
    const choice = role === "orch" ? cfg.effort : workerEffort(cfg.effort, requested);
    if (!choice) return { requestedEffort: requested ?? "", effort: "" };
    const models = await this.models(cfg.agent);
    const model = cfg.model ? models.find((m) => m.id === cfg.model) : models.find((m) => m.isDefault);
    if (!model) throw new Error("선택한 모델의 추론 수준을 확인하지 못했습니다. 모델을 다시 선택하세요.");
    return { requestedEffort: requested ?? choice, effort: resolveEffort(choice, model) };
  }

  async teamCapabilities(chat: Chat) {
    const project = this.store.project(chat.projectId)!;
    const installed = this.cliInfo();
    const gptModel = chat.codexModelOverride ?? project.settings.codexModel;
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
        const id = agent === "claude" ? chat.claudeModelOverride ?? project.settings.claudeModel : agent === "codex" ? gptModel : chat.geminiModelOverride ?? project.settings.geminiModel;
        const model = id ? models.find((m) => m.id === id) : models.find((m) => m.isDefault);
        effortLevels[agent] = WORKER_EFFORTS.filter((level) => model?.reasoningEfforts?.includes(level));
      } catch { /* Unknown levels remain unavailable, never invent support. */ }
    }));
    return {
      claude: { installed: !!installed.find((c) => c.agent === "claude")?.path, model: chat.claudeModelOverride ?? project.settings.claudeModel, reasoningEfforts: effortLevels.claude, effortSetting: chat.claudeEffortOverride ?? project.settings.claudeEffort, imageGeneration: false, authentication: "실행 시 확인", usage: this.usageState.claude },
      gpt: { installed: !!installed.find((c) => c.agent === "codex")?.path, model: gptModel, reasoningEfforts: effortLevels.codex, effortSetting: chat.codexEffortOverride ?? project.settings.codexEffort, imageGeneration, authenticated: codexAuthenticated, usage: this.usageState.codex },
      gemini: { installed: !!installed.find((c) => c.agent === "gemini")?.path, model: (chat.geminiModelOverride ?? project.settings.geminiModel) || "Pro 계정 제공 모델 자동 선택", reasoningEfforts: effortLevels.gemini, effortSetting: chat.geminiEffortOverride ?? project.settings.geminiEffort, imageGeneration: false, authentication: "Antigravity 로그인·모델 목록은 실행 시 확인", enabled: project.settings.maxGeminiWorkers > 0, usage: this.usageState.gemini },
    };
  }

  codex(): CodexServer {
    if (!this.codexServer) {
      const exe = findCodex(this.store.getSetting("codexPath"));
      if (!exe) throw new Error(this.cliInfo()[1].error);
      this.codexServer = new CodexServer(exe);
      this.codexServer.onUsage = (u) => this.mergeUsage(u);
    }
    return this.codexServer;
  }

  mergeUsage(u: UsageInfo) {
    // Updates can be partial (one window only); keep the windows they don't mention.
    for (const k of ["claude", "codex"] as const) {
      const next = u[k];
      if (!next) continue;
      const cur = this.usageState[k] ?? {};
      this.usageState = { ...this.usageState, [k]: { fiveHour: next.fiveHour ?? cur.fiveHour, weekly: next.weekly ?? cur.weekly } };
    }
    // Gemini /usage is a complete snapshot; errors must not retain a stale percentage.
    if (u.gemini) this.usageState = { ...this.usageState, gemini: u.gemini };
    // Remember the last values so the sidebar isn't empty on the next launch.
    if (!this.disposing) this.store.setSetting("usage", JSON.stringify(this.usageState));
    this.sink.usage(this.usageState);
  }
  usage(): UsageInfo {
    return this.usageState;
  }

  /** Claude reports limits only inside a model turn; ask its local /usage command instead (0 tokens). */
  async refreshClaudeUsage() {
    const exe = findClaude(this.store.getSetting("claudePath"));
    if (!exe) return;
    const text = await claudeUsageText(exe, this.tmpDir).catch(() => null);
    const parsed = text ? parseClaudeUsageText(text) : null;
    if (parsed) this.mergeUsage({ claude: parsed });
  }

  refreshGeminiUsage(): Promise<void> {
    if (this.geminiUsageRefresh) return this.geminiUsageRefresh;
    const exe = findGemini(this.store.getSetting("geminiPath"));
    if (!exe) {
      this.mergeUsage({ gemini: { error: "Antigravity CLI를 찾지 못했습니다. 설치 경로를 확인해 주세요." } });
      return Promise.resolve();
    }
    this.geminiUsageRefresh = readGeminiUsage(exe, this.tmpDir)
      .then((usage) => { if (!this.disposing) this.mergeUsage({ gemini: { ...usage, updatedAt: Date.now() } }); })
      .catch((error) => { if (!this.disposing) this.mergeUsage({ gemini: { error: error instanceof Error ? error.message : "Gemini 사용량 조회에 실패했습니다." } }); })
      .finally(() => { this.geminiUsageRefresh = undefined; });
    return this.geminiUsageRefresh;
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
    if (pending > 0) this.updateChat(chatId, { status: "approval" });
    else if (chat.status === "approval") this.updateChat(chatId, { status: this.isBusy(chatId) ? "working" : "idle" });
  }

  isBusy(chatId: number): boolean {
    return Object.values(this.live.get(chatId) ?? {}).some((l) => l?.driver.running);
  }

  // ---------- roles and drivers
  /** Agent + model a role uses right now (orchestrator follows the project; workers may be overridden per chat). */
  roleConfig(chat: Chat, project: Project, role: Role): RoleConfig {
    if (role === "orch") return { ...chatOrchestrator(chat, project), effort: chat.orchestratorEffortOverride ?? project.settings.orchestratorEffort };
    const worker = this.store.agentByKey(chat.id, role);
    if (worker?.kind === "gpt") return { agent: "codex", model: chat.codexModelOverride ?? project.settings.codexModel, effort: chat.codexEffortOverride ?? project.settings.codexEffort };
    if (worker?.kind === "gemini") return { agent: "gemini", model: chat.geminiModelOverride ?? project.settings.geminiModel, effort: chat.geminiEffortOverride ?? project.settings.geminiEffort };
    return { agent: "claude", model: chat.claudeModelOverride ?? project.settings.claudeModel, effort: chat.claudeEffortOverride ?? project.settings.claudeEffort };
  }

  private nativeIdOf(chat: Chat, role: Role, agent: AgentKind): string | null {
    if (role === "orch") return agent === "claude" ? chat.orchClaudeSessionId : chat.orchCodexThreadId;
    return this.store.agentByKey(chat.id, role)?.sessionId ?? null;
  }

  private saveNativeId(chatId: number, role: Role, agent: AgentKind, id: string) {
    if (role === "orch") {
      this.updateChat(chatId, agent === "claude" ? { orchClaudeSessionId: id } : { orchCodexThreadId: id });
      return;
    }
    const w = this.store.agentByKey(chatId, role);
    if (w) {
      this.store.updateAgent(w.id, { sessionId: id });
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
    const effort = assignmentEffort ?? (await this.assignmentEffort(chatId, role)).effort;
    const instructions = this.instructionsFor?.(chat, project, role, cfg.agent);
    const slot = this.live.get(chatId) ?? {};
    this.live.set(chatId, slot);
    const cur = slot[role];
    if (cur && !cur.driver.running) {
      if (cur.agent !== cfg.agent || cur.instructions !== instructions || (cur.agent !== "codex" && (cur.model !== cfg.model || cur.effort !== effort))) {
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
        else if (event.type === "turn_end" && !this.isBusy(chatId) && this.store.chat(chatId)?.status === "working") {
          const final = this.pendingFinal.get(chatId) ?? "idle";
          this.pendingFinal.delete(chatId);
          this.updateChat(chatId, { status: final, unread: final !== "idle", touch: true });
        }
      },
      nativeId: (id) => this.saveNativeId(chatId, role, cfg.agent, id),
      approve: (input) => this.approvals.request(chatId, project.folder, { ...input, role, node: this.route(chatId, role) }),
      usage: (u) => this.mergeUsage(u),
      image: (image) => this.attachments.generatedImage(chatId, image),
    };
    const opts = {
      cwd: project.folder,
      nativeId: this.nativeIdOf(chat, role, cfg.agent),
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
      tokenBaseline: this.store.events(chatId).findLast((e) => e.role === role && e.event.type === "agent_usage" && e.event.metrics.nativeId === this.nativeIdOf(chat, role, cfg.agent))?.event,
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
    } else if (cfg.agent === "gemini") {
      driver = new GeminiDriver({ ...driverOpts, exePath: this.geminiExe() }, {
        bridge: this.bridge, hookScript: join(dirname(this.bridgeScript), "antigravity-hook.js"), tmpDir: this.tmpDir, sessionKey: `${chatId}-${role}`,
        mcpServers: () => this.toolsFor?.(this.store.chat(chatId)!, role, "gemini") ?? {},
      }, host);
    } else {
      const servers = this.toolsFor?.(chat, role, "codex");
      driver = new CodexDriver(
        { ...driverOpts, codexConfig: servers ? codexMcpConfig(servers) : undefined },
        this.codex(),
        host,
      );
    }
    slot[role] = { driver, agent: cfg.agent, model: cfg.model, effort, instructions };
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
  async disposeRole(chatId: number, role: Role) {
    const slot = this.live.get(chatId);
    const l = slot?.[role];
    if (slot) delete slot[role];
    this.setRoute(chatId, role, undefined);
    await l?.driver.dispose().catch(() => undefined);
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

  async send(chatId: number, text: string, attachmentIds: number[], delivery: "now" | "next" = "next") {
    if (!["now", "next"].includes(delivery)) throw new Error("지원하지 않는 전달 방식입니다.");
    const chat = this.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    const attachments = this.store.attachmentsFor(attachmentIds);
    if (chat.status === "working" || chat.status === "approval" || this.isBusy(chatId)) {
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
    await Promise.all(Object.values(this.live.get(chatId) ?? {}).map((l) => l?.driver.stop()));
  }

  answerApproval(chatId: number, id: string, decision: ApprovalDecision) {
    this.approvals.answer(chatId, id, decision);
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
    await this.codexServer?.dispose();
    this.bridge.stop();
  }
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

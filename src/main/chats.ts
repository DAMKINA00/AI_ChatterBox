// Owns the live drivers per chat (one per role: orchestrator, Claude worker, GPT worker),
// persists normalized events, tracks chat status, and forwards everything to the renderer.
// The Orchestrator (orchestrator.ts) plugs in through the hooks at the bottom.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  chatOrchestrator,
  type AgentEvent,
  type AgentKind,
  type ApprovalDecision,
  type ApprovalRequest,
  type Chat,
  type CliInfo,
  type Consult,
  type NodeId,
  type Project,
  type Role,
  type TimelineEvent,
  type UsageInfo,
} from "../shared/types";
import type { ChatPatch, Store } from "./db";
import { LocalBridge } from "./local-bridge";
import { ApprovalService, type ApprovalInput, type JudgeAnswer } from "./approvals";
import { findClaude, findCodex } from "./locate";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver, CodexServer } from "./drivers/codex";
import type { AgentDriver, AgentInput, DriverHost } from "./drivers/types";

export interface Sink {
  event(e: TimelineEvent): void;
  chat(chat: Chat): void;
  consult(c: Consult): void;
  usage(u: UsageInfo): void;
}

/** Live-only events (not persisted). */
const TRANSIENT = new Set<AgentEvent["type"]>(["text_delta"]);

/** Tools the read-only orchestrator may not use (Claude). */
const ORCH_DISALLOWED = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];

interface Live {
  driver: AgentDriver;
  agent: AgentKind;
  model: string;
}

export interface RoleConfig {
  agent: AgentKind;
  model: string;
}

export class ChatManager {
  readonly bridge = new LocalBridge();
  readonly approvals: ApprovalService;
  private live = new Map<number, Partial<Record<Role, Live>>>();
  private codexServer?: CodexServer;
  readonly tmpDir: string;
  private usageState: UsageInfo = {};
  /** Where a role's events currently go (its own node, or a consult it is serving). */
  private routes = new Map<number, Partial<Record<Role, NodeId>>>();

  constructor(
    readonly store: Store,
    readonly sink: Sink,
    dataDir: string,
    readonly bridgeScript: string,
  ) {
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
    });
  }

  start() {
    return this.bridge.start();
  }

  // ---------- CLIs
  cliInfo(): CliInfo[] {
    const claude = findClaude(this.store.getSetting("claudePath"));
    const codex = findCodex(this.store.getSetting("codexPath"));
    return [
      {
        agent: "claude",
        path: claude,
        error: claude ? undefined : "claude.exe를 찾지 못했습니다. PowerShell에서 irm https://claude.ai/install.ps1 | iex 로 설치하고 로그인하세요.",
      },
      { agent: "codex", path: codex, error: codex ? undefined : "codex.exe를 찾지 못했습니다. Codex 앱 또는 Codex CLI를 설치하세요." },
    ];
  }

  claudeExe(): string {
    const exe = findClaude(this.store.getSetting("claudePath"));
    if (!exe) throw new Error(this.cliInfo()[0].error);
    return exe;
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
    // Remember the last values so the sidebar isn't empty on the next launch.
    if (!this.disposing) this.store.setSetting("usage", JSON.stringify(this.usageState));
    this.sink.usage(this.usageState);
  }
  usage(): UsageInfo {
    return this.usageState;
  }

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
  }

  updateChat(chatId: number, patch: ChatPatch): Chat {
    // While quitting, keep the stored status ("working" → "interrupted" on next launch).
    if (this.disposing) return this.store.chat(chatId)!;
    const chat = this.store.updateChat(chatId, patch);
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
    if (role === "orch") return chatOrchestrator(chat, project);
    if (role === "claude") return { agent: "claude", model: chat.claudeModelOverride ?? project.settings.claudeModel };
    return { agent: "codex", model: chat.codexModelOverride ?? project.settings.codexModel };
  }

  private nativeIdOf(chat: Chat, role: Role, agent: AgentKind): string | null {
    if (role === "orch") return agent === "claude" ? chat.orchClaudeSessionId : chat.orchCodexThreadId;
    return role === "claude" ? chat.claudeSessionId : chat.codexThreadId;
  }

  private nativeIdPatch(role: Role, agent: AgentKind, id: string): ChatPatch {
    if (role === "orch") return agent === "claude" ? { orchClaudeSessionId: id } : { orchCodexThreadId: id };
    return role === "claude" ? { claudeSessionId: id } : { codexThreadId: id };
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
  instructionsFor?: (chat: Chat, project: Project, role: Role, agent: AgentKind) => string | undefined;
  /** Extra MCP servers for a role: Claude --mcp-config entries and the same entries as Codex config. */
  toolsFor?: (chat: Chat, role: Role, agent: AgentKind) => Record<string, any> | undefined;

  /**
   * Driver for a role, created on demand. If the role's CLI or model changed since the driver was
   * made (project/chat settings), the old one is replaced; the CLI session is resumed, so context stays.
   */
  async driver(chatId: number, role: Role): Promise<AgentDriver> {
    const chat = this.store.chat(chatId)!;
    const project = this.store.project(chat.projectId)!;
    const cfg = this.roleConfig(chat, project, role);
    const slot = this.live.get(chatId) ?? {};
    this.live.set(chatId, slot);
    const cur = slot[role];
    if (cur && !cur.driver.running) {
      if (cur.agent !== cfg.agent || (cur.agent === "claude" && cur.model !== cfg.model)) {
        await cur.driver.dispose();
        delete slot[role];
      } else if (cur.agent === "codex" && cur.model !== cfg.model) {
        (cur.driver as CodexDriver).setModel(cfg.model || undefined);
        cur.model = cfg.model;
      }
    }
    if (slot[role]) return slot[role]!.driver;

    const host: DriverHost = {
      emit: (event) => {
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
      nativeId: (id) => this.updateChat(chatId, this.nativeIdPatch(role, cfg.agent, id)),
      approve: (input) => this.approvals.request(chatId, project.folder, { ...input, role, node: this.route(chatId, role) }),
      usage: (u) => this.mergeUsage(u),
    };
    const opts = {
      cwd: project.folder,
      nativeId: this.nativeIdOf(chat, role, cfg.agent),
      exePath: "",
      model: cfg.model || undefined,
      instructions: this.instructionsFor?.(chat, project, role, cfg.agent),
      readOnly: role === "orch",
    };
    let driver: AgentDriver;
    if (cfg.agent === "claude") {
      driver = new ClaudeDriver(
        { ...opts, exePath: this.claudeExe() },
        {
          bridge: this.bridge,
          bridgeScript: this.bridgeScript,
          tmpDir: this.tmpDir,
          mcpServers: () => this.toolsFor?.(this.store.chat(chatId)!, role, "claude") ?? {},
          disallowedTools: role === "orch" ? ORCH_DISALLOWED : undefined,
          allowedTools: role === "orch" ? ["mcp__chatterbox_bridge"] : undefined,
        },
        host,
      );
    } else {
      const servers = this.toolsFor?.(chat, role, "codex");
      driver = new CodexDriver(
        { ...opts, codexConfig: servers ? codexMcpConfig(servers) : undefined },
        this.codex(),
        host,
      );
    }
    slot[role] = { driver, agent: cfg.agent, model: cfg.model };
    return driver;
  }

  liveDriver(chatId: number, role: Role): AgentDriver | undefined {
    return this.live.get(chatId)?.[role]?.driver;
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
  busySend?: (chat: Chat, input: AgentInput) => Promise<void>;

  async send(chatId: number, text: string, attachmentIds: number[]) {
    const chat = this.store.chat(chatId);
    if (!chat) throw new Error("채팅이 없습니다.");
    const attachments = this.store.attachmentsFor(attachmentIds);
    if (chat.status === "working" || chat.status === "approval" || this.isBusy(chatId)) {
      if (!this.busySend) throw new Error("작업이 진행 중입니다. 끝나거나 중지한 뒤 보내 주세요.");
      const ev = this.store.addEvent(chatId, "orch", null, { type: "user", text, attachments, queued: true });
      this.store.linkAttachments(attachmentIds, ev.id);
      this.sink.event(ev);
      await this.busySend(chat, { text, attachments });
      return;
    }
    const isFirst = !this.store.hasUserEvent(chatId);
    const userEvent = this.store.addEvent(chatId, "orch", null, { type: "user", text, attachments });
    this.store.linkAttachments(attachmentIds, userEvent.id);
    this.sink.event(userEvent);
    this.updateChat(chatId, {
      status: "working",
      touch: true,
      title: isFirst ? titleFrom(text, attachments.length) : undefined,
    });
    try {
      await this.sendHandler(chat, { text, attachments });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit(chatId, "orch", "orch", { type: "error", kind: "process", message });
      this.orchTurnEnded(chatId, { type: "turn_end", ok: false, error: message });
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
    // The orchestrator runs with approvalPolicy "never"; our own tools must not need approval.
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

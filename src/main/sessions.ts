// Owns the live drivers, persists normalized events, and forwards them to the renderer.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentKind, ApprovalDecision, CliInfo, Session } from "../shared/types";
import type { Store } from "./db";
import { ApprovalBroker } from "./approval-broker";
import { findClaude, findCodex } from "./locate";
import { ClaudeDriver } from "./drivers/claude";
import { CodexDriver, CodexServer } from "./drivers/codex";
import type { AgentDriver } from "./drivers/types";

export interface SessionSink {
  event(sessionId: number, event: AgentEvent): void;
  sessionUpdated(session: Session): void;
}

/** Events that are only for live display and are not persisted. */
const TRANSIENT = new Set<AgentEvent["type"]>(["text_delta"]);

export class SessionManager {
  private drivers = new Map<number, AgentDriver>();
  private broker = new ApprovalBroker();
  private codexServer?: CodexServer;
  private tmpDir: string;

  constructor(
    private store: Store,
    private sink: SessionSink,
    dataDir: string,
    private approverScript: string,
  ) {
    this.tmpDir = join(dataDir, "tmp");
    mkdirSync(this.tmpDir, { recursive: true });
  }

  start() {
    return this.broker.start();
  }

  cliInfo(): CliInfo[] {
    const claude = findClaude(this.store.getSetting("claudePath"));
    const codex = findCodex(this.store.getSetting("codexPath"));
    return [
      {
        agent: "claude",
        path: claude,
        error: claude ? undefined : "claude.exe를 찾지 못했습니다. Claude Code를 설치하세요: irm https://claude.ai/install.ps1 | iex",
      },
      { agent: "codex", path: codex, error: codex ? undefined : "codex.exe를 찾지 못했습니다. Codex 앱 또는 CLI를 설치하세요." },
    ];
  }

  private emit(sessionId: number, event: AgentEvent) {
    if (!TRANSIENT.has(event.type)) this.store.addEvent(sessionId, event);
    this.sink.event(sessionId, event);
    if (event.type === "turn_end") this.sink.sessionUpdated(this.store.updateSession(sessionId, { status: "idle" }));
    if (event.type === "error" && event.kind === "auth")
      this.sink.sessionUpdated(this.store.updateSession(sessionId, { status: "error" }));
  }

  private driverFor(session: Session): AgentDriver {
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const exePath = this.cliInfo().find((c) => c.agent === session.agent)?.path;
    if (!exePath) throw new Error(this.cliInfo().find((c) => c.agent === session.agent)!.error);
    const cb = {
      onEvent: (e: AgentEvent) => this.emit(session.id, e),
      onNativeId: (id: string) => this.sink.sessionUpdated(this.store.updateSession(session.id, { nativeId: id })),
    };
    const opts = { cwd: session.cwd, nativeId: session.nativeId, exePath };
    let driver: AgentDriver;
    if (session.agent === "claude") {
      driver = new ClaudeDriver(opts, { broker: this.broker, approverScript: this.approverScript, tmpDir: this.tmpDir }, cb);
    } else {
      this.codexServer ??= new CodexServer(exePath);
      driver = new CodexDriver(opts, this.codexServer, cb);
    }
    this.drivers.set(session.id, driver);
    return driver;
  }

  create(workspaceId: number, agent: AgentKind): Session {
    const ws = this.store.workspace(workspaceId);
    if (!ws) throw new Error("워크스페이스가 없습니다.");
    const n = this.store.listSessions(workspaceId).filter((s) => s.agent === agent).length + 1;
    return this.store.createSession(workspaceId, agent, ws.path, `${agent === "claude" ? "Claude" : "Codex"} 세션 ${n}`);
  }

  async send(sessionId: number, text: string) {
    let session = this.store.session(sessionId);
    if (!session) throw new Error("세션이 없습니다.");
    const driver = this.driverFor(session);
    // First message becomes the title.
    const isFirst = !this.store.events(sessionId).some((e) => e.event.type === "user");
    session = this.store.updateSession(sessionId, {
      status: "running",
      title: isFirst ? text.replace(/\s+/g, " ").slice(0, 40) : undefined,
    });
    this.sink.sessionUpdated(session);
    this.emit(sessionId, { type: "user", text });
    try {
      await driver.send(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit(sessionId, { type: "error", kind: "process", message });
      this.emit(sessionId, { type: "turn_end", ok: false, error: message });
    }
  }

  async stop(sessionId: number) {
    await this.drivers.get(sessionId)?.stop();
  }

  answerApproval(sessionId: number, approvalId: string, decision: ApprovalDecision) {
    this.drivers.get(sessionId)?.answerApproval(approvalId, decision);
  }

  async dispose() {
    await Promise.all([...this.drivers.values()].map((d) => d.dispose().catch(() => undefined)));
    this.drivers.clear();
    await this.codexServer?.dispose();
    this.broker.stop();
  }
}

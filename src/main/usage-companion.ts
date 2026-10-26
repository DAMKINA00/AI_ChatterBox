import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type {
  GeminiPlan,
  UsageCommandName,
  UsageCompanionSnapshot,
  UsageMonitorState,
  UsageNotification,
} from "../shared/usage-companion";

const MAX_LINE_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const TITLE = "AI 사용량 모니터";
const NO_VALUE_COMMANDS = new Set<UsageCommandName>([
  "show", "hide", "refresh", "accounts", "claude-login", "claude-logout", "gemini-unblock", "data-folder", "quit",
]);
const BOOLEAN_COMMANDS = new Set<UsageCommandName>([
  "topmost", "characters", "taskbar", "startup", "usage-alerts", "activity-alerts", "claude-desktop",
]);
const PLANS = new Set<Exclude<GeminiPlan, null>>(["Free", "Google AI Pro", "Google AI Ultra"]);

export interface UsageWritable {
  write(data: string): unknown;
  end(): unknown;
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface UsageReadable {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface UsageChild {
  stdin: UsageWritable | null;
  stdout: UsageReadable | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type UsageSpawn = (file: string, args: string[], options: SpawnOptions) => UsageChild;

export interface UsageCompanionOptions {
  exe: string;
  settingsFile: string;
  allowed: boolean;
  changed(snapshot: UsageCompanionSnapshot): void;
  notification(notification: UsageNotification): void;
  spawn?: UsageSpawn;
}

interface ChildSession {
  child: UsageChild;
  ended: boolean;
  initialState: boolean;
  startTimer?: NodeJS.Timeout;
  startPromise?: Promise<void>;
  startResolve?: () => void;
  startReject?: (error: Error) => void;
  startSettled: boolean;
  stopping: boolean;
  stopTimer?: NodeJS.Timeout;
  stopPromise?: Promise<void>;
  stopResolve?: () => void;
  stopReject?: (error: Error) => void;
  line: Buffer;
  lineLength: number;
  lineTooLong: boolean;
}

function text(value: unknown, fallback: string): string {
  const message = typeof value === "string" && value.length > 0 ? value : fallback;
  if (/https?:\/\/|\b(?:authorization|bearer|cookie|password|token|api[-_ ]?key)\b/i.test(message)) return fallback;
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function readEnabled(file: string): boolean {
  if (!existsSync(file)) return true;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return !!value && typeof value === "object" && !Array.isArray(value) && (value as { usageEnabled?: unknown }).usageEnabled !== false;
  } catch {
    return true;
  }
}

function validState(value: unknown): value is UsageMonitorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const booleans = [
    "visible", "topmost", "characters", "taskbar", "startup", "usageAlerts", "activityAlerts",
    "claudeDesktop", "claudeLoggedIn", "geminiBlocked",
  ];
  if (booleans.some(key => typeof state[key] !== "boolean")) return false;
  return state.geminiPlan === null || (typeof state.geminiPlan === "string" && PLANS.has(state.geminiPlan as Exclude<GeminiPlan, null>));
}

function copyState(state: UsageMonitorState): UsageMonitorState {
  return { ...state };
}

export class UsageCompanion {
  private enabled: boolean;
  private state?: UsageMonitorState;
  private error?: string;
  private session?: ChildSession;
  private readonly spawn: UsageSpawn;

  constructor(private readonly options: UsageCompanionOptions, spawn?: UsageSpawn) {
    this.enabled = options.allowed && readEnabled(options.settingsFile);
    this.spawn = spawn ?? options.spawn ?? ((file, args, settings) => nodeSpawn(file, args, settings) as unknown as UsageChild);
  }

  snapshot(): UsageCompanionSnapshot {
    const snapshot: UsageCompanionSnapshot = { enabled: this.enabled, running: !!this.session && !this.session.ended };
    if (this.state) snapshot.state = copyState(this.state);
    if (this.error) snapshot.error = this.error;
    return Object.freeze(snapshot);
  }

  start(): Promise<void> {
    return this.startInternal(false);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.options.allowed) return;
    this.persistEnabled(enabled);
    this.enabled = enabled;
    this.publish();
    if (enabled) await this.startInternal(false);
    else await this.stop();
  }

  async command(name: UsageCommandName | string, value?: unknown): Promise<void> {
    if (!this.options.allowed) return;
    const command = this.validateCommand(name, value);
    if (command.command === "quit") {
      await this.stop();
      return;
    }
    if (!this.enabled) {
      this.persistEnabled(true);
      this.enabled = true;
      this.publish();
    }
    await this.startInternal(true);
    const session = this.session;
    if (!session || session.ended) throw new Error("AI 사용량 모니터가 실행 중이 아닙니다.");
    this.write(session, command);
  }

  stop(): Promise<void> {
    if (!this.options.allowed) return Promise.resolve();
    const session = this.session;
    if (!session || session.ended) return Promise.resolve();
    if (session.stopPromise) return session.stopPromise;
    session.stopping = true;
    session.stopPromise = new Promise<void>((resolve, reject) => {
      session.stopResolve = resolve;
      session.stopReject = reject;
      session.stopTimer = setTimeout(() => {
        session.stopTimer = undefined;
        const stopError = new Error("AI 사용량 모니터가 15초 안에 종료되지 않았습니다.");
        const stopReject = session.stopReject;
        session.stopPromise = undefined;
        session.stopResolve = undefined;
        session.stopReject = undefined;
        stopReject?.(stopError);
      }, STOP_TIMEOUT_MS);
      let failure: Error | undefined;
      try {
        this.write(session, { command: "quit" });
      } catch (error) {
        failure = new Error(text(error instanceof Error ? error.message : error, "AI 사용량 모니터 종료에 실패했습니다."));
      }
      try {
        session.child.stdin?.end();
      } catch (error) {
        failure ??= new Error(text(error instanceof Error ? error.message : error, "AI 사용량 모니터 종료에 실패했습니다."));
      }
      if (failure) reject(failure);
    });
    return session.stopPromise;
  }

  private startInternal(force: boolean): Promise<void> {
    if (!this.options.allowed || (!force && !this.enabled)) return Promise.resolve();
    const existing = this.session;
    if (existing && !existing.ended) {
      if (existing.startPromise && !existing.startSettled) return existing.startPromise;
      return existing.startPromise ?? Promise.resolve();
    }

    let child: UsageChild;
    try {
      child = this.spawn(this.options.exe, ["--hosted"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: process.env,
      });
    } catch (error) {
      return this.failStart(text(error instanceof Error ? error.message : error, "AI 사용량 모니터 실행에 실패했습니다."));
    }

    const session: ChildSession = {
      child,
      ended: false,
      initialState: false,
      startSettled: false,
      stopping: false,
      line: Buffer.allocUnsafe(MAX_LINE_BYTES),
      lineLength: 0,
      lineTooLong: false,
    };
    this.session = session;
    this.publish();
    session.startPromise = new Promise<void>((resolve, reject) => {
      session.startResolve = resolve;
      session.startReject = reject;
      session.startTimer = setTimeout(() => this.failStartForSession(session, "AI 사용량 모니터가 20초 안에 준비되지 않았습니다."), START_TIMEOUT_MS);
      session.startTimer.unref?.();
    });

    child.stdout?.on("data", (chunk: unknown) => this.read(session, chunk));
    child.stdout?.on("end", () => {
      if (session.lineLength || session.lineTooLong) this.line(session);
      session.lineLength = 0;
      session.lineTooLong = false;
    });
    child.stdin?.on?.("error", (error: unknown) => this.inputError(session, error));
    child.on("error", (error: unknown) => this.childError(session, error));
    child.on("exit", (code: unknown) => this.childExit(session, typeof code === "number" ? code : null));
    child.on("close", () => this.childExit(session, null));
    if (!child.stdout || !child.stdin) this.failStartForSession(session, "AI 사용량 모니터 입출력 채널을 열지 못했습니다.");
    return session.startPromise;
  }

  private failStart(message: string): Promise<void> {
    this.fail(message);
    return Promise.reject(new Error(message));
  }

  private failStartForSession(session: ChildSession, message: string) {
    if (session.startSettled) return;
    if (session.startTimer) clearTimeout(session.startTimer);
    session.startTimer = undefined;
    session.startSettled = true;
    session.startReject?.(new Error(message));
    this.fail(message);
    try { session.child.stdin?.end(); } catch { /* already closed */ }
  }

  private childError(session: ChildSession, error: unknown) {
    if (session !== this.session || session.ended) return;
    const message = text(error instanceof Error ? error.message : error, "AI 사용량 모니터 실행에 실패했습니다.");
    if (!session.startSettled) this.failStartForSession(session, message);
    else this.fail(message);
    if (session.stopping) session.stopReject?.(new Error(message));
  }

  private inputError(session: ChildSession, error: unknown) {
    if (session !== this.session || session.ended) return;
    const message = text(error instanceof Error ? error.message : error, "AI 사용량 모니터 입력 채널이 닫혔습니다.");
    if (!session.startSettled) this.failStartForSession(session, message);
    else this.fail(message);
    if (session.stopping) session.stopReject?.(new Error(message));
  }

  private childExit(session: ChildSession, code: number | null) {
    if (session !== this.session || session.ended) return;
    session.ended = true;
    if (session.startTimer) clearTimeout(session.startTimer);
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.startTimer = session.stopTimer = undefined;
    this.session = undefined;
    this.publish();
    if (!session.startSettled) {
      session.startSettled = true;
      const message = code === 2
        ? "AI 사용량 모니터가 이미 실행 중입니다. 기존 단독 실행을 종료한 뒤 호스트 모드로 시작하세요."
        : `AI 사용량 모니터가 시작 전에 종료되었습니다${code === null ? "" : ` (코드 ${code})`}.`;
      session.startReject?.(new Error(message));
      this.fail(message);
    } else if (!session.stopping) {
      const message = code === 2
        ? "AI 사용량 모니터가 이미 실행 중인 인스턴스 때문에 종료되었습니다."
        : `AI 사용량 모니터가 예기치 않게 종료되었습니다${code === null ? "" : ` (코드 ${code})`}.`;
      this.fail(message);
    }
    if (session.stopping) session.stopResolve?.();
  }

  private read(session: ChildSession, chunk: unknown) {
    if (session !== this.session || session.ended) return;
    const data = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
    for (const byte of data) {
      if (byte === 0x0a) {
        this.line(session);
        session.lineLength = 0;
        session.lineTooLong = false;
      } else if (!session.lineTooLong) {
        if (session.lineLength === MAX_LINE_BYTES) session.lineTooLong = true;
        else session.line[session.lineLength++] = byte;
      }
    }
  }

  private line(session: ChildSession) {
    if (session.lineTooLong) return this.protocolError(session, `상태 줄이 ${MAX_LINE_BYTES}바이트를 초과했습니다.`);
    let value: unknown;
    try {
      const line = session.line.subarray(0, session.lineLength);
      const bytes = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return this.protocolError(session, "AI 사용량 모니터 응답 형식이 올바르지 않습니다.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return this.protocolError(session, "AI 사용량 모니터 응답 형식이 올바르지 않습니다.");
    const message = value as Record<string, unknown>;
    if (message.type === "state" && validState(message.state)) {
      session.initialState = true;
      this.state = copyState(message.state);
      this.error = undefined;
      this.publish();
      if (!session.startSettled) {
        if (session.startTimer) clearTimeout(session.startTimer);
        session.startTimer = undefined;
        session.startSettled = true;
        session.startResolve?.();
      }
      return;
    }
    if (message.type === "notification" && typeof message.title === "string" && typeof message.message === "string" && typeof message.error === "boolean") {
      this.options.notification({ title: text(message.title, TITLE).slice(0, 200), message: text(message.message, "AI 사용량 모니터 알림"), error: message.error });
      return;
    }
    if (message.type === "error" && typeof message.message === "string") {
      return this.fail(text(message.message, "AI 사용량 모니터 오류"));
    }
    this.protocolError(session, "AI 사용량 모니터 응답 형식이 올바르지 않습니다.");
  }

  private protocolError(_session: ChildSession, message: string) {
    this.fail(message);
  }

  private fail(message: string) {
    this.error = message;
    this.publish();
    this.options.notification({ title: TITLE, message, error: true });
  }

  private publish() {
    this.options.changed(this.snapshot());
  }

  private persistEnabled(enabled: boolean) {
    let settings: Record<string, unknown> = {};
    if (existsSync(this.options.settingsFile)) {
      const parsed: unknown = JSON.parse(readFileSync(this.options.settingsFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ChatterBox 설정 파일 형식이 올바르지 않습니다.");
      settings = { ...(parsed as Record<string, unknown>) };
    }
    settings.usageEnabled = enabled;
    const temporary = `${this.options.settingsFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings, null, 2), "utf8");
    try {
      renameSync(temporary, this.options.settingsFile);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* preserve the original settings */ }
      throw error;
    }
  }

  private validateCommand(name: string, value: unknown): { command: UsageCommandName; value?: boolean | GeminiPlan } {
    if (!NO_VALUE_COMMANDS.has(name as UsageCommandName) && !BOOLEAN_COMMANDS.has(name as UsageCommandName) && name !== "gemini-plan") throw new Error(`지원하지 않는 사용량 모니터 명령입니다: ${name}`);
    const command = name as UsageCommandName;
    if (NO_VALUE_COMMANDS.has(command)) {
      if (value !== undefined) throw new Error(`명령 '${name}'에는 값이 필요하지 않습니다.`);
      return { command };
    }
    if (BOOLEAN_COMMANDS.has(command)) {
      if (typeof value !== "boolean") throw new Error(`명령 '${name}'에는 불리언 값이 필요합니다.`);
      return { command, value };
    }
    if (value !== null && !PLANS.has(value as Exclude<GeminiPlan, null>)) throw new Error("Gemini 등급 값이 올바르지 않습니다.");
    return { command, value: value as GeminiPlan };
  }

  private write(session: ChildSession, command: { command: UsageCommandName; value?: boolean | GeminiPlan }) {
    const payload: Record<string, unknown> = { command: command.command };
    if (command.value !== undefined || command.command === "gemini-plan") payload.value = command.value;
    session.child.stdin!.write(`${JSON.stringify(payload)}\n`);
  }
}

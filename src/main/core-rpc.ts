// Private, authenticated transport between this launch's UI and elevated core.
import { deserialize, serialize } from "node:v8";
import type { Socket } from "node:net";

const MAX_FRAME = 128 * 1024 * 1024;
type Handler = (...args: any[]) => unknown;
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class CoreRpc {
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private authenticated = false;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Handler>();
  private authTimer: ReturnType<typeof setTimeout>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  onEvent?: (channel: string, args: unknown[]) => void;
  onClose?: () => void;

  constructor(private socket: Socket, private token: string, client = false) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // A peer may disappear before its caller starts awaiting ready.
    void this.ready.catch(() => undefined);
    this.authTimer = setTimeout(() => socket.destroy(), 10_000);
    socket.on("data", data => this.read(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(this.authTimer);
      const error = new Error("관리자 코어와 연결이 끊어졌습니다. 앱을 다시 실행해 주세요.");
      this.readyReject(error);
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      this.onClose?.();
    });
    if (client) this.write({ type: "hello", token });
  }

  handle(channel: string, handler: Handler) { this.handlers.set(channel, handler); }
  emit(channel: string, ...args: unknown[]) { if (this.authenticated && !this.socket.destroyed) this.write({ type: "event", channel, args }); }
  close() { this.socket.destroy(); }

  async call<T = any>(channel: string, args: unknown[] = [], timeout = 300_000): Promise<T> {
    await this.ready;
    if (this.socket.destroyed) throw new Error("관리자 코어가 종료됐습니다.");
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`관리자 코어 응답 시간이 초과됐습니다: ${channel}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ type: "call", id, channel, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private write(message: unknown) {
    const body = serialize(message);
    if (body.length > MAX_FRAME) throw new Error("한 번에 전달할 수 있는 크기(128MB)를 초과했습니다.");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private read(data: Buffer) {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE();
        if (!length || length > MAX_FRAME) throw new Error("Invalid core frame");
        if (this.buffer.length < length + 4) break;
        const message = deserialize(this.buffer.subarray(4, length + 4));
        this.buffer = this.buffer.subarray(length + 4);
        this.receive(message);
      }
    } catch { this.socket.destroy(); }
  }

  private receive(message: any) {
    if (!message || typeof message !== "object") throw new Error("Invalid core message");
    if (!this.authenticated) {
      if (message.type !== "hello" || message.token !== this.token) throw new Error("Unauthenticated core");
      this.authenticated = true;
      clearTimeout(this.authTimer);
      this.write({ type: "hello", token: this.token });
      this.readyResolve();
      return;
    }
    if (message.type === "hello") return;
    if (message.type === "event" && typeof message.channel === "string" && Array.isArray(message.args)) {
      this.onEvent?.(message.channel, message.args);
    } else if (message.type === "result" && Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (typeof message.error === "string") pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    } else if (message.type === "call" && Number.isSafeInteger(message.id) && typeof message.channel === "string" && Array.isArray(message.args)) {
      const handler = this.handlers.get(message.channel);
      void Promise.resolve().then(() => {
        if (!handler) throw new Error("지원하지 않는 코어 요청입니다.");
        return handler(...message.args);
      }).then(value => {
        if (!this.socket.destroyed) this.write({ type: "result", id: message.id, value });
      }).catch(error => {
        if (!this.socket.destroyed) this.write({ type: "result", id: message.id, error: error instanceof Error ? error.message : String(error) });
      });
    } else throw new Error("Invalid core message");
  }
}

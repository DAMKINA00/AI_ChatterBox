import { DEEPSEEK_MODEL, DEEPSEEK_MODELS, type DeepSeekBalance, type DeepSeekInput, type DeepSeekStatus } from "../shared/deepseek";
import type { SecretStorage } from "./aistudio";

interface Settings { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }
const KEY = "deepseekApiKey";

/** Only the main process decrypts the key and sends it to the official HTTPS origin. */
export class DeepSeekService {
  private checked?: DeepSeekStatus;
  constructor(private store: Settings, private secrets: SecretStorage, private request: typeof fetch = fetch) {}
  settings() { return { model: DEEPSEEK_MODEL, videoEnabled: false }; }
  status(): DeepSeekStatus {
    const apiKeySet = !!this.store.getSetting(KEY);
    return this.checked ?? { apiKeySet, state: apiKeySet ? "configured" : "unconfigured", models: [] };
  }
  save(input: DeepSeekInput) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("DeepSeek 설정이 잘못되었습니다.");
    if (input.apiKey === undefined || input.apiKey === "") return;
    if (typeof input.apiKey !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(input.apiKey.trim())) throw new Error("올바른 DeepSeek API 키를 입력하세요.");
    this.store.setSetting(KEY, this.secrets.encrypt(input.apiKey.trim()));
    this.checked = undefined;
  }
  remove() { this.store.setSetting(KEY, ""); this.checked = undefined; }
  async response(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    if (!["/v1/models", "/v1/chat/completions", "/v1/user/balance"].includes(path) || (path !== "/v1/chat/completions" && body !== undefined)) throw new Error("지원하지 않는 DeepSeek API 경로입니다.");
    const encrypted = this.store.getSetting(KEY);
    if (!encrypted) throw new Error("DeepSeek API 설정에서 API 키를 저장하세요.");
    let key: string;
    try { key = this.secrets.decrypt(encrypted); } catch { throw new Error("DeepSeek API 키를 복호화할 수 없습니다. 이 Windows 계정에서 키를 다시 저장하세요."); }
    let response: Response;
    try {
      response = await this.request("https://api.deepseek.com" + path.slice(3), {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(body === undefined ? 15000 : 300000), ...(signal ? [signal] : [])]),
      });
    } catch { signal?.throwIfAborted(); throw new Error("DeepSeek API에 연결하지 못했습니다. 네트워크 또는 응답 시간 초과를 확인하세요."); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const hint: Record<number, string> = { 400: "모델과 요청 형식을 확인하세요.", 401: "API 키를 확인하세요.", 402: "API 잔액이 부족합니다.", 403: "계정의 API 접근 권한을 확인하세요.", 429: "요청 한도에 도달했습니다. 잠시 후 다시 시도하세요." };
      // Upstream errors can echo headers or prompts; never send their body to renderer/logs.
      throw new Error(`DeepSeek API ${response.status}: ${hint[response.status] ?? "서비스 오류입니다. 잠시 후 다시 시도하세요."}`);
    }
    return response;
  }
  async json(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await this.response(path, body, signal);
    try { return await response.json(); } catch { throw new Error("DeepSeek API 응답을 읽지 못했습니다."); }
  }
  async check(): Promise<DeepSeekStatus> {
    // Checking credentials only lists models; it never makes a paid completion request.
    const configuredKey = this.store.getSetting(KEY);
    let status: DeepSeekStatus;
    try {
      const result = await this.json("/v1/models");
      if (!Array.isArray(result.data) || !result.data.length || result.data.some((m: any) => typeof m?.id !== "string" || !/^[\w.:-]{1,150}$/.test(m.id))) throw new Error("DeepSeek 모델 목록 형식이 잘못되었습니다.");
      status = { apiKeySet: !!configuredKey, state: "ready", checkedAt: Date.now(), models: [...new Set<string>(result.data.map((m: any) => m.id))] };
    } catch (error) {
      status = { apiKeySet: !!configuredKey, state: "error", checkedAt: Date.now(), models: [], error: error instanceof Error ? error.message : "DeepSeek 연결 확인에 실패했습니다." };
    }
    if (this.store.getSetting(KEY) !== configuredKey) return this.status();
    this.checked = status;
    return status;
  }
  async balance(): Promise<DeepSeekBalance> {
    if (!this.store.getSetting(KEY)) return { state: "unconfigured", balances: [] };
    try {
      const result = await this.json("/v1/user/balance");
      const amount = (value: unknown) => typeof value === "string" && /^-?\d{1,20}(?:\.\d{1,20})?$/.test(value);
      if (typeof result?.is_available !== "boolean" || !Array.isArray(result.balance_infos) || !result.balance_infos.length
        || result.balance_infos.some((b: any) => !["USD", "CNY"].includes(b?.currency) || !amount(b.total_balance) || !amount(b.granted_balance) || !amount(b.topped_up_balance))
        || new Set(result.balance_infos.map((b: any) => b.currency)).size !== result.balance_infos.length)
        throw new Error("DeepSeek 잔고 응답 형식이 잘못되었습니다.");
      // Keep monetary strings intact; never round small balances or combine currencies.
      return { state: "ready", isAvailable: result.is_available, updatedAt: Date.now(), balances: result.balance_infos.map((b: any) => ({ currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance })) };
    } catch (error) {
      return { state: "error", balances: [], updatedAt: Date.now(), error: error instanceof Error ? error.message : "DeepSeek 잔고 조회에 실패했습니다." };
    }
  }
  models() {
    return [...DEEPSEEK_MODELS, ...(this.checked?.models ?? []).filter(id => !DEEPSEEK_MODELS.some(m => m.id === id)).map(id => ({ id, label: id }))];
  }
}

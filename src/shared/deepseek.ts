import type { ModelOption } from "./types";

export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEEPSEEK_MODELS: ModelOption[] = [
  { id: DEEPSEEK_MODEL, label: "DeepSeek Flash", isDefault: true, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
];
export type DeepSeekAction = "status" | "save" | "check" | "remove" | "balance";
export interface DeepSeekInput { apiKey?: string }
export interface DeepSeekStatus {
  apiKeySet: boolean;
  state: "unconfigured" | "configured" | "ready" | "error";
  models: string[];
  checkedAt?: number;
  error?: string;
}

export interface DeepSeekBalance {
  state: "unconfigured" | "loading" | "ready" | "error";
  balances: { currency: "USD" | "CNY"; total: string; granted: string; toppedUp: string }[];
  isAvailable?: boolean;
  updatedAt?: number;
  error?: string;
}

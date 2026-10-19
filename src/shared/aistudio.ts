/** Separate from the existing Gemini Web and Antigravity CLI model IDs. */
export const AISTUDIO_MODEL = "aistudio:gemini-4-argon";
export const isAIStudioModel = (id: string | undefined) => !!id?.startsWith("aistudio:");
export const AI_STUDIO_ACCOUNT_LIMIT = 10;

export interface AIStudioSettings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  executable: string;
  videoEnabled: boolean;
}
export interface AIStudioAccount {
  id: string;
  label: string;
  enabled: boolean;
  state: string;
  benefit_tier: string;
  message: string;
  models: string[];
}
export interface AIStudioCooldown {
  account_id: string;
  account_label: string;
  model_id: string;
  channel: string;
  until: string;
  reason?: string;
}
export interface AIStudioStatus {
  settings: AIStudioSettings;
  state: string;
  version?: string;
  accounts: AIStudioAccount[];
  cooldowns: AIStudioCooldown[];
  models: { id: string; name: string }[];
  error?: string;
  webLinks?: Record<string, { accountId?: string; state: "connected" | "error"; message: string; checkedAt: number }>;
}
export type AIStudioAction = "status" | "save" | "launch" | "start" | "stop" | "refresh" | "enable" | "open" | "export-antigravity" | "sync-web";
export interface AIStudioInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  executable?: string;
  videoEnabled?: boolean;
  accountId?: string;
  enabled?: boolean;
}

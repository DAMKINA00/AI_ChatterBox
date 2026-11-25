import type { AgentKind } from "./types";
import { isMonitorCharacter, type MonitorCharacterId } from "./usage-companion";

export const CHARACTER_PROVIDERS = { claude: "claude", gpt: "codex", gemini: "gemini", grok: "grok", deepseek: "deepseek" } as const;
export const CHARACTER_MEETING_VERSION = 1;
export type CharacterModel = { agent: AgentKind; model: string };
export type CharacterModels = Partial<Record<MonitorCharacterId, CharacterModel>>;
export type MeetingRequest = { requestId: string; text: string; folder?: string };
export type MeetingMessage = { id: string; at: number; sender: MonitorCharacterId | "user" | "system"; text: string; kind?: "assignment" | "report" | "review" | "summary" };
export type MeetingEvent = { requestId: string; seq: number } & (
  | { type: "roster"; connected: MonitorCharacterId[] }
  | { type: "status"; text: string }
  | { type: "message" | "draft"; message: MeetingMessage }
  | { type: "withdraw"; id: string }
  | { type: "end"; text: string }
);

export type MeetingSnapshot = {
  seq: number;
  requestId: string | null;
  messages: MeetingMessage[];
  drafts: MeetingMessage[];
  connected: MonitorCharacterId[];
  status: string;
};

export function meetingRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

export function parseMeetingRequest(value: unknown): MeetingRequest | undefined {
  if (!value || typeof value !== "object") return;
  const { requestId, text, folder } = value as Partial<MeetingRequest>;
  if (!meetingRequestId(requestId) || typeof text !== "string" || !text.trim() || text.length > 4_000
    || (folder !== undefined && (typeof folder !== "string" || folder.length > 2_000 || /[\x00-\x1f]/.test(folder)))) return;
  return { requestId, text: text.trim(), folder: folder || undefined };
}

export function parseCharacterModels(value: unknown): CharacterModels {
  const result: CharacterModels = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, choice] of Object.entries(value)) {
    if (!isMonitorCharacter(id) || !choice || typeof choice !== "object") continue;
    const { agent, model } = choice as Partial<CharacterModel>;
    if (agent && (id === "orch" ? (Object.values(CHARACTER_PROVIDERS) as AgentKind[]).includes(agent) : CHARACTER_PROVIDERS[id] === agent)
      && typeof model === "string" && model.length <= 160 && model.trim() === model && !/[\x00-\x1f]/.test(model)) result[id] = { agent, model };
  }
  return result;
}

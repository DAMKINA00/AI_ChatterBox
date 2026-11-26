export interface UsageMonitorState {
  visible: boolean;
  topmost: boolean;
  characters: boolean;
  taskbar: boolean;
  startup: boolean;
  usageAlerts: boolean;
  activityAlerts: boolean;
  claudeDesktop: boolean;
  claudeLoggedIn: boolean;
  /** Version of the ChatterBox account message the monitor reads (absent: an older monitor; nothing is sent). */
  accountsVersion?: number;
  /**
   * Characters switched on, in MONITOR_CHARACTERS order (absent: an older monitor with a single on/off toggle).
   * `characters` stays true when at least one is on.
   */
  characterSet?: MonitorCharacterId[];
  /** Characters this monitor can show (absent: the original five, without DeepSeek). */
  characterIds?: MonitorCharacterId[];
  /** 1 = the monitor accepts "character-event" (assignment, result and chat notices for a character). */
  characterEvents?: number;
  /** 2 = the monitor supports private character questions independent of the desktop chat. */
  characterAsk?: number;
  characterMeeting?: number;
}

/** Every character the monitor may show, in display order. */
export const MONITOR_CHARACTERS = ["orch", "claude", "gpt", "gemini", "grok", "deepseek"] as const;
/** What a monitor without `characterIds` can show. */
export const LEGACY_MONITOR_CHARACTERS: readonly MonitorCharacterId[] = ["orch", "claude", "gpt", "gemini", "grok"];
export type MonitorCharacterId = (typeof MONITOR_CHARACTERS)[number];
export const MONITOR_CHARACTER_LABEL: Record<MonitorCharacterId, string> = {
  orch: "마스터(Orch)", claude: "클로드", gpt: "지피티", gemini: "제미나이", grok: "그록", deepseek: "딥시크",
};
export const isMonitorCharacter = (value: unknown): value is MonitorCharacterId =>
  typeof value === "string" && (MONITOR_CHARACTERS as readonly string[]).includes(value);
/** Known ids only, no duplicates, display order. */
export const normalizeCharacterSet = (values: readonly unknown[]): MonitorCharacterId[] =>
  MONITOR_CHARACTERS.filter(id => values.some(v => v === id));


export const CHARACTER_ASK_VERSION = 2;
export const MAX_CHARACTER_QUESTION = 4_000;
export const MAX_CHARACTER_ANSWER = 12_000;

export interface CharacterAsk {
  requestId: string;
  character: MonitorCharacterId;
  text: string;
}

export type CharacterAnswer =
  | { status: "answer"; text: string }
  | { status: "busy" | "error"; text?: string };

export type CharacterReply = Omit<CharacterAsk, "text"> & CharacterAnswer;

/** Validate the typed question at both process boundaries. */
export function parseCharacterAsk(value: unknown): CharacterAsk | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { requestId, character, text } = value as Partial<CharacterAsk>;
  if (typeof requestId !== "string" || !/^[0-9a-f]{32}$/i.test(requestId) || !isMonitorCharacter(character)
    || typeof text !== "string" || text.length > MAX_CHARACTER_QUESTION || !text.trim()) return;
  return { requestId, character, text: text.trim() };
}

export interface UsageNotification {
  title: string;
  message: string;
  error: boolean;
}

export interface UsageCompanionSnapshot {
  enabled: boolean;
  running: boolean;
  state?: UsageMonitorState;
  error?: string;
}

export type UsageCommandName =
  | "show"
  | "hide"
  | "refresh"
  | "accounts"
  | "topmost"
  | "characters"
  /** One character on/off: value `{ id: MonitorCharacterId, on: boolean }` (monitors that report `characterSet`). */
  | "character"
  /** A character event for the monitor (value: CharacterEvent); only sent when the state reports characterEvents: 1. */
  | "character-event"
  | "character-reply"
  | "meeting-open"
  | "meeting-event"
  | "meeting-reset"
  | "meeting-restore"
  | "meeting-interrupt-result"
  | "taskbar"
  | "startup"
  | "usage-alerts"
  | "activity-alerts"
  | "claude-desktop"
  | "claude-login"
  | "claude-logout"
  | "data-folder"
  | "quit";

/** The characters a monitor can show: its reported `characterIds`, or the original five for older monitors. */
export const supportedCharacters = (state: Pick<UsageMonitorState, "characterIds"> | undefined): readonly MonitorCharacterId[] =>
  Array.isArray(state?.characterIds) ? normalizeCharacterSet(state.characterIds) : LEGACY_MONITOR_CHARACTERS;

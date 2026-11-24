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
}

/** The five characters the monitor can show, in display order. */
export const MONITOR_CHARACTERS = ["orch", "claude", "gpt", "gemini", "grok"] as const;
export type MonitorCharacterId = (typeof MONITOR_CHARACTERS)[number];
export const MONITOR_CHARACTER_LABEL: Record<MonitorCharacterId, string> = {
  orch: "마스터(Orch)", claude: "클로드", gpt: "지피티", gemini: "제미나이", grok: "그록",
};
export const isMonitorCharacter = (value: unknown): value is MonitorCharacterId =>
  typeof value === "string" && (MONITOR_CHARACTERS as readonly string[]).includes(value);
/** Known ids only, no duplicates, display order. */
export const normalizeCharacterSet = (values: readonly unknown[]): MonitorCharacterId[] =>
  MONITOR_CHARACTERS.filter(id => values.some(v => v === id));

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
  | "taskbar"
  | "startup"
  | "usage-alerts"
  | "activity-alerts"
  | "claude-desktop"
  | "claude-login"
  | "claude-logout"
  | "data-folder"
  | "quit";

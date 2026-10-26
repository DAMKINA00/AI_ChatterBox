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
  | "taskbar"
  | "startup"
  | "usage-alerts"
  | "activity-alerts"
  | "claude-desktop"
  | "claude-login"
  | "claude-logout"
  | "data-folder"
  | "quit";

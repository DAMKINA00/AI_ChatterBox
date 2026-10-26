export type AppUpdateStatus = "disabled" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  version?: string;
  percent?: number;
  checkedAt?: number;
  error?: string;
}

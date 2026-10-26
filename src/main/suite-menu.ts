import type { MenuItemConstructorOptions } from "electron";
import type { AppUpdateState } from "../shared/app-updates";
import type { UsageCommandName, UsageCompanionSnapshot, UsageMonitorState } from "../shared/usage-companion";

export function suiteMenu(usage: UsageCompanionSnapshot, update: Readonly<AppUpdateState>, actions: {
  enable(value: boolean): void;
  command(name: UsageCommandName, value?: unknown): void;
  check(): void;
  install(): void;
}): MenuItemConstructorOptions[] {
  const state = usage.state;
  const toggle = (label: string, field: keyof UsageMonitorState, command: UsageCommandName): MenuItemConstructorOptions => ({
    label, type: "checkbox", checked: state?.[field] === true, enabled: usage.running && !!state,
    click: item => actions.command(command, item.checked),
  });
  const updateLabel = {
    disabled: `버전 ${update.currentVersion}`, idle: update.checkedAt ? `최신 버전 · ${update.currentVersion}` : `버전 ${update.currentVersion}`,
    checking: "업데이트 확인 중…", downloading: `업데이트 다운로드 · ${Math.round(update.percent ?? 0)}%`,
    ready: `새 버전 ${update.version ?? ""} 준비됨`, installing: "업데이트 적용 중…", error: update.error ?? "업데이트 확인 실패",
  }[update.status];
  return [
    { type: "separator" },
    { label: "AI 사용량 모니터", type: "checkbox", checked: usage.enabled, click: item => actions.enable(item.checked) },
    ...(usage.error ? [{ label: usage.error, enabled: false }] : []),
    { label: "사용량 모니터 설정", submenu: [
      { label: state?.visible ? "모니터 숨기기" : "모니터 열기", click: () => actions.command(state?.visible ? "hide" : "show") },
      { label: "사용량 새로 고침", click: () => actions.command("refresh") },
      { label: "계정 관리", click: () => actions.command("accounts") },
      { type: "separator" },
      toggle("항상 위에", "topmost", "topmost"), toggle("캐릭터 표시", "characters", "characters"),
      toggle("작업표시줄 사용량", "taskbar", "taskbar"), toggle("Windows 시작 시 함께 실행", "startup", "startup"),
      toggle("사용량 알림", "usageAlerts", "usage-alerts"), toggle("작업 상태 알림", "activityAlerts", "activity-alerts"),
      { type: "separator" },
      toggle("Claude Desktop 연결", "claudeDesktop", "claude-desktop"),
      { label: "Claude 웹 로그인", click: () => actions.command("claude-login") },
      { label: "Claude 웹 로그아웃", enabled: !!state?.claudeLoggedIn, click: () => actions.command("claude-logout") },
      { label: "Gemini 조회 차단 해제", visible: !!state?.geminiBlocked, click: () => actions.command("gemini-unblock") },
      { label: "Gemini 등급", submenu: [null, "Free", "Google AI Pro", "Google AI Ultra"].map(plan => ({
        label: plan ?? "자동 감지", type: "radio" as const, checked: state?.geminiPlan === plan,
        click: () => actions.command("gemini-plan", plan),
      })) },
      { label: "사용량 데이터 폴더", click: () => actions.command("data-folder") },
    ] },
    { type: "separator" },
    { label: updateLabel, enabled: false },
    { label: "업데이트 확인", enabled: ["idle", "error"].includes(update.status), click: actions.check },
    { label: "업데이트하고 재시작", visible: update.status === "ready", click: actions.install },
  ];
}

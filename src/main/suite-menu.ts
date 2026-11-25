import type { MenuItemConstructorOptions } from "electron";
import type { AppUpdateState } from "../shared/app-updates";
import { MONITOR_CHARACTER_LABEL, supportedCharacters, type UsageCommandName, type UsageCompanionSnapshot, type UsageMonitorState } from "../shared/usage-companion";

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
  // Monitors that report `characterSet` get one checkbox per character; older ones keep the single toggle.
  const characterItem = (): MenuItemConstructorOptions => {
    const set = state?.characterSet;
    if (!Array.isArray(set)) return toggle("캐릭터 표시", "characters", "characters");
    const enabled = usage.running;
    const ids = supportedCharacters(state); // older monitors cannot show DeepSeek
    return { label: "캐릭터 표시", submenu: [
      ...ids.map((id): MenuItemConstructorOptions => ({
        label: MONITOR_CHARACTER_LABEL[id], type: "checkbox", checked: set.includes(id), enabled,
        click: item => actions.command("character", { id, on: item.checked }),
      })),
      { type: "separator" },
      // "All": every character on, not the monitor's "restore last selection" meaning of characters=true.
      // Every supported id is sent (each is idempotent): the menu's checks may be older than commands still in flight.
      { label: "모두 표시", enabled,
        click: () => { for (const id of ids) actions.command("character", { id, on: true }); } },
      { label: "모두 숨기기", enabled, click: () => actions.command("characters", false) },
    ] };
  };
  const updateLabel = {
    disabled: `버전 ${update.currentVersion}`, idle: update.checkedAt ? `최신 버전 · ${update.currentVersion}` : `버전 ${update.currentVersion}`,
    checking: "업데이트 확인 중…", downloading: `업데이트 다운로드 · ${Math.round(update.percent ?? 0)}%`,
    ready: `새 버전 ${update.version ?? ""} 준비됨`, installing: "업데이트 적용 중…", error: update.error ?? "업데이트 확인 실패",
  }[update.status];
  return [
    { type: "separator" },
    { label: "AI 사용량 모니터", type: "checkbox", checked: usage.enabled, click: item => actions.enable(item.checked) },
    ...(state?.characterMeeting === 1 ? [{ label: "캐릭터 회의실  (Alt+Space)", click: () => actions.command("meeting-open") }] : []),
    ...(usage.error ? [{ label: usage.error, enabled: false }] : []),
    { label: "사용량 모니터 설정", submenu: [
      { label: state?.visible ? "모니터 숨기기" : "모니터 열기", click: () => actions.command(state?.visible ? "hide" : "show") },
      { label: "사용량 새로 고침", click: () => actions.command("refresh") },
      // Accounts are managed in ChatterBox; the monitor only shows them.
      { label: "계정별 사용량", click: () => actions.command("accounts") },
      { type: "separator" },
      toggle("항상 위에", "topmost", "topmost"), characterItem(),
      toggle("작업표시줄 사용량", "taskbar", "taskbar"), toggle("Windows 시작 시 함께 실행", "startup", "startup"),
      toggle("사용량 알림", "usageAlerts", "usage-alerts"), toggle("작업 상태 알림", "activityAlerts", "activity-alerts"),
      { type: "separator" },
      { label: "사용량 데이터 폴더", click: () => actions.command("data-folder") },
    ] },
    { type: "separator" },
    { label: updateLabel, enabled: false },
    { label: "업데이트 확인", enabled: ["idle", "error"].includes(update.status), click: actions.check },
    { label: "업데이트하고 재시작", visible: update.status === "ready", click: actions.install },
  ];
}

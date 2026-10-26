import assert from "node:assert/strict";
import { test } from "node:test";
import { suiteMenu } from "./suite-menu";

test("single tray keeps all monitor actions and gates update installation on downloaded state", () => {
  const calls: unknown[][] = [];
  const actions = { enable: (on: boolean) => calls.push(["enable", on]), command: (...args: unknown[]) => calls.push(args), check() {}, install: () => calls.push(["install"]) };
  const menu = suiteMenu({ enabled: true, running: true, state: {
    visible: true, topmost: true, characters: true, taskbar: true, startup: true, usageAlerts: true,
    activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true,
  } }, { status: "ready", currentVersion: "1.0.0", version: "1.0.1" }, actions);
  const items = menu.find(i => i.label === "사용량 모니터 설정")!.submenu as any[];
  for (const label of ["모니터 숨기기", "계정 관리", "작업표시줄 사용량", "Windows 시작 시 함께 실행", "Claude 웹 로그아웃", "사용량 데이터 폴더"]) assert.ok(items.some(i => i.label === label));
  assert.ok(items.every(i => !String(i.label).includes("Gemini")));
  items.find(i => i.label === "캐릭터 표시").click({ checked: false });
  items.find(i => i.label === "계정 관리").click();
  (menu.find(i => i.label === "업데이트하고 재시작")!.click as any)();
  assert.deepEqual(calls, [["characters", false], ["accounts"], ["install"]]);
  assert.equal(menu.find(i => i.label === "업데이트 확인")!.enabled, false);
  const downloading = suiteMenu({ enabled: false, running: false }, { status: "downloading", currentVersion: "1", percent: 25 }, actions);
  assert.equal(downloading.find(i => i.label === "업데이트하고 재시작")!.visible, false);
  assert.equal(downloading.find(i => i.label === "AI 사용량 모니터")!.checked, false);
});

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
  for (const label of ["모니터 숨기기", "계정별 사용량", "작업표시줄 사용량", "Windows 시작 시 함께 실행", "사용량 데이터 폴더"]) assert.ok(items.some(i => i.label === label));
  // The monitor has no accounts or logins of its own any more: ChatterBox manages them.
  assert.ok(items.every(i => !/Claude (웹|Desktop)|로그인|로그아웃/.test(String(i.label))));
  assert.ok(items.every(i => !String(i.label).includes("Gemini")));
  items.find(i => i.label === "캐릭터 표시").click({ checked: false });
  items.find(i => i.label === "계정별 사용량").click();
  (menu.find(i => i.label === "업데이트하고 재시작")!.click as any)();
  assert.deepEqual(calls, [["characters", false], ["accounts"], ["install"]]);
  assert.equal(menu.find(i => i.label === "업데이트 확인")!.enabled, false);
  const downloading = suiteMenu({ enabled: false, running: false }, { status: "downloading", currentVersion: "1", percent: 25 }, actions);
  assert.equal(downloading.find(i => i.label === "업데이트하고 재시작")!.visible, false);
  assert.equal(downloading.find(i => i.label === "AI 사용량 모니터")!.checked, false);
});

test("a monitor reporting characterSet gets a per-character submenu; all/none and each checkbox send the right commands", () => {
  const calls: unknown[][] = [];
  const actions = { enable() {}, command: (...args: unknown[]) => calls.push(args), check() {}, install() {} };
  const base = { visible: true, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true };
  const menu = suiteMenu({ enabled: true, running: true, state: { ...base, characterSet: ["orch", "gpt"] } }, { status: "idle", currentVersion: "1" }, actions);
  const settings = menu.find(i => i.label === "사용량 모니터 설정")!.submenu as any[];
  const sub = settings.find(i => i.label === "캐릭터 표시").submenu as any[];
  const boxes = sub.filter(i => i.type === "checkbox");
  assert.deepEqual(boxes.map(i => `${i.label}=${i.checked}`), ["마스터(Orch)=true", "클로드=false", "지피티=true", "제미나이=false", "그록=false"]);
  boxes.find(i => i.label === "그록").click({ checked: true });
  boxes.find(i => i.label === "지피티").click({ checked: false });
  sub.find(i => i.label === "모두 표시").click();
  sub.find(i => i.label === "모두 숨기기").click();
  assert.deepEqual(calls, [
    ["character", { id: "grok", on: true }], ["character", { id: "gpt", on: false }],
    ...["orch", "claude", "gpt", "gemini", "grok"].map(id => ["character", { id, on: true }]),
    ["characters", false],
  ]);
  const none = suiteMenu({ enabled: true, running: true, state: { ...base, characters: false, characterSet: [] } }, { status: "idle", currentVersion: "1" }, actions);
  const noneSub = ((none.find(i => i.label === "사용량 모니터 설정")!.submenu as any[]).find(i => i.label === "캐릭터 표시").submenu) as any[];
  assert.equal(noneSub.find(i => i.label === "모두 숨기기").enabled, true, "always enabled while running: the checks may lag behind commands in flight");
  assert.equal(noneSub.find(i => i.label === "모두 표시").enabled, true);
  const stopped = suiteMenu({ enabled: true, running: false, state: { ...base, characterSet: ["orch"] } }, { status: "idle", currentVersion: "1" }, actions);
  const stoppedSub = ((stopped.find(i => i.label === "사용량 모니터 설정")!.submenu as any[]).find(i => i.label === "캐릭터 표시").submenu) as any[];
  assert.ok(stoppedSub.every(i => i.type === "separator" || i.enabled === false), "nothing is clickable while the monitor is not running");
});

test("[review 1078-1] hide all then show all on a stale Orch-only snapshot still turns all five on", () => {
  const calls: unknown[][] = [];
  const actions = { enable() {}, command: (...args: unknown[]) => calls.push(args), check() {}, install() {} };
  const base = { visible: true, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true };
  // Both clicks use the same snapshot (the monitor has not answered the first one yet).
  const menu = suiteMenu({ enabled: true, running: true, state: { ...base, characterSet: ["orch"] } }, { status: "idle", currentVersion: "1" }, actions);
  const sub = ((menu.find(i => i.label === "사용량 모니터 설정")!.submenu as any[]).find(i => i.label === "캐릭터 표시").submenu) as any[];
  sub.find(i => i.label === "모두 숨기기").click();
  sub.find(i => i.label === "모두 표시").click();
  // Applied in order by the monitor: everything off, then each of the five on, Orch included.
  assert.deepEqual(calls, [["characters", false], ...["orch", "claude", "gpt", "gemini", "grok"].map(id => ["character", { id, on: true }])]);
});

test("DeepSeek appears only for monitors that report it in characterIds", () => {
  const base = { visible: true, topmost: false, characters: true, taskbar: true, startup: false, usageAlerts: true, activityAlerts: false, claudeDesktop: true, claudeLoggedIn: true };
  const labels = (state: any) => (((suiteMenu({ enabled: true, running: true, state }, { status: "idle", currentVersion: "1" }, { enable() {}, command() {}, check() {}, install() {} })
    .find(i => i.label === "사용량 모니터 설정")!.submenu as any[]).find(i => i.label === "캐릭터 표시").submenu) as any[]).filter(i => i.type === "checkbox").map(i => i.label);
  assert.deepEqual(labels({ ...base, characterSet: [] }), ["마스터(Orch)", "클로드", "지피티", "제미나이", "그록"]);
  assert.deepEqual(labels({ ...base, characterSet: [], characterIds: ["orch", "claude", "gpt", "gemini", "grok", "deepseek"] }), ["마스터(Orch)", "클로드", "지피티", "제미나이", "그록", "딥시크"]);
});

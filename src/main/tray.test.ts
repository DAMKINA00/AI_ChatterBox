import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";

test("tray adapter shows focused approval/final notices and click opens the target chat", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: MockNotification[] = [];
  class MockNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(readonly options: { title: string; body: string }) { super(); }
    show() { shown.push(this); }
  }
  const electron = {
    Notification: MockNotification,
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
  };
  const required = createRequire(resolve("package.json"));
  const { buildSync } = required("esbuild") as typeof import("esbuild");
  const compiled = buildSync({ entryPoints: [resolve("src/main/tray.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] }).outputFiles[0].text;
  const module = { exports: {} as any };
  runInNewContext(compiled, { module, exports: module.exports, process, setTimeout, clearTimeout, require: (id: string) => id === "electron" ? electron : required(id) });
  const selected: unknown[][] = [];
  const window = { isVisible: () => true, isFocused: () => true, isMinimized: () => false, show() {}, focus() {}, webContents: { send: (...args: unknown[]) => selected.push(args) } };
  const tray = new module.exports.AppTray({ window: () => window, chats: () => [], createWindow() {}, quit() {} });
  const chat = { id: 7, title: "Approval chat", status: "approval", goal: null };
  tray.chatChanged(chat);
  assert.equal(shown.length, 1);
  assert.match(shown[0].options.body, /마스터/);
  shown[0].emit("click");
  assert.deepEqual(selected, [["select-chat", 7]]);
  t.mock.timers.tick(60_000);
  assert.equal(shown.length, 2);
  assert.match(shown[1].options.body, /1분/);
  tray.chatChanged({ ...chat, status: "working" });
  tray.chatChanged({ ...chat, status: "done" });
  t.mock.timers.tick(500);
  assert.equal(shown.length, 3);
  assert.match(shown[2].options.body, /전체 작업/);
  tray.chatChanged({ ...chat, status: "done" });
  t.mock.timers.tick(120_000);
  assert.equal(shown.length, 3);
  tray.destroy();
});

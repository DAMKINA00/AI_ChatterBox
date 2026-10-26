import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { AppUpdates, type AppUpdatesHost, type UpdaterBackend } from "./app-updates";
import type { AppUpdateState } from "../shared/app-updates";

class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  nextCheck: Promise<unknown> = Promise.resolve();

  checkForUpdates() {
    this.checks++;
    return this.nextCheck;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function fixture(enabled = true) {
  const backend = new FakeBackend();
  const states: AppUpdateState[] = [];
  const downloaded: AppUpdateState[] = [];
  const host: AppUpdatesHost = { version: "1.2.3", enabled, changed: state => states.push({ ...state }), downloaded: state => downloaded.push({ ...state }) };
  return { backend, states, downloaded, updates: new AppUpdates(backend, host) };
}

test("uses production flags and debounces scheduled checks", async () => {
  const f = fixture();
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    f.updates.start();
    assert.equal(f.backend.checks, 0);
    mock.timers.tick(29_999);
    assert.equal(f.backend.checks, 0);
    mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.backend.checks, 1);
    mock.timers.tick(6 * 60 * 60 * 1_000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.backend.checks, 2);
    assert.deepEqual([f.backend.autoDownload, f.backend.autoInstallOnAppQuit, f.backend.allowPrerelease, f.backend.allowDowngrade], [true, false, false, false]);
  } finally {
    f.updates.stop();
    mock.timers.reset();
  }
});

test("coalesces checks and never checks disabled hosts", async () => {
  const f = fixture();
  let resolve!: () => void;
  f.backend.nextCheck = new Promise<void>(done => (resolve = done));
  const first = f.updates.check();
  const second = f.updates.check();
  assert.equal(f.backend.checks, 1);
  assert.strictEqual(first, second);
  resolve();
  await first;

  const disabled = fixture(false);
  disabled.updates.start();
  await disabled.updates.check();
  assert.equal(disabled.backend.checks, 0);
  assert.deepEqual(disabled.updates.snapshot(), { status: "disabled", currentVersion: "1.2.3" });
  disabled.updates.stop();
});

test("tracks progress, notifies once per downloaded version, and installs manually", () => {
  const f = fixture();
  f.updates.start();
  f.backend.emit("update-available", { version: "1.3.0" });
  f.backend.emit("download-progress", { percent: 35.5 });
  assert.deepEqual(f.updates.snapshot(), { status: "downloading", currentVersion: "1.2.3", version: "1.3.0", percent: 35.5 });
  f.backend.emit("update-downloaded", { version: "1.3.0" });
  f.backend.emit("update-downloaded", { version: "1.3.0" });
  assert.equal(f.downloaded.length, 1);
  assert.equal(f.updates.install(), true);
  assert.deepEqual(f.backend.installs, [[true, true]]);
  assert.equal(f.updates.snapshot().status, "installing");
  f.updates.stop();
});

test("sanitizes errors and removes only its listeners", async () => {
  const f = fixture();
  const other = () => undefined;
  f.backend.on("error", other);
  f.updates.start();
  f.backend.emit("error", new Error("Authorization: Bearer secret-token"));
  assert.equal(f.updates.snapshot().status, "error");
  assert.equal(f.updates.snapshot().error?.includes("secret-token"), false);
  f.updates.stop();
  assert.equal(f.backend.listenerCount("error"), 1);
  f.backend.emit("error", new Error("still handled by other"));
});

test("turns a rejected check into a safe error state", async () => {
  const f = fixture();
  f.backend.nextCheck = Promise.reject(new Error("https://updates.example.test/feed?token=secret-token"));
  await f.updates.check();
  assert.equal(f.updates.snapshot().status, "error");
  assert.equal(f.updates.snapshot().error?.includes("secret-token"), false);
});

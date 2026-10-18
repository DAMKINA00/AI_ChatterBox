import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findGemini, findGrok } from "./locate";

test("Gemini discovery checks the profile even with stale or empty LOCALAPPDATA", { skip: process.platform !== "win32" }, () => {
  const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
  const actual = join(homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
  const exists = mock.method(fs, "existsSync", (p) => p === actual);
  try {
    process.env.PATH = "";
    for (const local of ["C:\\missing-install", ""]) {
      process.env.LOCALAPPDATA = local;
      assert.equal(findGemini(), actual);
    }
  } finally {
    exists.mock.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Gemini discovery keeps explicit override precedence and retries after installation", () => {
  let installed = false;
  const custom = join(homedir(), "custom-agy.exe");
  const exists = mock.method(fs, "existsSync", (p) => installed && p === custom);
  try {
    assert.equal(findGemini(custom), null);
    installed = true;
    assert.equal(findGemini(custom), custom);
  } finally { exists.mock.restore(); }
});

test("Grok discovery finds official native installation and respects explicit override", () => {
  const saved = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME };
  const native = join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  const custom = join(homedir(), "custom-grok.exe");
  const exists = mock.method(fs, "existsSync", p => p === native || p === custom);
  try {
    process.env.PATH = ""; delete process.env.GROK_HOME;
    assert.equal(findGrok(), native);
    assert.equal(findGrok(custom), custom);
  } finally {
    exists.mock.restore();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

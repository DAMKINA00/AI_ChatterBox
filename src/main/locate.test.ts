import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findGrok } from "./locate";

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

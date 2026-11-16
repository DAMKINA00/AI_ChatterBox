import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCliInfo } from "./cli-status";
import type { CliInfo } from "../../../shared/types";

const ready: CliInfo[] = [
  { agent: "claude", path: "claude.exe", authStatus: "authenticated" },
  { agent: "codex", path: "codex.exe", authStatus: "authenticated" },
  { agent: "gemini", path: "agy.exe", authStatus: "required" },
  { agent: "grok", path: "grok.exe", authStatus: "authenticated" },
];

test("installation-only refresh retains each unchanged CLI login independently", () => {
  const update = ready.map(({ authStatus, ...info }) => info);
  assert.deepEqual(mergeCliInfo(ready, update), ready);
  const next = mergeCliInfo(ready, [{ agent: "gemini", path: "agy.exe", authStatus: "unknown" }]);
  assert.equal(next[2].authStatus, "unknown");
  for (const i of [0, 1, 3]) assert.deepEqual(next[i], ready[i]);
  assert.equal(ready[2].authStatus, "required");
});

test("removed or replaced CLI loses old authentication; partial checks keep other providers", () => {
  assert.equal(mergeCliInfo(ready, [{ agent: "gemini", path: null }])[2].authStatus, undefined);
  assert.equal(mergeCliInfo(ready, [{ agent: "gemini", path: "new-agy.exe" }])[2].authStatus, undefined);
  assert.equal(mergeCliInfo([], [ready[0]])[0], ready[0]);
});

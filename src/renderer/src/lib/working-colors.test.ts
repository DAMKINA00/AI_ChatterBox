import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatAgent, Consult } from "../../../shared/types";
import { activeWorkingKinds } from "./working-colors";

test("master colors follow only running active workers and fall back when alone", () => {
  const agents = [
    { key: "w1", kind: "gemini", status: "active" }, { key: "w2", kind: "gpt", status: "active" },
    { key: "w3", kind: "deepseek", status: "released" }, { key: "w4", kind: "claude", status: "active" },
    { key: "w5", kind: "gpt", status: "active" },
  ] as ChatAgent[];
  const consults = [
    { toRole: "w1", status: "running" }, { toRole: "w2", status: "running" }, { toRole: "w3", status: "running" },
    { toRole: "w4", status: "done" }, { toRole: "w5", status: "running" },
  ] as Consult[];
  assert.deepEqual(activeWorkingKinds(agents, consults, "claude"), ["gpt", "gemini"]);
  assert.deepEqual(activeWorkingKinds(agents, [], "grok"), ["grok"]);
  assert.deepEqual(activeWorkingKinds(undefined, undefined, "claude"), ["claude"]);
});

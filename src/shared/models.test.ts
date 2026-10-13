// Run: node --test src/shared/models.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestModels } from "./models.ts";

// What Claude Code 2.1.296 reports (control_request initialize → models), minus "default".
const CLAUDE = [
  "opus", "fable", "sonnet", "haiku",
  "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
].map((id) => ({ id, label: id }));

// What codex 0.162 reports (model/list).
const CODEX = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", isDefault: true },
  { id: "gpt-6-astra", label: "GPT-6-Astra" },
  { id: "gpt-6-sol", label: "GPT-6-Sol" },
  { id: "gpt-6-luna", label: "GPT-6-Luna" },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { id: "gpt-daybreak-blue-latest", label: "Daybreak Blue" },
];

const ids = (l: { id: string }[]) => l.map((m) => m.id);

test("Claude: only the family aliases", () => {
  assert.deepEqual(ids(latestModels("claude", CLAUDE)), ["opus", "fable", "sonnet", "haiku"]);
});

test("Claude: a selected pinned old version stays, marked old", () => {
  const l = latestModels("claude", CLAUDE, ["claude-opus-4-6"]);
  assert.deepEqual(ids(l), ["opus", "fable", "sonnet", "haiku", "claude-opus-4-6"]);
  assert.equal(l.at(-1)!.old, true);
});

test("Claude without aliases: newest version per family", () => {
  const l = latestModels("claude", CLAUDE.filter((m) => m.id.startsWith("claude-")));
  assert.deepEqual(ids(l).sort(), ["claude-fable-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-sonnet-5"]);
});

test("Codex: newest of each family (sol, astra, luna, terra) + unversioned", () => {
  assert.deepEqual(ids(latestModels("codex", CODEX)), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra", "gpt-daybreak-blue-latest"]);
});

test("Codex: hidden / upgradable models dropped, selected one kept", () => {
  const list = [...CODEX, { id: "gpt-7-astra", label: "GPT-7-Astra", hidden: true }, { id: "gpt-6.2-luna", label: "x", deprecated: true }];
  const l = latestModels("codex", list, ["gpt-5.6-sol"]);
  assert.ok(!ids(l).includes("gpt-7-astra") && !ids(l).includes("gpt-6.2-luna"));
  assert.ok(ids(l).includes("gpt-6-astra"));
  assert.equal(l.find((m) => m.id === "gpt-5.6-sol")?.old, true);
});

test("Free-text id not in the list stays visible", () => {
  const l = latestModels("codex", CODEX, ["my-custom-model"]);
  assert.equal(l.at(-1)!.id, "my-custom-model");
  assert.equal(l.at(-1)!.old, true);
});

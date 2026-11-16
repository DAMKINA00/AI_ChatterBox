import assert from "node:assert/strict";
import { test } from "node:test";
import { shortModelLabel } from "./model-label";

test("model labels remove redundant provider prefixes without changing other names", () => {
  assert.equal(shortModelLabel("gemini", "Gemini 4 Argon (Medium)"), "4 Argon");
  assert.equal(shortModelLabel("gemini", "Gemini 4 Hydrogen (XHigh)"), "4 Hydrogen");
  assert.equal(shortModelLabel("codex", "GPT-6.1-Sol"), "6.1-Sol");
  assert.equal(shortModelLabel("deepseek", "DeepSeek Chat"), "Chat");
  assert.equal(shortModelLabel("deepseek", "DeepSeek-Chat"), "Chat");
  assert.equal(shortModelLabel("grok", "Grok 4.7"), "Grok 4.7");
  assert.equal(shortModelLabel("claude", "Opus 5.5"), "Opus 5.5");
  assert.equal(shortModelLabel("gemini", "Orchestra Pro"), "Orchestra Pro");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CharacterAsk } from "../shared/usage-companion";
import type { AgentKind } from "../shared/types";
import type { ChatManager } from "./chats";
import { CharacterChat } from "./character-chat";

function question(character: CharacterAsk["character"], text: string): CharacterAsk {
  return { requestId: "a".repeat(32), character, text };
}

function connections(...agents: AgentKind[]) {
  return {
    cliInfo: () => agents.map(agent => ({ agent, path: "fixture" })),
    deepSeek: () => ({ status: () => ({ apiKeySet: false }) }),
  } as unknown as ChatManager;
}

test("private character conversations use only their own provider and follow-up history", async () => {
  const seen: unknown[] = [];
  const chat = new CharacterChat(connections(), async (agent, input) => {
    seen.push({ agent, input });
    return `${agent} reply`;
  });
  const longReply = await chat.ask(question("gpt", "first"));
  assert.deepEqual(longReply, { status: "answer", text: "codex reply" });
  await chat.ask(question("claude", "different character"));
  await chat.ask(question("gpt", "follow up"));
  assert.deepEqual(seen, [
    { agent: "codex", input: { question: "first", history: [] } },
    { agent: "claude", input: { question: "different character", history: [] } },
    { agent: "codex", input: { question: "follow up", history: [{ question: "first", answer: "codex reply" }] } },
  ]);
});

test("the master gets independent opinions from distinct providers before synthesizing", async () => {
  const seen: { agent: AgentKind; input: object }[] = [];
  const chat = new CharacterChat(connections("claude", "codex", "grok"), async (agent, input) => {
    seen.push({ agent, input });
    if (agent === "grok") throw new Error("disconnected");
    return "opinions" in input ? "cross-checked\nsecond line\nthird line\nfourth line" : `${agent} assessment`;
  });
  const answer = await chat.ask(question("orch", "compare"));
  assert.deepEqual(answer, { status: "answer", text: "cross-checked\nsecond line\nthird line\nfourth line" });
  assert.deepEqual(seen.slice(0, 3).map(call => call.agent), ["claude", "codex", "grok"]);
  assert.ok(seen.slice(0, 3).every(call => !("opinions" in call.input)));
  const synthesis = seen[3].input as { opinions: { answer: string }[] };
  assert.deepEqual(synthesis.opinions.map(opinion => opinion.answer), ["claude assessment", "codex assessment"]);
});

test("the master does not claim cross-checking when only one provider answers", async () => {
  let calls = 0;
  const chat = new CharacterChat(connections("claude", "codex"), async agent => {
    calls++;
    if (agent === "codex") throw new Error("disconnected");
    return "single opinion";
  });
  assert.equal((await chat.ask(question("orch", "check"))).status, "error");
  assert.equal(calls, 2);
});

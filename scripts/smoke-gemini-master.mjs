// Real Claude/Codex master -> subscription Gemini worker -> master synthesis.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dirname, "..");
const base = join(tmpdir(), `chatterbox-gemini-master-${Date.now()}`), cwd = join(base, "workspace");
mkdirSync(cwd, { recursive: true });
const publicSentence = "별빛 도서관은 아침 9시에 연다. 월요일은 쉰다.";
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const store = new Store(join(base, "chatterbox.db")), events = [], checks = [];
const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event(e) {
  events.push(e);
  if (["error", "turn_end"].includes(e.event.type)) console.log(e.role, e.event.type, e.event.message ?? e.event.ok);
  if (e.event.type === "approval_request") setImmediate(() => chats.approvals.answer(e.chatId, e.event.request.id, "deny"));
} }, base, join(root, "out/main/bridge-mcp.js"));
const orchestrator = new Orchestrator(chats);
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
try {
  await chats.start();
  for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) {
    const p = store.createProject(`Gemini ${provider} master test`, cwd, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : "codex:gpt-6.1-sol", reviewGate: false, approvalMode: "user" });
    const c = store.createChat(p.id, "Gemini delegation");
    const from = events.length;
    await chats.send(c.id, `실제 글쓰기 위임 통합 검사입니다. 앱 브리지로 제미나이 작업자 한 명을 만들고 반드시 kind=writing으로 맡기세요. 공개 문장 "${publicSentence}"을 자연스럽게 다듬은 뒤, 그 내용에 맞는 사서의 대사 한 문장을 작성하게 하세요. 파일·셸·코드 분석·기술 리뷰는 필요 없습니다. 작업자 결과가 오면 마스터가 다듬은 문장과 사서 대사를 짧게 취합해서 보고하고 작업자를 release하세요.`, []);
    let end;
    const until = Date.now() + 240_000;
    while (Date.now() < until && !end) {
      end = events.slice(from).find((e) => e.role === "orch" && e.event.type === "turn_end");
      if (!end) await new Promise((r) => setTimeout(r, 300));
    }
    if (!end) { await chats.stop(c.id); throw new Error(`${provider} master timed out`); }
    const agents = store.listAgents(c.id), gemini = agents.find((a) => a.kind === "gemini");
    const messages = events.slice(from).filter((e) => e.event.type === "text");
    const consults = store.listConsults(c.id), writing = consults.find((consult) => consult.kind === "writing");
    check(`${provider} master finished`, end.event.ok);
    check(`${provider} created Gemini only`, gemini && agents.length === 1);
    check(`${provider} consult kind is writing`, writing?.kind === "writing" && writing.status === "done");
    check(`${provider} worker returned writing`, gemini && messages.some((e) => e.role === gemini.key && /별빛|도서관|사서/.test(e.event.text)));
    check(`${provider} master synthesized writing`, messages.some((e) => e.role === "orch" && /별빛|도서관|사서/.test(e.event.text)));
    check(`${provider} saved native Gemini session`, gemini?.sessionId);
    check(`${provider} released worker`, gemini?.status === "released");
    check(`${provider} worker usage recorded`, gemini && events.slice(from).some((e) => e.role === gemini.key && e.event.type === "agent_usage"));
  }
} catch (e) { check(String(e), false); }
finally {
  await orchestrator.judge.dispose(); await chats.dispose(); store.close();
  writeFileSync(join(base, "results.json"), JSON.stringify({ checks, events }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

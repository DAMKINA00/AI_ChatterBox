// Actual master-driven delegation (no programmatic calls to spawn/ask).
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
const base = join(root, ".scratch", `master-routing-${Date.now()}`);
const work = join(base, "workspace");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "flow.ts"), "export function nextState(ready: boolean, fault: boolean) { if (fault) return 'STOP'; return ready ? 'RUN' : 'WAIT'; }\n");
writeFileSync(join(work, "AGENTS.md"), "# Test workspace\nUse the AI_ChatterBox bridge for delegated work. Do not edit flow.ts. Keep answers short.\n");
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const store = new Store(join(base, "chatterbox.db"));
const events = [], checks = [];
let chats;
chats = new ChatManager(store, { agents() {}, chat(c) { console.log("CHAT", c.id, c.status); }, consult(c) { console.log("CONSULT", c.id, c.toRole, c.status, c.reason); }, usage() {}, event(e) {
  events.push(e);
  if (["dispatch", "error", "turn_end", "image_generation"].includes(e.event.type)) console.log(e.chatId, e.role, JSON.stringify(e.event).slice(0,450));
  if (e.event.type === "approval_request") setImmediate(() => chats.answerApproval(e.chatId, e.event.request.id, "once"));
} }, base, join(root, "out/main/bridge-mcp.js"));
const o = new Orchestrator(chats);
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
const providers = (process.env.CBX_PROVIDERS ?? "codex,claude").split(",");
const scenarios = (process.env.CBX_SCENARIOS ?? "analysis,image,mixed").split(",");
try {
 await chats.start();
 for (const provider of providers) for (const scenario of scenarios) {
  const model = process.env.CBX_GPT_MODEL ?? "gpt-6.1-sol";
  const p = store.createProject(`${provider}-${scenario}`, work, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : `codex:${model}`, claudeModel: "sonnet", codexModel: model, reviewGate: false, approvalMode: "user", maxMinutes: 6 });
  const c = store.createChat(p.id, scenario);
  const prompt = scenario === "analysis" ? "flow.ts의 상태 전이를 분석하고 STOP/RUN/WAIT가 언제 나오는지 표로 정리해줘. 파일은 고치지 마."
    : scenario === "image" ? "이미지 생성 도구로 작은 파란 원 캐릭터 PNG 한 장을 만들고 결과 파일 링크를 알려줘. 코드로 그리지 말고 실제 이미지 생성을 사용해."
    : "flow.ts의 동작을 분석하고, 별도로 이미지 생성 도구로 귀여운 초록 사각형 캐릭터 PNG 한 장을 만들어줘. 마지막에 분석 요약과 이미지 링크를 함께 정리해줘. 서로 독립적인 두 작업이야. 소스는 고치지 마.";
  await chats.send(c.id, prompt, []);
  const until = Date.now() + 400000;
  while (["working", "approval"].includes(store.chat(c.id).status) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  if (["working", "approval"].includes(store.chat(c.id).status)) await o.stop(c.id);
  const es = events.filter((e) => e.chatId === c.id), cs = store.listConsults(c.id), agents = store.listAgents(c.id);
  const tag = `${provider}/${scenario}`;
  check(`${tag} completed`, store.chat(c.id).status === "done");
  check(`${tag} master recorded delegation`, es.some((e) => e.event.type === "dispatch" && e.event.mode === "delegated"));
  check(`${tag} real app workers answered with reason and instruction id`, cs.length > 0 && cs.every((x) => x.status === "done" && x.reason && x.instructionId && x.responseSummary));
  check(`${tag} worker messages and final master synthesis`, es.some((e) => e.role?.startsWith("w") && e.event.type === "text") && es.findLast((e) => e.event.type === "text")?.role === "orch");
  check(`${tag} no invisible native delegation`, !es.some((e) => e.event.type === "error" && e.event.message.includes("내부 작업자")));
  check(`${tag} worker token metrics`, es.some((e) => e.role?.startsWith("w") && e.event.type === "agent_usage" && e.event.metrics.outputTokens > 0));
  if (scenario !== "image") check(`${tag} Claude analyzes source`, agents.some((a) => a.kind === "claude" && cs.some((x) => x.toRole === a.key && x.status === "done")));
  if (scenario !== "analysis") check(`${tag} GPT generates persisted image`, es.some((e) => e.event.type === "image_generation" && e.event.status === "done" && e.event.attachment && existsSync(e.event.attachment.path)));
  writeFileSync(join(base, "results.json"), JSON.stringify({ base, checks }, null, 2));
  writeFileSync(join(base, "events.json"), JSON.stringify(events, null, 2));
 }
} catch (e) { check(String(e), false); console.error(e); }
finally { await o.judge.dispose(); await chats.dispose(); store.close(); writeFileSync(join(base, "results.json"), JSON.stringify({ base, checks }, null, 2)); console.log("Evidence:", base); }
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

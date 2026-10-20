// Real xhigh Claude/Codex master -> automatic effort on each worker family -> synthesis.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dirname, "..");
const base = join(tmpdir(), `chatterbox-effort-smoke-${Date.now()}`), cwd = join(base, "workspace");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "counts.txt"), "alpha=17\nbeta=25\n");
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
    const p = store.createProject(`Effort ${provider} master test`, cwd, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : "codex:gpt-6.1-sol", orchestratorEffort: "xhigh", claudeModel: "sonnet", codexModel: "gpt-6.1-sol", reviewGate: false, approvalMode: "user" });
    const c = store.createChat(p.id, "Automatic effort delegation");
    const from = events.length;
    await chats.send(c.id, "추론 설정 통합 검사입니다. 이번 검사만 클로드·지피티·제미나이 각 한 명을 앱 브리지로 만들고 ask_parallel로 독립적인 의견 작업을 맡기세요. 각 작업자는 counts.txt의 두 수 alpha와 beta를 읽고 더해 총합을 보고하면 됩니다. 파일 확인을 위한 읽기 전용 셸 명령은 허용합니다. 이 작업에 적절한 추론 수준을 당신이 판단해 각 ask의 effort와 reason에 기록하세요. 이미지·파일 수정·추가 에이전트는 필요 없습니다. 세 작업자의 응답이 모두 돌아오면 담당별 결과와 총합을 아주 짧게 취합하고 모두 해제하세요.", []);
    let end;
    const until = Date.now() + 240_000;
    while (Date.now() < until && !end) {
      end = events.slice(from).find((e) => e.role === "orch" && e.event.type === "turn_end");
      if (!end) await new Promise((r) => setTimeout(r, 300));
    }
    if (!end) { await chats.stop(c.id); throw new Error(`${provider} master timed out`); }
    const agents = store.listAgents(c.id), consults = store.listConsults(c.id);
    const messages = events.slice(from).filter((e) => e.event.type === "text");
    check(`${provider} master finished`, end.event.ok);
    check(`${provider} master xhigh reached CLI`, events.slice(from).some((e) => e.role === "orch" && e.event.type === "agent_usage" && e.event.metrics.reasoningEffort === "xhigh"));
    check(`${provider} created three worker families`, new Set(agents.map((a) => a.kind)).size === 3 && agents.length === 3);
    check(`${provider} master synthesized 42`, messages.some((e) => e.role === "orch" && /42/.test(e.event.text)));
    for (const kind of ["claude", "gpt", "gemini"]) {
      const worker = agents.find((a) => a.kind === kind), record = consults.findLast((x) => x.toRole === worker?.key);
      check(`${provider}/${kind} complete answer and persisted effort`, record?.status === "done" && /42/.test(record.responseSummary ?? "") && ["medium", "high", "xhigh"].includes(record.requestedEffort) && !!record.reason);
      check(`${provider}/${kind} CLI reports assigned effort`, worker && events.slice(from).some((e) => e.role === worker.key && e.event.type === "agent_usage" && e.event.metrics.reasoningEffort === record?.effort));
      check(`${provider}/${kind} saved session and released`, !!worker?.sessionId && worker.status === "released");
    }
  }
} catch (e) { check(String(e), false); }
finally {
  await orchestrator.judge.dispose(); await chats.dispose(); store.close();
  writeFileSync(join(base, "results.json"), JSON.stringify({ checks, events }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

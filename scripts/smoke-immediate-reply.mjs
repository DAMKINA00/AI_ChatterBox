// Real Claude/Codex masters, controlled worker completion. Consumes master CLI usage only.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const base = join(tmpdir(), `chatterbox-immediate-${Date.now()}`), cwd = join(base, "workspace");
mkdirSync(cwd, { recursive: true });
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const store = new Store(join(base, "test.db")), events = [], checks = [], runs = new Map();
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let chats;
chats = new ChatManager(store, { agents() {}, chat() {}, usage() {}, consult(c) {
  const run = runs.get(c.chatId);
  if (run && c.status === "running" && !run.injected) {
    run.injected = true;
    run.injection = delay(1200).then(async () => {
      run.sentAt = Date.now();
      await chats.send(c.chatId, "750k 설정은 클로드에만 적용하는 게 맞지? 작업 결과를 기다리지 말고 지금 답해줘. 답변에 즉시답변확인 이라는 문구를 넣어줘. 그리고 최종 취합 제목을 '합산 결과'로 바꾸고 끝에는 최종확인을 적어줘. 기존 작업자를 유지해.", [], "now");
    });
  }
}, event(e) {
  events.push(e);
  const run = runs.get(e.chatId);
  if (run?.sentAt && !run.replyAt && e.role === "orch" && e.event.type === "text" && e.event.text.includes("즉시답변확인")) {
    run.replyAt = Date.now();
    run.repliedWhileRunning = store.listConsults(e.chatId).some((c) => c.status === "running");
    run.modeAtReply = engine.instructions.get(e.chatId)?.mode;
    setTimeout(() => run.finish?.(), 250);
  }
  if (["notice", "error", "turn_end"].includes(e.event.type)) console.log(e.role, e.event.type, e.event.text ?? e.event.message ?? e.event.ok);
  if (e.event.type === "approval_request") setImmediate(() => chats.approvals.answer(e.chatId, e.event.request.id, "deny"));
} }, base, join(root, "out/main/bridge-mcp.js"));
const engine = new Orchestrator(chats);
const nativeDriver = chats.driver.bind(chats);
chats.driver = async (chatId, role, effort) => {
  if (role === "orch") return nativeDriver(chatId, role, effort);
  const run = runs.get(chatId);
  return { agent: "claude", running: true, async send() {
    run.workerSends++;
    run.finish = () => {
      if (run.finishedAt) return;
      run.finishedAt = Date.now();
      for (const event of [{ type: "text", text: "alpha=17, beta=25, 합계 42. 파일 변경 없음." }, { type: "turn_end", ok: true }]) {
        chats.emit(chatId, chats.route(chatId, role), role, event);
        chats.onDriverEvent?.(chatId, role, event);
      }
    };
  }, async stop() {}, async dispose() {} };
};

try {
  await chats.start();
  for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) {
    const p = store.createProject(`Immediate reply ${provider}`, cwd, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : "codex:gpt-6.1-sol", claudeModel: "sonnet", reviewGate: false, approvalMode: "user" });
    const c = store.createChat(p.id, "Immediate reply test"), from = events.length;
    const run = { workerSends: 0 }; runs.set(c.id, run);
    await chats.send(c.id, "협업 검증: 이번 대화에서 '750k 설정'은 Claude 전용이라는 사실이 이미 확인되어 있습니다. 실제 설정이나 파일을 검사·변경하지 마세요. 앱 브리지로 클로드 작업자 한 명에게 alpha=17, beta=25를 합산하도록 opinion, effort=medium으로 맡기고 취합하세요. 계산 자체보다 위임 경로를 검사하는 작업이므로 반드시 delegated로 진행하세요. 작업자가 일하는 동안 제가 질문과 수정 요청을 보낼 예정입니다. 기존 작업자를 유지하고 사용자 질문에는 먼저 답변하세요. 셸·파일 도구는 필요 없습니다.", []);
    const until = Date.now() + 180_000;
    while (Date.now() < until && !events.slice(from).some((e) => e.role === "orch" && e.event.type === "turn_end")) {
      if (run.sentAt && !run.replyAt && Date.now() - run.sentAt > 75_000) { run.finish?.(); break; }
      await delay(300);
    }
    await run.injection;
    const current = events.slice(from), end = current.findLast((e) => e.role === "orch" && e.event.type === "turn_end");
    const masterText = current.filter((e) => e.role === "orch" && e.event.type === "text").map((e) => e.event.text).join("\n");
    check(`${provider}: immediate reply before worker completion`, run.replyAt && run.repliedWhileRunning && run.replyAt < run.finishedAt);
    check(`${provider}: original delegated route preserved`, run.modeAtReply === "delegated");
    check(`${provider}: question answered and requested final title kept`, /클로드|Claude/.test(masterText) && /합산 결과/.test(masterText) && /최종확인/.test(masterText));
    check(`${provider}: final successful synthesis after result`, end?.event.ok && end.at >= run.finishedAt && /42/.test(masterText));
    check(`${provider}: one worker and one completed consultation`, run.workerSends === 1 && store.listAgents(c.id).length === 1 && store.listConsults(c.id).length === 1 && store.listConsults(c.id)[0].status === "done");
    check(`${provider}: no direct-route downgrade rejection`, !current.some((e) => e.event.type === "tool_result" && JSON.stringify(e.event).includes("직접 처리로 바꿀 수 없습니다")));
    check(`${provider}: immediate input persisted`, store.events(c.id).some((e) => e.event.type === "user" && e.event.delivery === "now"));
    console.log(`${provider}: reply latency ${run.replyAt ? run.replyAt - run.sentAt : "missing"}ms`);
    if (!end) await engine.stop(c.id);
  }
} finally {
  await engine.judge.dispose(); await chats.dispose(); store.close();
  writeFileSync(join(base, "results.json"), JSON.stringify({ checks, runs: [...runs], events }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

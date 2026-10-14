// Live, isolated master steering while a real app worker continues. Consumes CLI usage.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dirname, "..");
const base = join(tmpdir(), `chatterbox-steering-${Date.now()}`), cwd = join(base, "workspace");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "counts.txt"), "alpha=17\nbeta=25\n");
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const store = new Store(join(base, "test.db")), events = [], checks = [], injections = new Map();
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
const chats = new ChatManager(store, { agents() {}, chat() {}, usage() {}, consult(c) {
  if (c.status === "running" && !injections.has(c.chatId)) {
    const p = new Promise((resolve) => setTimeout(resolve, 1200)).then(() => chats.send(c.chatId, "즉시 추가 지시입니다. 기존 작업자를 중지하거나 새로 만들지 말고 응답을 기다려 취합하세요. 최종 답변 마지막에 STEER_CONFIRMED를 반드시 적으세요.", [], "now"));
    injections.set(c.chatId, p);
    p.catch((e) => console.log("injection error", String(e)));
  }
}, event(e) {
  events.push(e);
  if (["notice", "error", "turn_end"].includes(e.event.type)) console.log(e.role, e.event.type, e.event.text ?? e.event.message ?? e.event.ok);
  if (e.event.type === "approval_request") setImmediate(() => chats.approvals.answer(e.chatId, e.event.request.id, "deny"));
} }, base, join(root, "out/main/bridge-mcp.js"));
const engine = new Orchestrator(chats);
try {
  await chats.start();
  for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) {
    const p = store.createProject(`Steer ${provider}`, cwd, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : "codex:gpt-6.1-sol", claudeModel: "sonnet", reviewGate: false, approvalMode: "user" });
    const c = store.createChat(p.id, "Steering test"), from = events.length;
    await chats.send(c.id, "협업 통합 검사입니다. 앱 브리지로 클로드 작업자 한 명을 생성하고 opinion, effort=medium으로 counts.txt의 alpha와 beta를 읽어 합산한 답을 받으세요. 필요한 읽기 전용 셸은 허용하고 파일은 수정하지 마세요. 작업자가 일하는 동안 제가 추가 지시를 보낼 예정이니 작업자를 유지하며 응답을 취합하고 마지막에 해제하세요.", []);
    const until = Date.now() + 240_000;
    while (Date.now() < until && !events.slice(from).some((e) => e.role === "orch" && e.event.type === "turn_end")) await new Promise((r) => setTimeout(r, 300));
    await injections.get(c.id);
    const current = events.slice(from), end = current.findLast((e) => e.role === "orch" && e.event.type === "turn_end");
    check(`${provider}: final completion`, end?.event.ok);
    check(`${provider}: immediate native delivery acknowledged`, current.some((e) => e.event.type === "notice" && e.event.text.startsWith("마스터에게 즉시 전달했습니다")));
    check(`${provider}: original worker completed without interruption`, store.listConsults(c.id).length === 1 && store.listConsults(c.id).every((x) => x.status === "done" && /42/.test(x.responseSummary ?? "")));
    check(`${provider}: master incorporated immediate input`, current.some((e) => e.role === "orch" && e.event.type === "text" && e.event.text.includes("STEER_CONFIRMED")));
    check(`${provider}: no worker duplication`, store.listAgents(c.id).length === 1);
    check(`${provider}: persisted delivery mode`, store.events(c.id).some((e) => e.event.type === "user" && e.event.delivery === "now"));
    if (!end) await engine.stop(c.id);
  }
} finally {
  await engine.judge.dispose(); await chats.dispose(); store.close();
  writeFileSync(join(base, "results.json"), JSON.stringify({ checks, events }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

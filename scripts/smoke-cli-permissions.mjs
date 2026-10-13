// Real authenticated CLIs. All edits and app data stay in a newly created scratch directory.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
const base = join(root, ".scratch", `cli-permissions-${Date.now()}`);
const work = join(base, "workspace");
mkdirSync(work, { recursive: true });
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const db = new Store(join(base, "chatterbox.db"));
const events = [], checks = [];
let chats;
const sink = { agents() {}, chat() {}, consult() {}, usage() {}, event(e) {
  events.push(e);
  if (["error", "approval_request", "approval_auto", "turn_end"].includes(e.event.type))
    console.log(e.role, e.event.type, e.event.message ?? e.event.decision ?? e.event.ok ?? e.event.request.title);
  if (e.event.type === "approval_request") setImmediate(() => chats.approvals.answer(e.chatId, e.event.request.id, "once"));
} };
chats = new ChatManager(db, sink, base, join(root, "out", "main", "bridge-mcp.js"));
const o = new Orchestrator(chats);
const server = chats.codex();
const request = server.request.bind(server);
server.request = async (method, params) => {
  const result = await request(method, params);
  if (method === "thread/start") console.log("Codex policy:", JSON.stringify({ approval: result.approvalPolicy, reviewer: result.approvalsReviewer, sandbox: result.sandbox }));
  return result;
};
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
async function completed(chatId, from) {
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const end = events.slice(from).find((e) => e.chatId === chatId && e.role === "orch" && e.event.type === "turn_end");
    if (end) return end.event.ok;
    await new Promise((r) => setTimeout(r, 250));
  }
  await chats.stop(chatId);
  throw new Error("CLI master smoke timed out");
}
try {
  await chats.start();
  for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex"]) {
    const mode = process.env.CBX_SMOKE_APPROVAL ?? "user";
    const p = db.createProject(`smoke-${provider}`, work, { ...DEFAULT_SETTINGS, orchestratorModel: provider === "claude" ? "claude:sonnet" : "codex:gpt-6.1-sol", claudeModel: "sonnet", codexModel: "gpt-6.1-sol", reviewGate: false, approvalMode: mode });
    const c = db.createChat(p.id, provider);
    const file = `${provider}-master.txt`;
    const patchHint = process.env.CBX_SMOKE_PATCH ? "파일 생성·수정은 반드시 기본 파일 수정 도구(Claude Write/Edit, Codex apply_patch)를 사용하세요. 셸로 파일을 쓰지 마세요. " : "";
    const from = events.length;
    await chats.send(c.id, patchHint + `격리 테스트입니다. 작업자를 만들지 말고 직접 ${file} 파일을 생성해서 FIRST를 쓰고, SECOND로 수정하세요. 그 다음 셸 명령으로 파일을 읽어 SECOND인지 확인하세요. set_expression(happy) 후 완료라고 짧게 답하세요. 다른 파일은 고치지 마세요.`, []);
    check(`${provider} master turn completes`, await completed(c.id, from));
    check(`${provider} master file created and edited`, existsSync(join(work, file)) && readFileSync(join(work, file), "utf8").trim() === "SECOND");
    const master = events.slice(from).filter((e) => e.chatId === c.id && e.role === "orch");
    check(`${provider} master action went through ${mode} approval`, master.some((e) => e.event.type === (mode === "user" ? "approval_request" : "approval_auto")));
    check(`${provider} master expression bridge event`, master.some((e) => e.event.type === "expression" && e.event.expression === "happy"));
    // A new user instruction authorizes the next phase; the prior phase explicitly prohibited delegation.
    const instruction = o.instructions.get(c.id);
    if (instruction) instruction.text = `이제 ${provider} 작업자를 만들어 ${provider}-worker.txt 파일 생성·수정·내용 확인을 맡기세요. 다른 파일은 변경하지 마세요.`;
    await o.call(c.id, "orch", "route_request", { mode: "delegated", reason: `${provider} 작업자에게 파일 수정 작업을 배정합니다.` });
    await o.call(c.id, "orch", "spawn", { kind: provider === "claude" ? "claude" : "gpt", job: "권한 테스트" });
    const w = db.listAgents(c.id)[0];
    const workerFile = `${provider}-worker.txt`;
    const start = events.length;
    let timer;
    const result = await Promise.race([
      o.call(c.id, "orch", "ask", { to: w.nickname, kind: "implement", reason: `${provider} 작업자의 구현 작업과 적합한 승인 범위를 확인합니다.`, scope: [workerFile], message: patchHint + `${workerFile} 파일에 FIRST를 생성한 뒤 SECOND로 수정하고 셸 명령으로 내용을 읽어 확인하세요. set_expression(confident) 후 짧게 완료를 보고하세요. 다른 파일은 수정하지 마세요.` }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker timeout")), 240_000); }),
    ]).finally(() => clearTimeout(timer));
    check(`${provider} worker turn completes`, !result.isError);
    check(`${provider} worker file created and edited`, existsSync(join(work, workerFile)) && readFileSync(join(work, workerFile), "utf8").trim() === "SECOND");
    check(`${provider} worker action went through ${mode} approval`, events.slice(start).some((e) => e.event.type === (mode === "user" ? "approval_request" : "approval_auto") && e.role === w.key));
    check(`${provider} worker expression bridge event`, events.slice(start).some((e) => e.event.type === "expression" && e.role === w.key));
  }
} catch (error) {
  checks.push({ name: String(error), ok: false });
  console.error(error);
} finally {
  await o.judge.dispose();
  await chats.dispose();
  db.close();
  writeFileSync(join(base, "results.json"), JSON.stringify({ base, checks }, null, 2));
  writeFileSync(join(base, "events.json"), JSON.stringify(events, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

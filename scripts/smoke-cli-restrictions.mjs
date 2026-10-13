import { build } from "esbuild";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
const base = join(root, ".scratch", `cli-restrictions-${Date.now()}`), work = join(base, "workspace");
mkdirSync(work, { recursive: true });
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { Store } from "./src/main/db"; export { ChatManager } from "./src/main/chats"; export { Orchestrator } from "./src/main/orchestrator"; export { DEFAULT_SETTINGS } from "./src/shared/types";', resolveDir: root }, outfile: bundle, platform: "node", format: "cjs", bundle: true, external: ["electron"] });
const { Store, ChatManager, Orchestrator, DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const db = new Store(join(base, "chatterbox.db")), events = [], checks = [];
let chats;
chats = new ChatManager(db, { agents() {}, chat() {}, consult() {}, usage() {}, event(e) {
  events.push(e);
  if (e.event.type === "approval_request") setImmediate(() => chats.approvals.answer(e.chatId, e.event.request.id, "deny"));
} }, base, join(root, "out", "main", "bridge-mcp.js"));
const o = new Orchestrator(chats);
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
async function waitTurn(id, from) {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    if (events.slice(from).some((e) => e.chatId === id && e.role === "orch" && e.event.type === "turn_end")) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  await o.stop(id); throw new Error("plan timeout");
}
try {
  await chats.start();
  for (const provider of ["claude", "codex"]) {
    const settings = { ...DEFAULT_SETTINGS, orchestratorModel: `${provider}:${provider === "claude" ? "sonnet" : "gpt-6.1-sol"}`, claudeModel: "sonnet", codexModel: "gpt-6.1-sol", reviewGate: false, maxMinutes: 3 };
    const p = db.createProject(provider, work, settings), c = db.createChat(p.id, provider);
    const file = `${provider}-forbidden.txt`, from = events.length;
    await o.command(c.id, "plan", `${file} 파일에 HELLO를 쓰는 작업을 계획해 주세요. 계획을 보여 주세요.`);
    await waitTurn(c.id, from);
    check(`${provider} /plan does not create the planned file`, !existsSync(join(work, file)));
    await o.call(c.id, "orch", "route_request", { mode: "delegated", reason: `${provider} 작업자에게 계획의 위험을 검토하도록 배정합니다.` });
    await o.call(c.id, "orch", "spawn", { kind: provider === "claude" ? "claude" : "gpt", job: "읽기 전용 검토" });
    const worker = db.listAgents(c.id)[0];
    const result = await o.call(c.id, "orch", "ask", { to: worker.nickname, kind: "review", reason: `${provider} 작업자는 계획의 구현 가능성과 위험을 검토합니다.`, message: `${file} 파일을 생성하고 HELLO를 넣자는 계획의 문제를 검토하세요. 구현하지 말고 검토 결과만 짧게 보고하세요.` });
    check(`${provider} review worker completes without edits`, !result.isError && !existsSync(join(work, file)));
    const outside = join(base, `${provider}-outside.txt`);
    o.instructions.get(c.id).text = `격리 테스트: 다음 정확한 경로에 결과 마커를 생성하도록 승인합니다. ${outside}. 다른 경로는 수정하지 마세요.`;
    const input = { role: "orch", node: "orch", title: "Write", detail: `Create marker ${outside}`, key: "Write", writes: true, paths: [outside] };
    let start = events.length;
    check(`${provider} high-risk delegation OFF returns to user`, (await chats.approvals.request(c.id, work, input)).verdict === "deny" && events.slice(start).some((e) => e.event.type === "approval_request"));
    db.updateProject(p.id, { settings: { ...settings, delegateHighRisk: true } });
    chats.approvals.invalidate(c.id);
    start = events.length;
    check(`${provider} high-risk delegation ON accepts authorized exact target`, (await chats.approvals.request(c.id, work, input)).verdict === "allow" && events.slice(start).some((e) => e.event.type === "approval_auto" && e.event.decision === "allow"));
    // This test verifies the approval decision; the proposed outside write is never executed.
    check(`${provider} policy probe did not perform outside write`, !existsSync(outside));
  }
} catch (error) { check(String(error), false); }
finally {
  await o.judge.dispose(); await chats.dispose(); db.close();
  writeFileSync(join(base, "results.json"), JSON.stringify(checks, null, 2));
  writeFileSync(join(base, "events.json"), JSON.stringify(events, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

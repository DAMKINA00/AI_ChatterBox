// Real native lifecycle test. Only conversations created by this script are modified.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
const base = join(root, ".scratch", `native-sessions-${Date.now()}`);
mkdirSync(base, { recursive: true });
const bundle = join(base, "harness.cjs");
await build({ stdin: { contents: 'export { CodexServer, CodexDriver } from "./src/main/drivers/codex"; export { ClaudeDriver } from "./src/main/drivers/claude"; export { LocalBridge } from "./src/main/local-bridge"; export { findClaude, findCodex } from "./src/main/locate";', resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "cjs" });
const { CodexServer, CodexDriver, ClaudeDriver, LocalBridge, findClaude, findCodex } = createRequire(import.meta.url)(bundle);
const server = new CodexServer(findCodex()), bridge = new LocalBridge();
const checks = [], ids = {}, events = [];
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); if (!ok) throw new Error(name); };
const transcript = (area, id) => {
  const folder = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), area);
  return existsSync(folder) && readdirSync(folder).some((p) => existsSync(join(folder, p, `${id}.jsonl`)));
};
let driver, finish;
const host = (provider) => ({ nativeId(id) { ids[provider] = id; }, approve: async () => ({ verdict: "deny" }), emit(event) { events.push({ provider, event }); if (["error", "notice"].includes(event.type)) console.log(provider, event); if (event.type === "turn_end") finish?.(event); } });
const turn = async (text) => {
  let timer;
  const ended = new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(new Error("native turn timed out")), 180000); });
  try { await driver.send({ text, attachments: [], noWrites: true }); const e = await ended; check("native turn completed", e.ok); }
  finally { clearTimeout(timer); finish = undefined; }
};
try {
  await bridge.start();
  for (const provider of (process.env.CBX_PROVIDERS || "codex,claude").split(",")) {
    const options = { cwd: base, nativeId: null, exePath: provider === "codex" ? findCodex() : findClaude(), model: provider === "codex" ? "gpt-6-sol" : "sonnet", readOnly: true,
      workerSession: { projectRoot: join(process.env.APPDATA || base, "AI_ChatterBox", "AI AGENT"), name: `[AI AGENT] lifecycle-check-${Date.now()} ${provider}` } };
    const make = () => provider === "codex" ? new CodexDriver({ ...options, nativeId: ids[provider] ?? null }, server, host(provider))
      : new ClaudeDriver({ ...options, nativeId: ids[provider] ?? null }, { bridge, bridgeScript: join(root, "out/main/bridge-mcp.js"), tmpDir: base, tools: [], strictMcp: true }, host(provider));
    driver = make();
    await turn("보관·복원 테스트입니다. 기억할 문자열은 TURQUOISE-381입니다. 도구 없이 '확인'만 답하세요.");
    const nativeId = ids[provider];
    check(`${provider} native id captured`, !!nativeId);
    if (provider === "codex") {
      const r = await server.request("thread/read", { threadId: nativeId });
      const p = await server.request("project/list", { limit: 100 });
      check("Codex native AI AGENT project with original cwd", p.data.some((x) => x.name === "AI AGENT" && x.id === r.thread.projectId) && resolve(r.thread.cwd) === base);
    }
    await driver.archive();
    if (provider === "codex") {
      const a = await server.request("thread/list", { archived: true, cwd: base, limit: 100 });
      const live = await server.request("thread/list", { archived: false, cwd: base, limit: 100 });
      check("Codex archived and absent from active list", a.data.some((x) => x.id === nativeId) && !live.data.some((x) => x.id === nativeId));
    } else check("Claude archived and absent from active transcripts", transcript("chatterbox-archived-sessions", nativeId) && !transcript("projects", nativeId));
    await driver.dispose();
    driver = make(); // simulate new driver after app restart
    await turn("이 대화에서 내가 처음 기억하라고 한 문자열만 답하세요.");
    const answer = events.findLast((e) => e.provider === provider && e.event.type === "text")?.event.text || "";
    check(`${provider} restored same id and remembered history`, ids[provider] === nativeId && answer.includes("TURQUOISE-381"));
    await driver.archive();
    await driver.dispose();
  }
} catch (error) { checks.push({ name: String(error), ok: false }); console.error(error); }
finally {
  await driver?.stop(); await driver?.archive().catch(() => {}); await driver?.dispose();
  await server.dispose(); await bridge.stop();
  writeFileSync(join(base, "results.json"), JSON.stringify({ checks, ids }, null, 2));
  writeFileSync(join(base, "events.json"), JSON.stringify(events, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((x) => x.ok) ? 0 : 1;

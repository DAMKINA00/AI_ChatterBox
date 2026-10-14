// Real subscription-authenticated Antigravity, disposable workspace and app bridge only.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dirname, "..");
const base = join(tmpdir(), `chatterbox-gemini-smoke-${Date.now()}`);
const cwd = join(base, "workspace");
mkdirSync(cwd, { recursive: true });
const bundle = join(base, "driver.cjs");
await build({ stdin: { contents: 'export { GeminiDriver } from "./src/main/drivers/gemini"; export { LocalBridge, bridgeServerConfig, textResult } from "./src/main/local-bridge"; export { findGemini } from "./src/main/locate";', resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "cjs" });
const { GeminiDriver, LocalBridge, bridgeServerConfig, textResult, findGemini } = createRequire(import.meta.url)(bundle);
const bridge = new LocalBridge();
await bridge.start();
const events = [], approvals = [], hooks = [], checks = [], diagnostics = [];
let nativeId, expression = false, denied = false, driver;
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
const reg = bridge.register({ tools: [{ name: "set_expression", description: "Set the worker facial expression.", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }], call: async () => { expression = true; return textResult("표정 적용 완료"); } });
const opts = { cwd, exePath: findGemini(), model: process.env.CBX_GEMINI_MODEL || undefined, nativeId: null, instructions: "격리된 ChatterBox 검증 작업입니다. 본래 파일 경로만 다루고 네이티브 하위 에이전트를 만들지 마세요. 요청이 거부되면 우회하지 말고 보고하세요." };
function create(id = null) {
  const d = new GeminiDriver({ ...opts, nativeId: id, tokenBaseline: id ? events.findLast((e) => e.type === "agent_usage")?.metrics.total : undefined }, { bridge, tmpDir: base, sessionKey: "test-worker", hookScript: join(root, "out/main/antigravity-hook.js"), mcpServers: () => ({ chatterbox_bridge: bridgeServerConfig(join(root, "out/main/bridge-mcp.js"), reg.url) }) }, {
    nativeId: (id) => { nativeId = id; },
    emit: (e) => { events.push(e); if (e.type !== "text_delta") console.log(e.type, e.name ?? e.message ?? e.ok ?? ""); },
    approve: async (input) => {
      approvals.push(input);
      const forbidden = JSON.stringify(input).includes("denied.txt");
      if (forbidden) denied = true;
      // Only the named scratch file and read commands are approved in this smoke.
      const allowed = !forbidden && (input.readOnly || input.diffs?.every((d) => resolve(d.path) === join(cwd, "allowed.txt")) || /^Get-Content\b/i.test(input.command ?? ""));
      console.log("approval", input.title, allowed ? "allow" : "deny");
      return { verdict: allowed ? "allow" : "deny", reason: allowed ? "isolated smoke" : "smoke intentionally denied; do not retry" };
    },
  });
  const hook = d.hook.bind(d);
  d.hook = async (phase, payload) => { hooks.push({ phase, tool: payload?.toolCall?.name }); console.log("hook", phase, payload?.toolCall?.name ?? ""); return hook(phase, payload); };
  return d;
}
async function turn(text, noWrites = false) {
  const start = events.length;
  await driver.send({ text, noWrites, attachments: [] });
  driver.child?.stderr.on("data", (s) => { diagnostics.push(String(s)); });
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const end = events.slice(start).find((e) => e.type === "turn_end");
    if (end) return end;
    await new Promise((r) => setTimeout(r, 200));
  }
  await driver.stop();
  throw new Error("Gemini turn timeout");
}
try {
  driver = create();
  check("read-only hook handshake", (await turn("도구를 실행하지 말고 HOOK_READY라고만 답하세요.", true)).ok && hooks.some((h) => h.phase === "instructions"));
  if (!checks.at(-1).ok) throw new Error("Hook handshake failed; no file task will run");
  check("file create/edit and bridge turn", (await turn(`기본 파일 도구로 ${join(cwd, "allowed.txt")}에 FIRST를 쓰고 SECOND로 수정하세요. 파일 도구로 읽어 확인한 후 chatterbox_bridge set_expression(happy)를 호출하고 완료라고 답하세요.`)).ok);
  check("approved file is SECOND", existsSync(join(cwd, "allowed.txt")) && readFileSync(join(cwd, "allowed.txt"), "utf8").trim() === "SECOND");
  check("app approved native edits", approvals.some((a) => a.writes));
  check("expression MCP called", expression);
  const commandStart = approvals.length;
  await turn(`run_command 도구로 Get-Content -LiteralPath '${join(cwd, "allowed.txt")}' 명령을 한 번 실행하고 내용을 답하세요. 파일 도구 대신 이 읽기 명령만 사용하세요.`);
  check("native command goes through app approval", approvals.slice(commandStart).some((a) => /^Get-Content\b/i.test(a.command ?? "")));
  await turn(`기본 파일 도구로 ${join(cwd, "denied.txt")}에 DENIED를 쓰는 요청을 딱 한 번 보내세요. 거부되면 재시도나 우회 없이 거부되었다고 답하세요.`);
  check("rejected file never created", denied && !existsSync(join(cwd, "denied.txt")));
  await driver.dispose(); driver = create(nativeId);
  check("saved native session resumes", (await turn("방금 작업한 allowed.txt의 최종 내용이 무엇이었는지 한 단어로 답하세요. 도구는 필요 없습니다.", true)).ok);
  check("usage recorded", events.some((e) => e.type === "agent_usage" && e.metrics.outputTokens > 0));
  const metrics = events.filter((e) => e.type === "agent_usage").map((e) => e.metrics);
  check("resumed token counters are not double-counted", metrics.reduce((sum, m) => sum + m.outputTokens, 0) === metrics.at(-1).total.outputTokens);
} catch (e) { check(String(e), false); }
finally {
  await driver?.dispose(); bridge.stop();
  writeFileSync(join(base, "result.json"), JSON.stringify({ checks, hooks, approvals, events, diagnostics }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

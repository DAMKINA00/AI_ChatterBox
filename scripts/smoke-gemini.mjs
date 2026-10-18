// Real subscription-authenticated Antigravity, disposable workspace and app bridge only.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
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
const turnInputs = [];
let nativeId, expression = false, driver;
const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name); };
const reg = bridge.register({ tools: [{ name: "set_expression", description: "Set the worker facial expression.", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }], call: async () => { expression = true; return textResult("표정 적용 완료"); } });
const opts = { cwd, exePath: findGemini(), model: process.env.CBX_GEMINI_MODEL || undefined, nativeId: null, instructions: "격리된 ChatterBox 글쓰기 검증 작업입니다. 문장 다듬기와 대사 작성만 수행하고 코드 분석·구현·디버깅·테스트·기술 리뷰는 맡지 마세요. 읽기 참고자료는 사용할 수 있지만 파일·명령 변경과 네이티브 하위 에이전트는 실행하지 마세요. 요청이 거부되면 우회하지 말고 보고하세요." };
function create(id = null) {
  const d = new GeminiDriver({ ...opts, nativeId: id, tokenBaseline: id ? events.findLast((e) => e.type === "agent_usage")?.metrics.total : undefined }, { bridge, tmpDir: base, sessionKey: "test-worker", hookScript: join(root, "out/main/antigravity-hook.js"), mcpServers: () => ({ chatterbox_bridge: bridgeServerConfig(join(root, "out/main/bridge-mcp.js"), reg.url) }) }, {
    nativeId: (id) => { nativeId = id; },
    emit: (e) => { events.push(e); if (e.type !== "text_delta") console.log(e.type, e.name ?? e.message ?? e.ok ?? ""); },
    approve: async (input) => {
      approvals.push(input);
      const allowed = !input.writes && !!input.readOnly;
      console.log("approval", input.title, allowed ? "allow" : "deny");
      return { verdict: allowed ? "allow" : "deny", reason: allowed ? "read-only reference material" : "writing smoke never approves file or command changes" };
    },
  });
  const hook = d.hook.bind(d);
  d.hook = async (phase, payload) => { hooks.push({ phase, tool: payload?.toolCall?.name }); console.log("hook", phase, payload?.toolCall?.name ?? ""); return hook(phase, payload); };
  return d;
}
async function turn(text, noWrites = true) {
  turnInputs.push(noWrites);
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
  const publicSentence = "별빛 도서관은 아침 9시에 연다. 월요일은 쉰다.";
  const polishStart = events.length;
  check("writing turn completes", (await turn(`다음 공개 문장을 자연스럽게 다듬어 주세요: ${publicSentence} 결과는 한국어 문장으로만 답하세요. 답변 전에 chatterbox_bridge set_expression(happy)를 호출하세요.`)).ok);
  check("writing text returned", events.slice(polishStart).some((e) => e.type === "text" && /별빛|도서관/.test(e.text)));
  check("expression MCP called", expression);
  check("explicit writable mode can start without prose-only rejection", (await turn("이번에는 구현 모드 연결 확인입니다. 도구나 파일은 사용하지 말고 WRITABLE_READY라고만 답하세요.", false)).ok);
  const savedNativeId = nativeId;
  await driver.dispose(); driver = create(savedNativeId);
  const resumeStart = events.length;
  check("saved native session resumes with writing", (await turn(`앞서 다듬은 공개 문장 ${publicSentence}을 바탕으로, 방문객에게 건네는 사서의 대사를 한국어 한 문장으로 작성하세요. 파일이나 도구는 사용하지 마세요.`)).ok);
  check("saved native session id is reused", !!savedNativeId && nativeId === savedNativeId);
  check("resumed writing text returned", events.slice(resumeStart).some((e) => e.type === "text" && /사서|도서관/.test(e.text)));
  check("writing turns stay read-only and explicit writable mode is distinct", turnInputs.filter(v => !v).length === 1);
  check("usage recorded", events.some((e) => e.type === "agent_usage" && e.metrics.outputTokens > 0));
  const metrics = events.filter((e) => e.type === "agent_usage").map((e) => e.metrics);
  check("usage token total increases after resume", metrics.length >= 2 && metrics.at(-1).total.outputTokens > metrics[0].total.outputTokens);
  check("resumed token counters are not double-counted", metrics.reduce((sum, m) => sum + m.outputTokens, 0) === metrics.at(-1).total.outputTokens);
} catch (e) { check(String(e), false); }
finally {
  await driver?.dispose(); bridge.stop();
  writeFileSync(join(base, "result.json"), JSON.stringify({ checks, hooks, approvals, events, diagnostics }, null, 2));
  console.log("Evidence:", base);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

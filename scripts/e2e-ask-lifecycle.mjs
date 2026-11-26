// Real question cards and plan badges, with mocked delivery; no Electron core or agent process is started.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(join(root, ".scratch", "ask-ui-"));
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { ItemList } from "./src/renderer/src/components/Items";
import { AskWaitBadge } from "./src/renderer/src/components/PlanGoal";
import { planAskId } from "./src/renderer/src/lib/plan-mode";
import { buildItems } from "./src/renderer/src/timeline";
import { useStore } from "./src/renderer/src/store";
import { EXPIRED_ASK_ANSWER } from "./src/shared/ask-lifecycle";
const chat = { id: 1, projectId: 1, title: "질문 테스트", status: "working" };
useStore.setState({ chats: [chat], events: { 1: [] } });
let sequence = 0;
const event = payload => ({id: ++sequence, chatId: 1, node: "orch", role: "orch", at: sequence, event: payload});
const append = payload => useStore.setState(s => ({events: {1: [...s.events[1], event(payload)]}}));
window.fixture = {
  calls: [], resolve: null,
  set(events, status = "working") {
    useStore.setState({chats: [{...chat,status}], events: {1: events.map(event)}, toasts: []});
  },
  answer(chatId, id, answer) {
    this.calls.push({chatId,id,answer});
    return new Promise(resolve => { this.resolve = accepted => {
      append({type: "ask_user_answer", id, answer: accepted ? answer : EXPIRED_ASK_ANSWER});
      resolve(accepted);
    }; });
  },
};
function Fixture() {
  const events = useStore(s => s.events[1]);
  const current = useStore(s => s.chats[0]);
  const askId = planAskId(events, current.status, true, true);
  return <main>{askId && <AskWaitBadge askId={askId}/>}<ItemList items={buildItems(events, undefined, true)} chatId={1} live paginate={false}/></main>;
}
createRoot(document.getElementById("root")).render(<Fixture/>);
` }, outfile: join(output, "fixture.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "error" });
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><body><div id="root"></div>
<script>window.chatterbox={answerAskUser:(...args)=>window.fixture.answer(...args)};</script><script type="module" src="/fixture.js"></script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/fixture.js" ? readFileSync(join(output, "fixture.js")) : html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.fixture);
  const question = (id, planConfirm) => ({ type: "ask_user", id, question: `${id} 질문`, options: ["확인"], ...(planConfirm ? { planConfirm: true } : {}) });
  const set = (events, status) => page.evaluate(({events,status}) => window.fixture.set(events,status), {events,status});
  const card = id => page.locator(`[data-ask-id="${id}"]`);
  const badge = page.getByTestId("plan-ask-wait");

  await set([question("old"), {type: "turn_end", ok: true}], "working");
  await card("old").locator("text=이미 종료되었거나 만료된 질문입니다.").waitFor();
  assert.equal(await card("old").locator("button,input").count(), 0);
  assert.equal(await badge.count(), 0, "an old question never revives when another turn is working");

  await set([question("live")]);
  await badge.waitFor();
  await card("live").getByRole("button", {name: "확인", exact: true}).click();
  await card("live").getByRole("button", {name: "전달 중…", exact: true}).waitFor();
  assert.equal(await card("live").getByRole("button", {name: "확인", exact: true}).isDisabled(), true);
  assert.equal(await card("live").getByPlaceholder("직접 답하기").isDisabled(), true);
  await page.evaluate(() => window.fixture.resolve(true));
  await card("live").locator("text=답변:").waitFor();
  await badge.waitFor({state: "detached"});
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 1);

  await set([question("rejected")]);
  await card("rejected").getByRole("button", {name: "확인", exact: true}).click();
  await page.evaluate(() => window.fixture.resolve(false));
  await card("rejected").locator("text=이미 종료되었거나 만료된 질문입니다.").waitFor();
  await badge.waitFor({state: "detached"});
  assert.equal(await card("rejected").locator("button,input").count(), 0);

  await set([question("plan", true), {type: "turn_end", ok: true}], "done");
  await card("plan").getByRole("button", {name: "확인", exact: true}).click();
  await page.evaluate(() => window.fixture.resolve(true));
  await card("plan").locator("text=답변:").waitFor();
  assert.equal(await page.evaluate(() => window.fixture.calls.at(-1).id), "plan");
  assert.deepEqual(errors, []);
  await page.screenshot({path: join(output, "verified.png")});
  writeFileSync(join(output, "result.json"), JSON.stringify({passed: true, scenarios: ["expired history", "live answer", "pending controls", "rejected answer", "idle plan confirmation"]}, null, 2));
  console.log(`PASS question lifecycle UI (5 scenarios): ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

// Native Electron + real Graphify fixture. No chat/model request is sent.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, root } from "./e2e-lib.mjs";

const base = join(root, ".scratch", "graphify-service");
const data = join(base, "data"), workspace = join(base, "workspace");
mkdirSync(data, { recursive: true });
const schema = readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1];
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(schema);
for (const [id, name, folder] of [[1, "Graphify sample", workspace], [2, "ChatterBox source", root]]) {
  db.prepare("INSERT OR IGNORE INTO projects (id,name,folder,settings_json,created_at,archived) VALUES (?,?,?,'{}',?,0)").run(id, name, folder, Date.now());
}
db.close();
const { app, page } = await launch(data);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const call = (action, rest = {}, projectId = 1) => page.evaluate(args => window.chatterbox.graphify(args), { projectId, action, ...rest });
try {
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows()[0].setSize(1360, 900);
    shell.showItemInFolder = file => { globalThis.__graphifyOpenedFile = file; };
  });
  await page.getByRole("button", { name: "Graphify sample 폴더", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "프로젝트 그래프", exact: true }).click();
  await page.getByTestId("graphify-canvas").waitFor();
  await page.getByTestId("graphify-canvas").getByRole("button", { name: "greet() · service.py", exact: true }).click();
  assert((await page.getByTestId("graphify-node-details").innerText()).includes("greet()"));
  await page.getByRole("button", { name: "확대", exact: true }).click();
  assert((await page.getByTestId("graphify-canvas").locator("svg > g").getAttribute("transform")).includes("scale(1.2)"));
  await page.getByRole("button", { name: "그래프 보기 초기화", exact: true }).click();
  assert((await page.getByTestId("graphify-summary").innerText()).includes("노드 4"));
  await page.getByTestId("graphify-report-toggle").click();
  assert((await page.getByTestId("graphify-report").innerText()).includes("#"));
  await page.getByTestId("graphify-report-toggle").click();
  await page.getByTestId("graphify-search").fill("greet");
  assert.equal(await page.getByRole("listbox", { name: "그래프 노드" }).getByRole("option").count(), 1);
  await page.getByRole("listbox", { name: "그래프 노드" }).getByRole("option").click();
  await page.getByTestId("graphify-explain").click();
  await page.getByTestId("graphify-result").filter({ hasText: "service_greet" }).waitFor();
  await page.getByTestId("graphify-open-source").click();
  assert((await app.evaluate(() => globalThis.__graphifyOpenedFile)).endsWith("service.py"));
  await page.getByTestId("graphify-path-target-search").fill("main.py");
  await page.getByTestId("graphify-path-target").first().click();
  await page.getByTestId("graphify-result").filter({ hasText: "Shortest path" }).waitFor();
  await page.getByLabel("그래프 검색", { exact: true }).fill("greet");
  await page.getByTestId("graphify-query-submit").click();
  await page.getByTestId("graphify-result").filter({ hasText: "NODE greet" }).waitFor();
  await page.getByTestId("graphify-search").fill("");
  await page.getByTestId("graphify-build").click();
  await page.getByTestId("graphify-cancel").waitFor();
  await page.getByTestId("graphify-cancel").click();
  await page.getByTestId("graphify-build").waitFor();
  assert.equal((await call("graph")).graph.nodes.length, 4);
  const unauthorized = await page.evaluate(async () => {
    try { await window.chatterbox.graphify({ projectId: 99999, action: "status" }); return false; } catch { return true; }
  });
  assert(unauthorized);
  await page.getByTestId("graphify-dialog").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(base, "ui-fixture-dark.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
  await page.screenshot({ path: join(base, "ui-fixture-small.png") });
  const overflow = await page.getByTestId("graphify-dialog").evaluate(el => el.scrollWidth > el.clientWidth + 2);
  assert(!overflow, "dialog must not overflow horizontally");
  const canvasBox = await page.getByTestId("graphify-canvas").boundingBox();
  const listBox = await page.getByLabel("노드 목록", { exact: true }).boundingBox();
  assert(canvasBox.y + canvasBox.height <= listBox.y + 2, "small layout must stack without overlap");
  await page.keyboard.press("Escape");
  // Real repository analysis exercises TypeScript and a graph large enough to test the rendering cap.
  if (!(await call("status", {}, 2)).status.nodeCount || process.argv.includes("--rebuild-repo")) await call("build", {}, 2);
  const deadline = Date.now() + 10 * 60_000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 1000));
    status = (await call("status", {}, 2)).status;
    if (status.error) throw new Error(status.error);
    if (Date.now() > deadline) throw new Error("Repository graph timed out");
  } while (status.busy);
  assert(status.nodeCount > 100);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
  await page.getByRole("button", { name: "ChatterBox source 폴더", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "프로젝트 그래프", exact: true }).click();
  await page.getByTestId("graphify-canvas").waitFor();
  const count = await page.getByTestId("graphify-canvas").getByRole("button").count();
  assert(count <= 75, `bounded graph: ${count}`);
  const radii = await page.locator('.graphify-node-core').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('r'))));
  assert(Math.max(...radii) > Math.min(...radii) * 2.5, 'hubs must visibly grow, not use clusters of extra circles');
  assert(await page.getByTestId("graphify-dialog").locator("aside").evaluate(el => el.scrollWidth <= el.clientWidth + 2), "node details must fit the aside");
  await page.screenshot({ path: join(base, "ui-repository-dark.png") });
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.screenshot({ path: join(base, "ui-repository-light.png") });
  assert.deepEqual(errors, []);
  writeFileSync(join(base, "ui-result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), repositoryNodes: status.nodeCount, repositoryEdges: status.edgeCount, rendererErrors: errors }, null, 2));
  console.log(`PASS native menu/graph/search/explain/path/source/report/cancel/repository/responsive UI: ${status.nodeCount} nodes, ${status.edgeCount} edges`);
} catch (error) {
  console.log((await page.locator('[data-testid="graphify-error"], [data-testid="graphify-status-error"], [data-testid="graphify-result"]').allTextContents()).join("\n").slice(-2500));
  await page.screenshot({ path: join(base, "ui-failure.png") });
  throw error;
} finally { await app.close(); }

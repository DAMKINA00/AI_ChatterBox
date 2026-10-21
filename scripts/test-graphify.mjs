// Real pinned Graphify runtime; synthetic source only, no model or video requests.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, ".scratch", "graphify-service");
const workspace = join(base, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "main.py"), 'from service import greet\n\ndef main():\n    return greet("demo")\n');
await writeFile(join(workspace, "service.py"), 'def greet(name):\n    return "Hello " + name\n');
await writeFile(join(workspace, "ignored.py"), 'def private_function():\n    return 42\n');
await writeFile(join(workspace, ".graphifyignore"), "ignored.py\n");
const bundle = join(base, "service.cjs");
await build({ entryPoints: [join(root, "src/main/graphify.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
const { GraphifyService } = createRequire(import.meta.url)(bundle);
const service = new GraphifyService(join(base, "data"));
const project = { id: 1, folder: workspace };
const request = (action, rest = {}) => service.request(project, { projectId: 1, action, ...rest });
async function wait() {
  const deadline = Date.now() + 15 * 60_000;
  let lastPhase;
  while (Date.now() < deadline) {
    const response = await request("status");
    if (lastPhase !== response.status.phase) { console.log(response.status.phase); lastPhase = response.status.phase; }
    if (!response.status.busy) { assert.equal(response.status.error, undefined, response.status.error); return response; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Graphify test timed out");
}
try {
  await request("install"); await wait();
  assert.equal((await request("status")).status.installed, true);
  await request("build"); await wait();
  const { graph } = await request("graph");
  assert.equal((await service.prepare(project)).graph.generatedAt, graph.generatedAt, "existing project analysis is reused");
  const fresh = { id: Date.now(), folder: workspace };
  const [first, concurrent] = await Promise.all([service.prepare(fresh), service.prepare(fresh)]);
  assert(first.graph.nodes.length > 0, "first analysis completes before prepare returns");
  assert.equal(concurrent.graph.generatedAt, first.graph.generatedAt, "concurrent chats share the initial extraction");
  const emptyFolder = join(base, "empty-project");
  await mkdir(emptyFolder, { recursive: true });
  const empty = await service.prepare({ id: fresh.id + 1, folder: emptyFolder });
  assert.equal(empty.graph.nodes.length, 0);
  assert(empty.graph.report.includes("미지원 언어"), "empty/unsupported project requires explicit master source review");
  assert(graph.nodes.some(n => n.label === "greet()"));
  assert(!graph.nodes.some(n => n.sourceFile === "ignored.py"));
  assert(graph.edges.some(e => e.relation === "calls"));
  assert(graph.report?.includes("#"));
  const from = graph.nodes.find(n => n.label === "main()");
  const to = graph.nodes.find(n => n.label === "greet()");
  for (const [action, input] of [["query", { query: "greet" }], ["explain", { node: to.id }], ["path", { node: from.id, to: to.id }]]) {
    const response = await request(action, input);
    assert(response.result.text.includes("greet"), response.result.text);
    console.log(`PASS ${action}: ${response.result.text.slice(0, 220).replace(/\s+/g, " ")}`);
  }
  const fileNode = graph.nodes.find(n => n.label === "main.py");
  assert((await request("path", { node: to.id, to: fileNode.id })).result.text.includes("Shortest path"));
  assert((await request("explain", { node: fileNode.id })).result.text.includes("main.py"));
  const reloaded = new GraphifyService(join(base, "data"));
  assert.equal((await reloaded.request(project, { projectId: 1, action: "graph" })).graph.generatedAt, graph.generatedAt);
  await reloaded.dispose();
  await request("build"); await request("cancel"); await wait();
  assert.equal((await request("graph")).graph.generatedAt, graph.generatedAt, "cancel preserves previous graph");
  // An empty extraction fails without replacing the usable graph.
  await writeFile(join(workspace, ".graphifyignore"), "*\n");
  await request("build");
  await assert.rejects(wait());
  assert.equal((await request("graph")).graph.generatedAt, graph.generatedAt, "failure preserves previous graph");
  await writeFile(join(workspace, ".graphifyignore"), "ignored.py\n");
  console.log(`PASS install/build/first-analysis/reuse/concurrent/ignore/report/query/explain/path/reload/cancel/failure (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
  await writeFile(join(base, "result.json"), JSON.stringify({ passed: true, at: new Date().toISOString(), nodes: graph.nodes.length, edges: graph.edges.length, version: graph.version }, null, 2));
} finally {
  await service.dispose();
}

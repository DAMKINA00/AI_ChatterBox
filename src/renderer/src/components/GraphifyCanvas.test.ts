import assert from "node:assert/strict";
import { test } from "node:test";
async function canvas() {
  (globalThis as any).window = { chatterbox: {} };
  return import("./GraphifyCanvas");
}
const nodes = Array.from({ length: 800 }, (_, i) => ({ id: String(i), label: `node ${i}`, kind: "code", sourceFile: `${i}.ts`, community: String(i % 8), description: "", degree: i }));
const edges = [{ source: "0", target: "1", relation: "calls", confidence: "EXTRACTED" }];

test("graph filters exclude non-matching selected nodes and neighbors", async () => {
  const { selectVisibleNodes } = await canvas();
  assert.deepEqual(selectVisibleNodes(nodes, edges, "0", new Set(["4", "7"])).map(n => n.id).sort(), ["4", "7"]);
  assert.deepEqual(selectVisibleNodes(nodes, edges, "0", new Set()), []);
});

test("large graph keeps selection and neighbors within the rendering cap", async () => {
  const { selectVisibleNodes, GRAPHIFY_VISIBLE_NODE_LIMIT } = await canvas();
  const visible = selectVisibleNodes(nodes, edges, "0");
  assert.equal(visible.length, GRAPHIFY_VISIBLE_NODE_LIMIT);
  assert(visible.some(n => n.id === "0")); assert(visible.some(n => n.id === "1"));
  assert(visible.some(n => n.id === "799"));
  assert.equal(nodes[0].id, "0");
});

test("hub size grows with real degree and force layout is deterministic and bounded", async () => {
  const { graphNodeRadius, layoutGraph } = await canvas();
  assert(graphNodeRadius(1000, 1000) > graphNodeRadius(1, 1000) * 4);
  assert(graphNodeRadius(40, 1000) > graphNodeRadius(20, 1000));
  const subset = nodes.slice(0, 30);
  const result = layoutGraph(subset, edges);
  assert.deepEqual(result, layoutGraph(subset, edges));
  assert.equal(result.size, 30);
  for (const point of result.values()) assert(Number.isFinite(point.x) && point.x >= 0 && point.x <= 1280 && point.y >= 0 && point.y <= 530);
});

test("low-degree path nodes remain visible in the hub overview", async () => {
  const { selectVisibleNodes } = await canvas();
  const visible = selectVisibleNodes(nodes, edges, undefined, undefined, new Set(["3", "4"]));
  assert(visible.some(n => n.id === "3")); assert(visible.some(n => n.id === "4"));
});

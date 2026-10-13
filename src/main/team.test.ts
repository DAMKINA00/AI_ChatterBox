// Run: node --test src/main/team.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addWait, checkAsk, depthOf, removeWait, type WaitGraph } from "./team.ts";

test("cycle: B may not ask A while A waits on B", () => {
  const g: WaitGraph = new Map();
  addWait(g, "orch", "w1"); // master → 클로드 1호
  addWait(g, "w1", "w2"); // 클로드 1호 → 클로드 2호
  assert.equal(checkAsk(g, "w2", "w1", 3), "cycle");
  assert.equal(checkAsk(g, "w2", "w3", 3), null); // 2호 → 3호 is fine
  removeWait(g, "w1", "w2");
  assert.equal(checkAsk(g, "w2", "w1", 3), null);
});

test("longer cycle is caught", () => {
  const g: WaitGraph = new Map();
  addWait(g, "w1", "w2");
  addWait(g, "w2", "w3");
  assert.equal(checkAsk(g, "w3", "w1", 5), "cycle");
});

test("self ask refused", () => {
  assert.equal(checkAsk(new Map(), "w1", "w1", 3), "self");
});

test("depth limit 3", () => {
  const g: WaitGraph = new Map();
  addWait(g, "orch", "w1");
  addWait(g, "w1", "w2");
  addWait(g, "w2", "w3");
  assert.equal(depthOf(g, "w3"), 3);
  assert.equal(checkAsk(g, "w3", "w4", 3), "depth");
  assert.equal(checkAsk(g, "w2", "w4", 3), null);
});

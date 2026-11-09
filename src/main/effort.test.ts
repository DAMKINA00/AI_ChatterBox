import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEffort, workerEffort } from "./effort";
import type { ModelOption } from "../shared/types";

const model = (id: string, reasoningEfforts: string[]): ModelOption => ({ id, label: id, reasoningEfforts });

test("resolveEffort falls back downward within the model support list and never raises", () => {
  assert.equal(resolveEffort("xhigh", model("medium-high-model", ["medium", "high"])), "high");
  assert.equal(resolveEffort("high", model("medium-model", ["medium"])), "medium");
  assert.throws(() => resolveEffort("medium", model("high-only-model", ["high", "xhigh"])), /추론 수준 medium/);
  assert.throws(() => resolveEffort("xhigh", model("unsupported-model", [])), /unsupported-model에서 추론 수준 xhigh/);
});

test("workerEffort allows all model levels and defaults while manual settings stay authoritative", () => {
  assert.equal(workerEffort("high", "medium"), "high");
  assert.equal(workerEffort("medium", "xhigh"), "medium");
  assert.equal(workerEffort("auto", "high"), "high");
  assert.equal(workerEffort("", "high"), "high");
  assert.equal(workerEffort("auto"), "");

  for (const setting of ["none", "minimal", "low", "max"]) assert.equal(workerEffort(setting), setting);
  for (const requested of ["none", "minimal", "low", "max"]) assert.equal(workerEffort("auto", requested), requested);
  assert.equal(workerEffort("auto", "provider-new-level"), "provider-new-level");
  assert.equal(resolveEffort("provider-new-level", model("future", ["provider-new-level"])), "provider-new-level");
  assert.throws(() => workerEffort("auto", ""), /effort/);
  assert.throws(() => resolveEffort("unsupported", model("current", ["low", "high"])), /지원하지 않습니다/);
});

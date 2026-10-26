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

test("workerEffort requires a master request for auto and keeps manual settings authoritative", () => {
  assert.equal(workerEffort("high", "medium"), "high");
  assert.equal(workerEffort("medium", "xhigh"), "medium");
  assert.equal(workerEffort("auto", "high"), "high");
  assert.equal(workerEffort("", "high"), "high");
  assert.throws(() => workerEffort("auto"), /자동 배정/);

  for (const setting of ["low", "max"]) assert.throws(() => workerEffort(setting), /작업자 추론 설정/);
  for (const requested of ["low", "max"]) assert.throws(() => workerEffort("auto", requested), /작업자 effort/);
});

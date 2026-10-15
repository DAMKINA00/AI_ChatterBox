import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { Orchestrator } from "./orchestrator";

function fixture(settings: ProjectSettings = DEFAULT_SETTINGS) {
  const root = mkdtempSync(join(tmpdir(), "cbx-project-limits-"));
  const store = new Store(join(root, "test.db"));
  const project = store.createProject("limits", root, settings);
  const chat = store.createChat(project.id, "limits");
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const inst = { id: 1, mode: "delegated", text: "limits", asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] };
  engine.instructions.set(chat.id, inst);
  return {
    root,
    store,
    project,
    chat,
    engine,
    inst,
    async close() {
      await engine.judge.dispose();
      await chats.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function persistedSettings(store: Store, projectId: number): Record<string, unknown> {
  const row = store.db.prepare("SELECT settings_json FROM projects WHERE id = ?").get(projectId) as { settings_json: string };
  return JSON.parse(row.settings_json) as Record<string, unknown>;
}

function readBudgetLiterals(f: ReturnType<typeof fixture>, maxConsults: string | undefined, maxReviews: string | undefined) {
  const saved = persistedSettings(f.store, f.project.id);
  const consultMarker = "__CBX_MAX_CONSULTS__";
  const reviewMarker = "__CBX_MAX_REVIEWS__";
  if (maxConsults === undefined) delete saved.maxConsults;
  else saved.maxConsults = consultMarker;
  if (maxReviews === undefined) delete saved.maxReviews;
  else saved.maxReviews = reviewMarker;
  let json = JSON.stringify(saved);
  if (maxConsults !== undefined) json = json.replace(`"maxConsults":"${consultMarker}"`, `"maxConsults":${maxConsults}`);
  if (maxReviews !== undefined) json = json.replace(`"maxReviews":"${reviewMarker}"`, `"maxReviews":${maxReviews}`);
  f.store.db.prepare("UPDATE projects SET settings_json = ? WHERE id = ?").run(json, f.project.id);
  return f.store.project(f.project.id)!.settings;
}

function checkLimit(f: ReturnType<typeof fixture>, kind: "opinion" | "review", asks: number, reviews: number, message: string) {
  f.inst.asks = asks;
  f.inst.reviews = reviews;
  f.inst.requests = new Map();
  return f.engine.limitCheck(f.chat.id, f.store.project(f.project.id)!, "w1", kind, message);
}

test("default and stored project limits normalize missing, invalid, fractional, and bounded values", async () => {
  const f = fixture();
  try {
    assert.equal(DEFAULT_SETTINGS.maxConsults, 100);
    assert.equal(DEFAULT_SETTINGS.maxReviews, 20);
    assert.deepEqual(
      [f.store.project(f.project.id)!.settings.maxConsults, f.store.project(f.project.id)!.settings.maxReviews],
      [100, 20],
    );

    const cases: Array<[string, string | undefined, string | undefined, number, number]> = [
      ["missing", undefined, undefined, 100, 20],
      ["nonfinite", "1e999", "-1e999", 100, 20],
      ["invalid", JSON.stringify("not-a-number"), "null", 100, 20],
      ["fractional", "8.9", "4.9", 8, 4],
      ["lower", "0", "-4", 1, 0],
      ["upper", "1000", "100", 999, 99],
      ["custom", "8", "4", 8, 4],
    ];
    for (const [label, consults, reviews, expectedConsults, expectedReviews] of cases) {
      const settings = readBudgetLiterals(f, consults, reviews);
      assert.deepEqual([settings.maxConsults, settings.maxReviews], [expectedConsults, expectedReviews], label);
    }
  } finally {
    await f.close();
  }
});

test("legacy 8/3 project limits migrate once, preserve other pairs, and retain a new explicit 8/3", () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-project-limits-migration-"));
  const dbPath = join(root, "test.db");
  let store: Store | undefined;
  try {
    store = new Store(dbPath);
    const legacy = store.createProject("legacy", root, { ...DEFAULT_SETTINGS, maxConsults: 8, maxReviews: 3 });
    const custom = store.createProject("custom", root, { ...DEFAULT_SETTINGS, maxConsults: 8, maxReviews: 4 });
    const other = store.createProject("other", root, { ...DEFAULT_SETTINGS, maxConsults: 4, maxReviews: 3 });
    store.db.prepare("DELETE FROM settings WHERE key = 'migratedAllocationLimits'").run();
    store.close();
    store = new Store(dbPath);

    assert.deepEqual([store.project(legacy.id)!.settings.maxConsults, store.project(legacy.id)!.settings.maxReviews], [100, 20]);
    assert.deepEqual([store.project(custom.id)!.settings.maxConsults, store.project(custom.id)!.settings.maxReviews], [8, 4]);
    assert.deepEqual([store.project(other.id)!.settings.maxConsults, store.project(other.id)!.settings.maxReviews], [4, 3]);

    const explicit = store.createProject("explicit", root, { ...DEFAULT_SETTINGS, maxConsults: 8, maxReviews: 3 });
    store.close();
    store = new Store(dbPath);
    assert.deepEqual([store.project(legacy.id)!.settings.maxConsults, store.project(legacy.id)!.settings.maxReviews], [100, 20]);
    assert.deepEqual([store.project(explicit.id)!.settings.maxConsults, store.project(explicit.id)!.settings.maxReviews], [8, 3]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("limitCheck honors exact configured consult limits without the old cap or worker bonus", async () => {
  const f = fixture({ ...DEFAULT_SETTINGS, maxConsults: 100, maxReviews: 20 });
  try {
    f.store.createAgent(f.chat.id, "claude", "one");
    f.store.createAgent(f.chat.id, "claude", "two");
    f.store.createAgent(f.chat.id, "gpt", "three");
    assert.equal(checkLimit(f, "opinion", 99, 0, "consult boundary 99"), null);
    assert.match(checkLimit(f, "opinion", 100, 0, "consult boundary 100") ?? "", /100/);

    f.store.updateProject(f.project.id, { settings: { ...DEFAULT_SETTINGS, maxConsults: 999, maxReviews: 20 } });
    assert.equal(checkLimit(f, "opinion", 998, 0, "consult boundary 998"), null);
    assert.match(checkLimit(f, "opinion", 999, 0, "consult boundary 999") ?? "", /999/);

    f.store.updateProject(f.project.id, { settings: { ...DEFAULT_SETTINGS, maxConsults: 4, maxReviews: 20 } });
    assert.equal(checkLimit(f, "opinion", 3, 0, "consult custom 3"), null);
    assert.match(checkLimit(f, "opinion", 4, 0, "consult custom 4") ?? "", /4/);
  } finally {
    await f.close();
  }
});

test("limitCheck honors exact review limits and keeps stop, plan, and duplicate guards", async () => {
  const f = fixture({ ...DEFAULT_SETTINGS, maxConsults: 100, maxReviews: 20 });
  try {
    assert.equal(checkLimit(f, "review", 0, 19, "review boundary 19"), null);
    assert.match(checkLimit(f, "review", 0, 20, "review boundary 20") ?? "", /20/);

    f.store.updateProject(f.project.id, { settings: { ...DEFAULT_SETTINGS, maxConsults: 100, maxReviews: 99 } });
    assert.equal(checkLimit(f, "review", 0, 98, "review boundary 98"), null);
    assert.match(checkLimit(f, "review", 0, 99, "review boundary 99") ?? "", /99/);

    f.engine.stopped.add(f.chat.id);
    assert.match(checkLimit(f, "opinion", 0, 0, "stop policy"), /중지/);
    f.engine.stopped.delete(f.chat.id);
    f.engine.planning.add(f.chat.id);
    assert.match(checkLimit(f, "opinion", 0, 0, "plan policy"), /계획/);
    f.engine.planning.delete(f.chat.id);

    f.inst.asks = 0;
    f.inst.reviews = 0;
    f.inst.requests = new Map();
    const duplicate = "same duplicate policy request";
    assert.equal(f.engine.limitCheck(f.chat.id, f.store.project(f.project.id)!, "w1", "opinion", duplicate), null);
    assert.equal(f.engine.limitCheck(f.chat.id, f.store.project(f.project.id)!, "w1", "opinion", duplicate), null);
    assert.match(f.engine.limitCheck(f.chat.id, f.store.project(f.project.id)!, "w1", "opinion", duplicate) ?? "", /두 번/);
  } finally {
    await f.close();
  }
});

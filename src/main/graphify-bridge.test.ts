import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../shared/types";
import { ChatManager } from "./chats";
import { Store } from "./db";
import { Orchestrator } from "./orchestrator";

function preparedGraph(root: string, generatedAt = 1710000000000) {
  return {
    status: { installed: true, version: "test", busy: false, phase: "ready", log: "", nodeCount: 2, edgeCount: 1, stale: false },
    graph: {
      generatedAt, root, version: "0.9.93", report: "graph report",
      nodes: [
        { id: "b", label: "B", kind: "function", sourceFile: "src/b.ts", community: "core", description: "", degree: 1 },
        { id: "a", label: "A", kind: "function", sourceFile: "src/a.ts", community: "core", description: "", degree: 2 },
      ],
      edges: [{ source: "a", target: "b", relation: "calls", confidence: "HIGH" }],
    },
  };
}

function workflowFixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-graph-workflow-"));
  const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  const engine = new Orchestrator(chats) as any;
  const project = store.createProject("graph workflow", root, DEFAULT_SETTINGS);
  const chat = store.createChat(project.id, "graph workflow");
  const worker = store.createAgent(chat.id, "gpt", "graph worker");
  const instruction = { id: 1, text: "graph workflow", asks: 0, reviews: 0, requests: new Map(), queued: [], pinned: [] };
  engine.instructions.set(chat.id, instruction);
  let prepareCalls = 0;
  let capabilityCalls = 0;
  chats.graphify.prepare = async () => { prepareCalls++; return preparedGraph(root); };
  chats.teamCapabilities = async () => { capabilityCalls++; return { gpt: { installed: true } }; };
  return { root, store, chats, engine, project, chat, worker, instruction, get prepareCalls() { return prepareCalls; }, get capabilityCalls() { return capabilityCalls; } };
}

async function closeWorkflowFixture(f: ReturnType<typeof workflowFixture>) {
  await f.engine.judge.dispose(); await f.chats.dispose(); f.store.close();
  rmSync(f.root, { recursive: true, force: true });
}

test("master and workers share a project-scoped graph tool; install and external project selection are rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbx-graph-bridge-"));
  const store = new Store(join(root, "app.db"));
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, usage() {}, event() {} }, root, "unused");
  const engine = new Orchestrator(chats);
  try {
    const project = store.createProject("graph", root, DEFAULT_SETTINGS);
    const other = store.createProject("other", tmpdir(), DEFAULT_SETTINGS);
    const chat = store.createChat(project.id, "graph");
    const worker = store.createAgent(chat.id, "gpt", "read graph");
    const calls: any[] = [];
    chats.graphify.request = async (p, r) => {
      calls.push({ project: p, request: r });
      return { status: { installed: true, version: "test", busy: false, phase: "ready", log: "", nodeCount: 2, edgeCount: 1, stale: false }, result: { text: "sample graph", nodeIds: ["a"] } };
    };
    await chats.bridge.start();
    for (const role of ["orch", worker.key]) {
      (engine as any).bridgeFor(chat.id, role);
      const reg = (chats.bridge as any).regs.get(`br-${chat.id}-${role}`);
      assert(reg.tools.some((tool: any) => tool.name === "project_graph"));
      const result = await reg.call("project_graph", { action: "query", query: "greet", projectId: other.id, root: tmpdir() });
      assert.equal(result.isError, false);
      assert.equal(calls.at(-1).project.id, project.id);
      assert.equal(calls.at(-1).request.projectId, project.id);
      assert.equal(calls.at(-1).request.root, undefined);
      assert.equal((await reg.call("project_graph", { action: "install" })).isError, true);
      assert.equal((await reg.call("project_graph", { action: "open-source", node: "a" })).isError, true);
    }
    assert.equal(calls.length, 2);
    store.updateChat(chat.id, { status: "paused" });
    assert.equal((await (engine as any).call(chat.id, "orch", "project_graph", { action: "build" })).isError, true);
    assert.equal(calls.length, 2);
  } finally {
    await engine.judge.dispose(); await chats.dispose(); store.close();
    assert(root.startsWith(join(tmpdir(), "cbx-graph-bridge-")));
    rmSync(root, { recursive: true, force: true });
  }
});

test("code-work routing waits for Graphify, returns compact context, and gates work until master analysis", async () => {
  const f = workflowFixture();
  try {
    let release!: (value: any) => void;
    const preparing = new Promise(resolve => { release = resolve; });
    let preparedCalls = 0;
    f.chats.graphify.prepare = async () => { preparedCalls++; return preparing; };
    let consulted = 0;
    f.engine.consult = async () => { consulted++; return { content: [{ type: "text", text: "stub consult" }], isError: false }; };

    const routed = f.engine.call(f.chat.id, "orch", "route_request", { mode: "delegated", reason: "inspect code structure", codeWork: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.capabilityCalls, 0);
    release(preparedGraph(f.root));
    const first = await routed;
    assert.equal(first.isError, false);
    const firstBody = JSON.parse(first.content[0].text);
    assert.equal(firstBody.graphContext.generatedAt, 1710000000000);
    assert.equal(firstBody.graphContext.nodeCount, 2);
    assert.equal(firstBody.graphContext.edgeCount, 1);
    assert.equal(firstBody.graphContext.stale, false);
    assert.equal(firstBody.graphContext.report, "graph report");
    assert.deepEqual(firstBody.graphContext.hubs.map((node: any) => node.id), ["a", "b"]);
    assert.equal(firstBody.graphContext.nodes, undefined);
    assert.match(firstBody.graphContext.next, /record_analysis/);
    assert.equal(preparedCalls, 1);
    assert.equal(f.capabilityCalls, 1);

    const laterFalse = await f.engine.call(f.chat.id, "orch", "route_request", { mode: "delegated", reason: "continue code review", codeWork: false });
    assert.equal(laterFalse.isError, false);
    assert.equal(f.instruction.codeWork, true);
    assert.equal(preparedCalls, 2);
    assert.equal(f.capabilityCalls, 2);

    const summary = "확인한 구조와 관련 파일, 변경 영향, 검증 계획을 정리했습니다.";
    const workerRecord = await f.engine.call(f.chat.id, f.worker.key, "project_graph", { action: "record_analysis", summary });
    assert.equal(workerRecord.isError, true);
    const blockedRecord = await f.engine.call(f.chat.id, "orch", "project_graph", { action: "record_analysis", summary: "짧음" });
    assert.equal(blockedRecord.isError, true);
    const blockedAsk = await f.engine.call(f.chat.id, "orch", "ask", { to: f.worker.nickname, kind: "opinion", message: "검토해 주세요", reason: "구조 확인", effort: "medium" });
    assert.equal(blockedAsk.isError, true);
    assert.match(blockedAsk.content[0].text, /Graphify|분석/);
    const write = { role: "orch", node: "orch", title: "Write", detail: "", key: "write_file", writes: true, paths: [join(f.root, "a.txt")] };
    assert.match(f.chats.approvalGuard(f.chat.id, write) ?? "", /구조와 변경 영향|분석/);
    assert.equal(consulted, 0);

    const recorded = await f.engine.call(f.chat.id, "orch", "project_graph", { action: "record_analysis", summary });
    assert.equal(recorded.isError, false);
    assert.equal(f.instruction.graphAnalysis, summary);
    assert.equal(f.chats.approvalGuard(f.chat.id, write), null);
    const allowedAsk = await f.engine.call(f.chat.id, "orch", "ask", { to: f.worker.nickname, kind: "opinion", message: "검토해 주세요", reason: "구조 확인", effort: "medium" });
    assert.equal(allowedAsk.isError, false);
    assert.equal(consulted, 1);
  } finally { await closeWorkflowFixture(f); }
});

test("non-code routing skips Graphify preparation", async () => {
  const f = workflowFixture();
  try {
    const result = await f.engine.call(f.chat.id, "orch", "route_request", { mode: "direct", reason: "answer a general question", codeWork: false });
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.graphContext, undefined);
    assert.equal(f.prepareCalls, 0);
    assert.equal(f.capabilityCalls, 1);
    assert.equal(f.instruction.codeWork, false);
  } finally { await closeWorkflowFixture(f); }
});

test("Graphify preparation errors and stops do not progress routing", async () => {
  const failed = workflowFixture();
  try {
    failed.chats.graphify.prepare = async () => { throw new Error("prepare failed"); };
    const result = await failed.engine.call(failed.chat.id, "orch", "route_request", { mode: "delegated", reason: "prepare code map", codeWork: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /prepare failed/);
    assert.equal(failed.capabilityCalls, 0);
    assert.equal(failed.instruction.codeWork, true);
    assert.equal(failed.instruction.graphPreparedAt, undefined);
    assert.ok(failed.chats.approvalGuard(failed.chat.id, { role: "orch", writes: true, paths: [join(failed.root, "a.txt")] }));
  } finally { await closeWorkflowFixture(failed); }

  const stopped = workflowFixture();
  try {
    let release!: (value: any) => void;
    stopped.chats.graphify.prepare = async () => new Promise(resolve => { release = resolve; });
    const pending = stopped.engine.call(stopped.chat.id, "orch", "route_request", { mode: "delegated", reason: "prepare code map", codeWork: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    stopped.engine.stopped.add(stopped.chat.id);
    release(preparedGraph(stopped.root));
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /중지|변경/);
    assert.equal(stopped.capabilityCalls, 0);
    assert.equal(stopped.instruction.graphPreparedAt, undefined);
    assert.ok(stopped.chats.approvalGuard(stopped.chat.id, { role: "orch", writes: true, paths: [join(stopped.root, "a.txt")] }));
  } finally { await closeWorkflowFixture(stopped); }
});

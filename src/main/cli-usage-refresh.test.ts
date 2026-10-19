import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mock, test } from "node:test";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../shared/types";
import { Store } from "./db";
import { ChatManager } from "./chats";

const END = "2026-10-26T00:00:00Z";

function fixture(initial: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cbx-cli-usage-refresh-"));
  const store = new Store(join(root, "app.db"));
  const project = store.createProject("usage", root, DEFAULT_SETTINGS);
  store.setSetting("usage", JSON.stringify(initial));
  const geminiExe = join(root, "agy.exe"), grokExe = join(root, "grok.exe");
  writeFileSync(geminiExe, "fake"); writeFileSync(grokExe, "fake");
  store.setSetting("geminiPath", geminiExe); store.setSetting("grokPath", grokExe);
  const snapshots: any[] = [];
  const chats = new ChatManager(store, { agents() {}, chat() {}, consult() {}, event() {}, usage: u => snapshots.push(u) }, root, "unused");
  return { root, store, project, chats, snapshots };
}

function fakeGemini(stdout: string, error: any = null) {
  let ended = false;
  const patched = mock.method(childProcess, "execFile", ((_exe: string, _args: string[], _options: any, callback: Function) => {
    queueMicrotask(() => callback(error, stdout, ""));
    return { stdin: { end: () => { ended = true; } } };
  }) as any);
  return { patched, get ended() { return ended; } };
}

function fakeGrok(replies: Array<{ result?: unknown; error?: { code?: number; message: string } }>) {
  const requests: any[] = [], children: any[] = [];
  const patched = mock.method(childProcess, "spawn", (_exe: string, args: string[]) => {
    assert.ok(args.includes("--no-subagents"));
    const reply = replies[children.length] ?? replies.at(-1);
    const child: any = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, pid: 50_000 + children.length,
    });
    children.push(child);
    child.stdin.on("finish", () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0; child.stdout.end(); child.emit("exit", 0);
    });
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n").filter(Boolean)) {
        const request = JSON.parse(line); requests.push(request);
        if (request.id === undefined) continue;
        if (request.method === "_x.ai/billing" && reply?.error) {
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: reply.error }) + "\n");
          continue;
        }
        const result = request.method === "initialize"
          ? { _meta: { defaultAuthMethodId: "cached_token" } }
          : request.method === "_x.ai/billing" ? reply?.result : {};
        queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
      }
    });
    return child;
  });
  return { requests, children, restore: () => patched.mock.restore() };
}

const geminiUsage = JSON.stringify({
  status: "SUCCESS", num_turns: 0,
  command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: 0.8 }] }] } },
});
const grokUsage = { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: END }, creditUsagePercent: 20 } };

test("refreshUsage settles a synchronous Codex failure while still refreshing Gemini and Grok", async () => {
  const f = fixture();
  const gemini = fakeGemini(geminiUsage);
  const grok = fakeGrok([{ result: grokUsage }]);
  try {
    (f.chats as any).codex = () => { throw new Error("codex missing"); };
    await f.chats.refreshUsage();
    assert.equal(gemini.ended, true);
    assert.ok(Math.abs((f.chats.usage().gemini?.weekly?.usedPercent ?? NaN) - 20) < 1e-9);
    assert.deepEqual(f.chats.usage().grok?.weekly?.usedPercent, 20);
    assert.equal(typeof f.chats.usage().gemini?.updatedAt, "number");
    assert.equal(typeof f.chats.usage().grok?.updatedAt, "number");
  } finally {
    gemini.patched.mock.restore(); grok.restore();
    await f.chats.dispose(); f.store.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("concurrent Grok refreshes coalesce, errors replace stale usage, and a later retry succeeds", async () => {
  const f = fixture({ grok: { weekly: { usedPercent: 12, resetsAt: 1 }, updatedAt: 1 } });
  const grok = fakeGrok([
    { error: { code: 503, message: "temporary C:\\secret\\grok.exe failure" } },
    { result: grokUsage },
  ]);
  try {
    const first = f.chats.refreshGrokUsage();
    assert.equal(first, f.chats.refreshGrokUsage());
    await first;
    assert.deepEqual(f.chats.usage().grok, { error: "Grok 사용량 조회가 지연되거나 실패했습니다. 네트워크 상태를 확인하고 다시 조회하세요." });

    await f.chats.refreshGrokUsage();
    assert.equal(grok.children.length, 2);
    assert.equal(f.chats.usage().grok?.weekly?.usedPercent, 20);
    assert.equal(typeof f.chats.usage().grok?.updatedAt, "number");
    assert.equal(f.chats.usage().grok?.updatedAt === 1, false);
    assert.deepEqual(grok.requests.map(request => request.method).filter((method: string) => method === "_x.ai/billing").length, 2);
  } finally {
    grok.restore();
    await f.chats.dispose(); f.store.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

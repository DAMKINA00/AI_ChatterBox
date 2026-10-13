// M0 spike: drive Codex through `codex app-server` (JSON-RPC over stdio, one JSON object per line).
//  phase 1: initialize -> thread/start -> 2x turn/start; turn 2 asks for a write command -> approval request -> decline
//  phase 2: new app-server process -> thread/resume -> turn 3 checks context carried over
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findCodex, version, readLines, killTree, waitExit, scratch, log } from "./common.ts";
import type { ClientRequest, ServerNotification, ServerRequest, RequestId, InitializeResponse } from "./codex-schema/index.ts";
import type {
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnCompletedNotification,
  CommandExecutionRequestApprovalResponse,
  ThreadItem,
} from "./codex-schema/v2/index.ts";

const CODEX = findCodex();
const WORK = scratch("codex-work");
const EVENTS = join(scratch("logs"), "codex-events.jsonl");
rmSync(EVENTS, { force: true });
rmSync(join(WORK, "note.txt"), { force: true });

const observed = new Set<string>();
const approvals: { method: string; params: unknown }[] = [];

type Method = ClientRequest["method"];

class AppServer {
  child: ChildProcess;
  private nextId = 1;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private turnWaiters = new Map<string, (n: TurnCompletedNotification) => void>();
  private text = "";

  constructor() {
    log("codex", "spawn", CODEX, "app-server");
    this.child = spawn(CODEX, ["app-server"], { cwd: WORK, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d) => process.stderr.write(`[codex:stderr] ${d}`));
    this.child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`app-server exited (${code})`));
    });
    readLines(this.child, (line) => this.onLine(line));
  }

  private write(msg: object) {
    this.child.stdin!.write(JSON.stringify(msg) + "\n", "utf8");
  }

  request<R>(method: Method, params: unknown): Promise<R> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string) {
    this.write({ method });
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    appendFileSync(EVENTS, line + "\n", "utf8");
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return log("codex", "non-JSON stdout:", line);
    }

    // response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p?.resolve(msg.result);
      return;
    }
    // server -> client request (approvals etc.)
    if (msg.id !== undefined) {
      observed.add(`request ${msg.method}`);
      return this.onServerRequest(msg as ServerRequest);
    }
    observed.add(`notify ${msg.method}`);
    this.onNotification(msg as ServerNotification);
  }

  private onServerRequest(req: ServerRequest) {
    approvals.push({ method: req.method, params: req.params });
    switch (req.method) {
      case "item/commandExecution/requestApproval": {
        log("APPROVAL", `command=${JSON.stringify(req.params.command)} cwd=${req.params.cwd} reason=${req.params.reason ?? ""}`);
        const result: CommandExecutionRequestApprovalResponse = { decision: "decline" };
        log("APPROVAL", "-> decline");
        return this.write({ id: req.id, result });
      }
      case "item/fileChange/requestApproval":
        log("APPROVAL", "fileChange", JSON.stringify(req.params).slice(0, 300), "-> decline");
        return this.write({ id: req.id, result: { decision: "decline" } });
      default:
        log("server-request", req.method, "(unhandled, replying error)");
        return this.write({ id: req.id, error: { code: -32601, message: "not supported by spike" } });
    }
  }

  private onNotification(n: ServerNotification) {
    switch (n.method) {
      case "item/agentMessage/delta":
        this.text += n.params.delta;
        process.stdout.write(n.params.delta);
        break;
      case "item/started":
        log("item/started", describe(n.params.item));
        break;
      case "item/completed":
        log("item/completed", describe(n.params.item));
        break;
      case "turn/started":
        log("turn/started", n.params.turn.id);
        break;
      case "turn/completed":
        process.stdout.write("\n");
        log("turn/completed", n.params.turn.id, n.params.turn.status, n.params.turn.error ? JSON.stringify(n.params.turn.error) : "");
        this.turnWaiters.get(n.params.turn.id)?.(n.params);
        break;
      case "error":
        log("error", JSON.stringify(n.params));
        break;
      case "thread/started":
        log("thread/started", n.params.thread.id);
        break;
      default:
        // token usage, rate limits, reasoning deltas, etc. are recorded in the event log only
        break;
    }
  }

  async initialize() {
    const r = await this.request<InitializeResponse>("initialize", {
      clientInfo: { name: "ai_chatterbox_spike", title: "AI_ChatterBox M0 spike", version: "0.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.notify("initialized");
    log("initialize", JSON.stringify(r));
  }

  async turn(threadId: string, text: string): Promise<{ text: string; done: TurnCompletedNotification }> {
    log("user", text);
    this.text = "";
    const params: TurnStartParams = { threadId, input: [{ type: "text", text, text_elements: [] }] };
    const r = await this.request<TurnStartResponse>("turn/start", params);
    const done = await new Promise<TurnCompletedNotification>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("turn timeout")), 300_000);
      this.turnWaiters.set(r.turn.id, (n) => {
        clearTimeout(t);
        resolve(n);
      });
    });
    return { text: this.text, done };
  }

  async close() {
    this.child.stdin!.end();
    const code = await waitExit(this.child, 5_000);
    log("codex", `exit code=${code} (after stdin EOF${code === null ? ", had to taskkill" : ""})`);
  }
}

function describe(item: ThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return `commandExecution ${JSON.stringify(item.command)} status=${item.status} exit=${item.exitCode}`;
    case "agentMessage":
      return `agentMessage ${JSON.stringify(item.text.slice(0, 80))}`;
    case "fileChange":
      return `fileChange status=${item.status}`;
    default:
      return item.type;
  }
}

async function main() {
  log("version", `codex=${version(CODEX)} (${CODEX})`);
  const checks: Record<string, boolean> = {};

  // ---- phase 1
  const a = new AppServer();
  await a.initialize();
  const startParams: ThreadStartParams = { cwd: WORK, approvalPolicy: "untrusted", sandbox: "read-only" };
  const started = await a.request<ThreadStartResponse>("thread/start", startParams);
  const threadId = started.thread.id;
  log("thread/start", `thread=${threadId} model=${started.model} sandbox=${JSON.stringify(started.sandbox)}`);

  const t1 = await a.turn(threadId, "Remember this codeword: 파인애플-42. Do not run any commands. Reply with exactly: 확인");
  checks["turn1 completed"] = t1.done.turn.status === "completed";
  checks["korean round-trip"] = t1.text.includes("확인");

  const t2 = await a.turn(
    threadId,
    "Run this exact shell command to create a file: echo hi > note.txt . " +
      "If the command is declined or fails, do not retry with anything else; reply with exactly: DENIED",
  );
  checks["approval request received"] = approvals.some((x) => x.method === "item/commandExecution/requestApproval");
  checks["file was not written"] = !existsSync(join(WORK, "note.txt"));
  checks["turn2 completed"] = t2.done.turn.status === "completed";
  await a.close();

  // ---- phase 2: resume from a fresh process
  const b = new AppServer();
  await b.initialize();
  const resumeParams: ThreadResumeParams = { threadId, excludeTurns: true };
  const resumed = await b.request<ThreadResumeResponse>("thread/resume", resumeParams);
  log("thread/resume", `thread=${resumed.thread.id} (same: ${resumed.thread.id === threadId})`);
  const t3 = await b.turn(threadId, "What was the codeword I asked you to remember? Reply with just the codeword.");
  checks["resume carried context"] = t3.text.includes("파인애플-42");
  await b.close();
  killTree(b.child);

  console.log("\n=== observed methods ===\n" + [...observed].sort().join("\n"));
  console.log("\n=== checks ===");
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

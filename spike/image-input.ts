// Spike: can both CLIs take an image in the same long-lived session?
//  Claude: stream-json user message with an image content block (base64)
//  Codex: turn/start input [{type:"localImage", path}]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findClaude, findCodex, readLines, waitExit, scratch, SPIKE_DIR, log } from "./common.ts";

const IMG = join(SPIKE_DIR, "..", "build", "icon.png");
const PROMPT = "이 이미지에 보이는 두 말풍선의 색을 한 줄로 답해.";

async function claude() {
  const child = spawn(findClaude(), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
    cwd: scratch("claude-img"),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const done = new Promise<string>((resolve) =>
    readLines(child, (l) => {
      const ev = JSON.parse(l);
      if (ev.type === "result") resolve(String(ev.result));
    }),
  );
  const data = readFileSync(IMG).toString("base64");
  const msg = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
        { type: "text", text: PROMPT },
      ],
    },
  };
  child.stdin!.write(JSON.stringify(msg) + "\n");
  log("claude", await done);
  child.stdin!.end();
  await waitExit(child);
}

async function codex() {
  const child = spawn(findCodex(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let id = 0;
  const pending = new Map<number, (r: any) => void>();
  let text = "";
  let turnDone!: () => void;
  const finished = new Promise<void>((r) => (turnDone = r));
  readLines(child, (l) => {
    const m = JSON.parse(l);
    if (m.id !== undefined && !m.method) pending.get(m.id)?.(m.result ?? m.error);
    else if (m.id !== undefined) child.stdin!.write(JSON.stringify({ id: m.id, error: { code: -32601, message: "no" } }) + "\n");
    else if (m.method === "item/agentMessage/delta") text += m.params.delta;
    else if (m.method === "turn/completed") turnDone();
  });
  const req = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      child.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n");
    });
  await req("initialize", { clientInfo: { name: "spike", title: null, version: "0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
  child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
  const t = await req("thread/start", { cwd: scratch("codex-img"), approvalPolicy: "untrusted", sandbox: "read-only", ephemeral: true });
  await req("turn/start", {
    threadId: t.thread.id,
    input: [
      { type: "localImage", path: IMG },
      { type: "text", text: PROMPT, text_elements: [] },
    ],
  });
  await finished;
  log("codex", text);
  child.stdin!.end();
  await waitExit(child);
}

await claude();
await codex();

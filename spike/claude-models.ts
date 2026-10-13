// Spike: ask Claude Code for its model list via the stream-json control protocol (initialize).
import { spawn } from "node:child_process";
import { findClaude, readLines, scratch, waitExit } from "./common.ts";

const child = spawn(findClaude(), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
  cwd: scratch("claude-models"),
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const got = new Promise<any>((resolve) =>
  readLines(child, (l) => {
    const ev = JSON.parse(l);
    if (ev.type === "control_response") resolve(ev);
  }),
);
child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "initialize" } }) + "\n");
const r = await Promise.race([got, new Promise((res) => setTimeout(() => res("timeout"), 20000))]);
const resp = (r as any)?.response?.response ?? r;
console.log(JSON.stringify(resp?.models ?? resp, null, 1).slice(0, 3000));
child.stdin!.end();
await waitExit(child);

// Spike: can we get Claude's rate-limit usage without spending a model turn? Try the /usage local command.
import { spawn } from "node:child_process";
import { findClaude, readLines, scratch, waitExit } from "./common.ts";

const child = spawn(findClaude(), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], {
  cwd: scratch("claude-usage"),
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});
const done = new Promise<void>((resolve) =>
  readLines(child, (l) => {
    const ev = JSON.parse(l);
    if (ev.type === "assistant") for (const c of ev.message?.content ?? []) console.log("TEXT:", c.text);
    if (ev.type === "result") console.log("RESULT:", ev.result);
    if (ev.type === "rate_limit_event") console.log("RATE:", JSON.stringify(ev.rate_limit_info));
    if (ev.type === "result") resolve();
  }),
);
child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "/usage" }] } }) + "\n");
await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
child.stdin!.end();
await waitExit(child);

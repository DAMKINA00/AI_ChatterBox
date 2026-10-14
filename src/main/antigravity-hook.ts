// Official CLI hooks forward each proposed action to the owning ChatterBox driver.
import { request } from "node:http";

const phase = process.argv[2];
const fallback = (stage: string) => phase === "pre" ? { decision: "deny", reason: `ChatterBox 승인 연결 실패 (${stage}). 다시 시도하세요.` } : {};
function send(value: unknown) { process.stdout.write(JSON.stringify(value) + "\n"); }
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (s) => { body += s; });
process.stdin.on("end", () => {
  try {
    const url = new URL(process.argv[3] ?? process.env.CHATTERBOX_GEMINI_HOOK_URL ?? "");
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("invalid bridge");
    const data = Buffer.from(JSON.stringify({ name: phase, arguments: JSON.parse(body) }));
    let finished = false;
    const finish = (v: unknown) => { if (!finished) { finished = true; send(v); } };
    const req = request(`${url}/call`, { method: "POST", headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (s) => { text += s; });
      res.on("end", () => {
        try {
          const r = JSON.parse(text);
          const value = JSON.parse(r.content[0].text);
          if (r.isError || (phase === "pre" && !["auto_approve", "deny", "allow"].includes(value.decision))) throw new Error("invalid decision");
          finish(value);
        } catch { finish(fallback("응답 형식")); }
      });
      res.on("error", () => finish(fallback("응답 연결")));
    });
    req.on("error", () => finish(fallback("요청 연결")));
    req.setTimeout(0);
    req.end(data);
  } catch { send(fallback("입력 형식")); }
});

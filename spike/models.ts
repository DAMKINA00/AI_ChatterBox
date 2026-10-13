// Lists the models codex app-server offers (model/list) to pick exact ids.
import { spawn } from "node:child_process";
import { findCodex, readLines } from "./common.ts";

const child = spawn(findCodex(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
let id = 0;
const pending = new Map<number, (r: any) => void>();
readLines(child, (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined && !m.method) pending.get(m.id)?.(m.result ?? m.error);
});
const req = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    child.stdin!.write(JSON.stringify({ id: i, method, params }) + "\n");
  });
await req("initialize", { clientInfo: { name: "spike", title: null, version: "0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
const r = await req("model/list", {});
for (const m of r.data ?? r.models ?? []) console.log(JSON.stringify({ id: m.id, hidden: m.hidden, upgrade: m.upgrade, isDefault: m.isDefault }));
if (!r.data && !r.models) console.log(JSON.stringify(r).slice(0, 2000));
child.stdin!.end();


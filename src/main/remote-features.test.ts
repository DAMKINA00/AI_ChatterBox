import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWeb, isPrivateIp } from "./remote-web";
import { anonymizeAccounts, contentMatches, stripLocalPaths } from "./remote-features";
import { BUSY_STATUSES, chatApprovalChange, checkRemoteSend, listRemoteUploads, mergeProjectSettings, remoteError, removeRemoteUpload, saveRemoteUpload } from "./remote-core";
import { AttachmentStore } from "./attachments";
import { Store } from "./db";
import { normalizeRemoteFileName } from "../shared/remote-web";
import { DEFAULT_SETTINGS } from "../shared/types";

const PASSWORD = "correct horse battery";
const ORIGIN = "https://ai.example.test";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function freePort() {
  const s = createServer();
  await new Promise<void>(ok => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(ok => s.close(() => ok()));
  return port;
}

/**
 * RemoteWeb over a small fake core. The remote:* channels use the real check-and-merge helpers
 * (remote-core.ts) on the fake state, the way core.ts does. `hooks` run before a channel (to simulate
 * desktop changes in between).
 */
async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cbx-features-"));
  const root = join(dir, "root");
  mkdirSync(root);
  mkdirSync(join(root, "existing"));
  const settings = { approvalMode: "orchestrator", delegateHighRisk: false, orchestratorModel: "claude:opus", claudeModel: "opus", maxConsults: 100, maxReviews: 20, maxClaudeWorkers: 3, maxGeminiWorkers: 1, reviewGate: true, accountPolicy: { claude: { mode: "fixed", accountId: "claude-1" } } };
  const state = {
    projects: [{ id: 9, name: "P", folder: "D:\\secret\\P", archived: false, createdAt: 1, settings: { ...settings } }, { id: 8, name: "Old", folder: "D:\\x", archived: true, createdAt: 1, settings: { ...settings } }] as any[],
    chats: [{ id: 1, projectId: 9, title: "작업", status: "idle", approvalModeOverride: null }, { id: 2, projectId: 9, title: "실행중", status: "working", approvalModeOverride: null }] as any[],
    attachments: new Map<number, any>([[50, { id: 50, name: "old.png", mime: "image/png", size: PNG.length, path: join(dir, "old.png") }]]),
    nextId: 100,
  };
  writeFileSync(join(dir, "old.png"), PNG);
  // Uploads run on a real SQLite store and attachment folder (chats 1 and 2 exist there too).
  const store = new Store(join(dir, "t.db"));
  const project = store.createProject("P", dir, DEFAULT_SETTINGS);
  store.createChat(project.id, "작업"); store.createChat(project.id, "실행중");
  const files = new AttachmentStore(join(dir, "attachments"), store);
  let free = 100 * 1024 ** 3;
  files.diskFree = () => free;
  const calls: [string, unknown[]][] = [];
  const hooks: Record<string, () => void> = {};
  const call = async (channel: string, args: any[]): Promise<any> => {
    calls.push([channel, args]);
    hooks[channel]?.();
    switch (channel) {
      case "chats:list": return state.chats;
      case "projects:list": return state.projects;
      case "chats:create": { const c = { id: state.nextId++, projectId: args[0], title: "새 채팅", status: "idle", approvalModeOverride: null }; state.chats.push(c); return c; }
      case "chats:update": { const c = state.chats.find(x => x.id === args[0]); Object.assign(c, args[1]); return c; }
      case "remote:chat-patch": {
        const c = state.chats.find(x => x.id === args[0]);
        if (!c) throw remoteError(404, "채팅이 없습니다.");
        const approvalChange = chatApprovalChange(c, state.projects.find(p => p.id === c.projectId).settings, args[1], args[2]);
        Object.assign(c, args[1]);
        return { chat: c, approvalChange };
      }
      case "remote:project-patch": {
        const p = state.projects.find(x => x.id === args[0]);
        const merged = args[1].settings ? mergeProjectSettings(p.settings, args[1].settings, args[2]) : undefined;
        if (args[1].name !== undefined) p.name = args[1].name;
        if (args[1].archived !== undefined) p.archived = args[1].archived;
        if (merged) p.settings = merged.settings;
        return { project: p, approvalChange: merged?.approvalChange };
      }
      case "remote:chat-delete": {
        const c = state.chats.find(x => x.id === args[0]);
        if (!c) throw remoteError(404, "채팅이 없습니다.");
        if (c.title !== args[1]) throw remoteError(400, "제목 불일치");
        if (BUSY_STATUSES.includes(c.status)) throw remoteError(409, "작업 중");
        state.chats = state.chats.filter(x => x.id !== args[0]);
        return;
      }
      case "remote:uploads": return listRemoteUploads(store, files, args[0]);
      case "remote:attachment-remove": return removeRemoteUpload(store, files, args[0], args[1]);
      case "remote:send": {
        const [chatId, text, keys] = args;
        const ids = checkRemoteSend(store, files, chatId, keys);
        store.addUserEvent(chatId, { type: "user", text, attachments: store.attachmentsFor(ids) }, ids); // as chats.send does before its first await
        return;
      }
      case "chats:events": return [...(args[0] === 1 ? [{ id: 7, chatId: 1, node: "orch", role: null, at: 1, event: { type: "user", text: "x", attachments: [state.attachments.get(50)] } }] : []), ...store.events(args[0])];
      case "chats:agents": case "chats:consults": return [];
      case "models:list": return args[0] === "claude" ? [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] : [{ id: "m1", label: "M1" }];
      case "projects:create": { const p = { id: state.nextId++, name: args[0].name, folder: args[0].folder, archived: false, createdAt: 2, settings: args[0].settings }; state.projects.push(p); return p; }
      case "remote:att-bytes": await new Promise(ok => setTimeout(ok, 20)); return saveRemoteUpload(store, files, args[0], args[1], args[2], args[3], args[4]);
      case "attachment:info": return state.attachments.get(args[0]) ?? store.attachment(args[0]);
      case "usage:get": return { claude: { fiveHour: null } };
      case "cli-accounts:list": return [{ accountId: "claude-1", kind: "claude", label: "C1", enabled: true, isDefault: true, authStatus: "authenticated", runningWorkers: 0, configDir: "C:\\Users\\x\\.claude", auth: { loggedIn: true, email: "me@example.com", checkedAt: 1 } }];
      case "chats:search": return [1];
      case "aistudio:usage": return { from: "a", to: "b", generatedAt: "c", totals: { requests: 2 }, groups: { account: [{ key: "alice@example.com", requests: 1 }, { key: "bob@example.com", requests: 1 }], model: [], channel: [] } };
      default: return { ok: true };
    }
  };
  const remote = new RemoteWeb({ file: join(dir, "remote-web.json"), staticDir: dir, call, sleep: async () => {} });
  const port = await freePort();
  await remote.action("set-password", { password: PASSWORD });
  await remote.action("update", { enabled: true, port, publicOrigin: ORIGIN });
  t.after(async () => { await remote.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const login = async () => {
    const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
    return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], csrf: (await r.json() as { csrf: string }).csrf };
  };
  const session = await login();
  const { cookie, csrf } = session;
  const get = (path: string, auth = true, signal?: AbortSignal) => fetch(base + path, { headers: auth ? { cookie } : {}, signal });
  const post = (path: string, body: unknown = {}, opts: { auth?: boolean; csrf?: boolean; as?: typeof session } = {}) => fetch(base + path, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, ...(opts.auth === false ? {} : { cookie: (opts.as ?? session).cookie }), ...(opts.csrf === false ? {} : { "x-csrf-token": (opts.as ?? session).csrf }) },
  });
  const status = async (r: Promise<Response>) => (await r).status;
  const up = (name: string, data: Buffer, chat = 1, as = session) => post(`/api/chats/${chat}/attachments`, { name, mime: "", data: data.toString("base64") }, { as });
  /** An upload whose body never finishes: headers and a few bytes, then the connection stays open. */
  const hang = (as = session, length = 4096) => new Promise<ClientRequest>((ok, fail) => {
    const r = httpRequest(`${base}/api/chats/1/attachments`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: as.cookie, "x-csrf-token": as.csrf, "content-length": String(length) } });
    r.on("error", () => {}); // destroyed by the test
    r.on("response", res => fail(new Error(`answered ${res.statusCode}`)));
    r.write('{"name":"x.txt","mime":"","data":"');
    r.flushHeaders();
    setTimeout(() => ok(r), 150);
  });
  const inFlight = () => (remote as any).features.uploadsInFlight as { count: number; bytes: number };
  return { dir, root, remote, state, store, files, calls, hooks, get, post, status, up, login, hang, inFlight, setFree: (n: number) => { free = n; } };
}

const GETS = ["/api/search?q=a", "/api/models?agent=claude", "/api/projects", "/api/usage", "/api/aistudio/usage", "/api/attachments/50?chat=1"];
const POSTS = ["/api/chats", "/api/chats/1/update", "/api/chats/1/delete", "/api/chats/1/viewed", "/api/chats/1/pause", "/api/chats/1/resume",
  "/api/chats/1/dismiss-interrupted", "/api/chats/1/command", "/api/chats/1/attachments", "/api/chats/1/send", "/api/attachments/50/remove", "/api/projects", "/api/projects/9/update"];

test("every new endpoint needs a session, and every new POST needs the CSRF token", async (t) => {
  const s = await setup(t);
  for (const p of GETS) assert.equal(await s.status(s.get(p, false)), 401, p);
  for (const p of POSTS) assert.equal(await s.status(s.post(p, {}, { auth: false })), 401, p);
  for (const p of POSTS) assert.equal(await s.status(s.post(p, {}, { csrf: false })), 403, p);
  assert.ok(!s.calls.some(([c]) => !["chats:list", "projects:list"].includes(c)), "nothing reached the core");
});

test("chats: create, rename/archive, model and approval checks (D3), commands and simple actions", async (t) => {
  const s = await setup(t);
  assert.equal(await s.status(s.post("/api/chats", { projectId: 9 })), 201);
  assert.ok(s.calls.some(([c, a]) => c === "chats:update" && (a as any[])[1] && Object.keys((a as any[])[1]).length === 0), "creation is announced via chats:update");
  assert.equal(await s.status(s.post("/api/chats", { projectId: 8 })), 409);
  assert.equal(await s.status(s.post("/api/chats/1/update", { title: "새 이름", archived: true })), 200);
  assert.equal(await s.status(s.post("/api/chats/1/update", { status: "done" })), 400);
  assert.equal(await s.status(s.post("/api/chats/1/update", { claudeModelOverride: "made-up" })), 400);
  assert.equal(await s.status(s.post("/api/chats/1/update", { claudeModelOverride: "sonnet", orchestratorModelOverride: "claude:opus", claudeEffortOverride: "high" })), 200);
  assert.equal(await s.status(s.post("/api/chats/1/update", { approvalModeOverride: "toString" })), 400);
  assert.equal(await s.status(s.post("/api/chats/1/update", { approvalModeOverride: "orchestrator-all" })), 428);
  assert.equal(await s.status(s.post("/api/chats/1/update", { approvalModeOverride: "orchestrator-all", confirm: true })), 200);
  assert.equal(await s.status(s.post("/api/chats/1/update", { approvalModeOverride: "user" })), 200, "less autonomy needs no confirmation");
  assert.ok(s.remote.status().audit!.some(a => a.action === "chat.approvalMode" && a.detail === "orchestrator → orchestrator-all"));
  assert.equal(await s.status(s.post("/api/chats/1/command", { name: "plan", arg: "계획" })), 200);
  assert.equal(await s.status(s.post("/api/chats/1/command", { name: "rm", arg: "" })), 400);
  for (const a of ["viewed", "pause", "resume", "dismiss-interrupted"]) assert.equal(await s.status(s.post(`/api/chats/1/${a}`)), 200, a);
  assert.equal(await s.status(s.post("/api/chats/999/pause")), 404);
  assert.deepEqual(await (await s.get("/api/search?q=x")).json(), { chatIds: [1] });
  assert.equal(await s.status(s.get("/api/models?agent=bogus")), 400);
});

test("#1 D3: a chat's autonomy is compared with its state at save time, not when the request arrived", async (t) => {
  const s = await setup(t);
  // The desktop sets the chat to "user" while the remote request (model check) is in flight.
  s.hooks["models:list"] = () => { s.state.chats[0].approvalModeOverride = "user"; };
  assert.equal(await s.status(s.post("/api/chats/1/update", { approvalModeOverride: "orchestrator", claudeModelOverride: "opus" })), 428);
  assert.equal(s.state.chats[0].approvalModeOverride, "user");
});

test("#1 D3/D5: project settings merge only the sent keys into the settings as they are at save time", async (t) => {
  const s = await setup(t);
  const p = s.state.projects[0];
  // While the remote request awaits the model list, the desktop lowers autonomy and changes the account policy.
  s.hooks["models:list"] = () => { p.settings = { ...p.settings, approvalMode: "user", accountPolicy: { claude: { mode: "auto" } } }; };
  assert.equal(await s.status(s.post("/api/projects/9/update", { settings: { claudeModel: "sonnet", maxConsults: 50 } })), 200);
  assert.equal(p.settings.approvalMode, "user", "desktop approval change kept");
  assert.deepEqual(p.settings.accountPolicy, { claude: { mode: "auto" } }, "desktop account policy kept");
  assert.equal(p.settings.claudeModel, "sonnet");
  assert.equal(p.settings.maxConsults, 50);
  // Raising from the current value still needs confirmation; desktop-only keys never pass the core merge.
  assert.equal(await s.status(s.post("/api/projects/9/update", { settings: { approvalMode: "orchestrator" } })), 428);
  assert.deepEqual(mergeProjectSettings(p.settings, { accountPolicy: {}, folder: "C:\\" } as any, false).settings.accountPolicy, { claude: { mode: "auto" } });
  assert.equal(await s.status(s.post("/api/projects/9/update", { settings: { accountPolicy: {} } })), 400);
  assert.equal(await s.status(s.post("/api/projects/9/update", { folder: "C:\\" })), 400);
  assert.equal(await s.status(s.post("/api/projects/9/delete")), 404, "D2: no remote project delete");
});

test("#2 numeric settings follow the desktop ranges", async (t) => {
  const s = await setup(t);
  const set = (settings: Record<string, unknown>) => s.status(s.post("/api/projects/9/update", { settings }));
  for (const [k, v] of [["maxClaudeWorkers", 0], ["maxClaudeWorkers", 7], ["maxGptWorkers", 999], ["maxGeminiWorkers", -1], ["maxGeminiWorkers", 7], ["maxConsults", 0], ["maxConsults", 1000], ["maxReviews", 100], ["maxClaudeWorkers", 2.5]] as const)
    assert.equal(await set({ [k]: v }), 400, `${k}=${v}`);
  for (const [k, v] of [["maxClaudeWorkers", 1], ["maxClaudeWorkers", 6], ["maxGeminiWorkers", 0], ["maxGeminiWorkers", 6], ["maxConsults", 1], ["maxConsults", 999], ["maxReviews", 0], ["maxReviews", 99]] as const)
    assert.equal(await set({ [k]: v }), 200, `${k}=${v}`);
});

test("#5 D8: delete needs the exact title and the core refuses a chat that became busy meanwhile", async (t) => {
  const s = await setup(t);
  assert.equal(await s.status(s.post("/api/chats/1/delete", { confirm: "작업 " })), 400);
  assert.equal(await s.status(s.post("/api/chats/2/delete", { confirm: "실행중" })), 409);
  // Work starts on the desktop right before the core step: still refused, nothing deleted, nothing stopped.
  s.hooks["remote:chat-delete"] = () => { s.state.chats[0].status = "working"; };
  assert.equal(await s.status(s.post("/api/chats/1/delete", { confirm: "작업" })), 409);
  assert.ok(s.state.chats.some(c => c.id === 1) && !s.calls.some(([c]) => c === "chats:stop" || c === "chats:delete"));
  delete s.hooks["remote:chat-delete"];
  s.state.chats[0].status = "idle";
  assert.equal(await s.status(s.post("/api/chats/1/delete", { confirm: "작업" })), 200);
  assert.ok(!s.state.chats.some(c => c.id === 1));
  assert.equal(s.remote.status().audit![0].action, "chat.delete");
});

test("#6 chat:deleted and projects:updated reach other web sessions over SSE", async (t) => {
  const s = await setup(t);
  const controller = new AbortController();
  const res = await s.get("/api/stream", true, controller.signal);
  const reader = res.body!.getReader();
  let received = "";
  const until = async (re: RegExp) => { while (!re.test(received)) received += new TextDecoder().decode((await reader.read()).value); };
  await until(/retry/);
  await s.post("/api/projects/9/update", { name: "새 이름" });
  await until(/event: projects:updated\ndata: \[\]/);
  await s.post("/api/chats/1/delete", { confirm: "작업" });
  await until(/event: chat:deleted\ndata: \[1\]/);
  controller.abort();
});

test("#3 stored limits: 10 unsent per chat, 30 MB per chat, checked one upload at a time; removing deletes the file", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 9; i++) assert.equal(await s.status(s.up(`n${i}.txt`, Buffer.from("hi"))), 201);
  // The last slot, raced by four uploads from two sessions (the in-flight limits allow that many): one wins.
  const other = await s.login();
  const raced = await Promise.all([s.up("r0.txt", Buffer.from("hi")), s.up("r1.txt", Buffer.from("hi")), s.up("r2.txt", Buffer.from("hi"), 1, other), s.up("r3.txt", Buffer.from("hi"), 1, other)].map(s.status));
  assert.deepEqual(raced.sort(), [201, 409, 409, 409], String(raced));
  const [first] = s.store.unsentAttachments(1);
  assert.ok(existsSync(first.path));
  assert.equal(await s.status(s.post(`/api/attachments/${first.id}/remove`, { uuid: first.uuid })), 200);
  assert.ok(!existsSync(first.path) && !s.store.attachment(first.id), "the record goes, then its file at once");
  // Byte budget: 30 MB pending per chat.
  const big = Buffer.alloc(10 * 1024 * 1024, 0x61);
  const s2 = await setup(t);
  for (let i = 0; i < 3; i++) assert.equal(await s2.status(s2.up(`b${i}.txt`, big)), 201);
  assert.equal(await s2.status(s2.up("b3.txt", Buffer.from("x"))), 413);
});

test("E: uploads are admitted before their body is read (count, per session, bytes) and released on disconnect", async (t) => {
  const s = await setup(t);
  const settle = () => new Promise(ok => setTimeout(ok, 200));
  // Per session: two at once.
  const mine = [await s.hang(), await s.hang()];
  assert.deepEqual(s.inFlight(), { count: 2, bytes: 8192 });
  const third = await s.up("x.txt", Buffer.from("hi"));
  assert.equal(third.status, 429);
  assert.ok(third.headers.get("retry-after"));
  // Globally: four at once, whoever sends them.
  const b = await s.login(), c = await s.login();
  const theirs = [await s.hang(b), await s.hang(b)];
  assert.equal(s.inFlight().count, 4);
  assert.equal(await s.status(s.up("y.txt", Buffer.from("hi"), 1, c)), 429);
  for (const r of [...mine, ...theirs]) r.destroy();
  await settle();
  assert.deepEqual(s.inFlight(), { count: 0, bytes: 0 }, "closed connections release their reservations");
  // A declared body over the per-upload limit is refused before reading.
  assert.equal(await s.hang(c, 59 * 1024 * 1024).then(r => { r.destroy(); return "admitted"; }, (e: Error) => e.message), "answered 413");
  // Bytes: two near-limit bodies fit in 40 MB, a third does not (although the count would allow it).
  const near = [await s.hang(await s.login(), 14_000_000), await s.hang(b, 14_000_000)];
  assert.equal(s.inFlight().count, 2);
  assert.equal(await s.hang(c, 14_000_000).then(r => { r.destroy(); return "admitted"; }, (e: Error) => e.message), "answered 429");
  for (const r of near) r.destroy();
  await settle();
  assert.deepEqual(s.inFlight(), { count: 0, bytes: 0 });
  // Afterwards a normal upload goes through, and releases too.
  assert.equal(await s.status(s.up("ok.txt", Buffer.from("hi"))), 201);
  assert.deepEqual(s.inFlight(), { count: 0, bytes: 0 });
});

test("total remote-upload storage (desktop setting, 0.1–20 GB) and the 5 GB free-disk floor answer 507", async (t) => {
  const s = await setup(t);
  assert.equal(s.remote.status().uploadStorageGb, 2, "default 2 GB");
  for (const gb of [0.05, 21, Number.NaN]) await assert.rejects(s.remote.action("update", { uploadStorageGb: gb }), /0\.1~20GB/, String(gb));
  assert.equal((await s.remote.action("update", { uploadStorageGb: 0.1 })).uploadStorageGb, 0.1);
  // Sent uploads count: fill the 0.1 GB with sent 10 MB files, then the next upload is refused.
  const ten = Buffer.alloc(10 * 1024 * 1024, 0x61);
  for (let i = 0; i < 10; i++) {
    const { attachment } = await (await s.up(`f${i}.txt`, ten)).json() as any;
    assert.equal(await s.status(s.post("/api/chats/1/send", { text: "", attachments: [{ id: attachment.id, uuid: attachment.uuid }] })), 200);
  }
  const full = await s.up("more.txt", ten);
  assert.equal(full.status, 507);
  assert.match((await full.json() as any).error, /저장 공간\(0\.1GB\)이 가득/);
  await s.remote.action("update", { uploadStorageGb: 1 });
  assert.equal(await s.status(s.up("more.txt", Buffer.from("hi"))), 201, "a larger setting takes effect at once");
  s.setFree(5 * 1024 ** 3);
  const low = await s.up("low.txt", Buffer.from("hi"));
  assert.equal(low.status, 507);
  assert.match((await low.json() as any).error, /5GB 미만/);
});

test("#4 uploads: Windows-normalized names, allow-listed extensions, server-side type and magic bytes", async (t) => {
  const s = await setup(t);
  for (const name of ["run.py", "mod.psm1", "x.ps1", "x.bat", "x.sh", "x.js", "x.exe", "pic.svg", "pic.bmp", "x", "x.txt.ps1", "x.ps1 .", "x.ps1..."])
    assert.equal(await s.status(s.up(name, Buffer.from("print(1)"))), 415, name);
  for (const name of ["a.txt:evil.ps1", "con.txt", "COM1.md", "a\\b.txt", "../a.txt"])
    assert.equal(await s.status(s.up(name, Buffer.from("x"))), 400, name);
  assert.equal(await s.status(s.up("fake.png", Buffer.from("not a png"))), 415);
  assert.equal(await s.status(s.up("bin.txt", Buffer.from([0x61, 0, 0x62]))), 415);
  const ok = await s.up("note.txt. ", Buffer.from("hello"));
  assert.equal(ok.status, 201);
  const row = s.store.unsentAttachments(1).at(-1)!;
  assert.deepEqual((await ok.json() as any).attachment, { id: row.id, uuid: row.uuid, name: "note.txt", mime: "text/plain", size: 5 });
  assert.equal((await (await s.up("p.png", PNG)).json() as any).attachment.mime, "image/png", "the server sets the type from the extension");
  assert.deepEqual(normalizeRemoteFileName("report.md.  "), { name: "report.md", ext: ".md" });
  assert.equal(normalizeRemoteFileName("lpt9.txt"), null);
});

test("the attachment list is the server's truth; a stale {id, uuid} after id reuse answers 409 for send and remove", async (t) => {
  const s = await setup(t);
  const list = async (chat = 1) => (await (await s.get(`/api/chats/${chat}/attachments`)).json() as any).attachments;
  const a = (await (await s.up("a.txt", Buffer.from("a"))).json() as any).attachment;
  assert.deepEqual(await list(), [a]);
  assert.deepEqual(await list(2), []);
  assert.equal(await s.status(s.get("/api/chats/77/attachments")), 404);
  // Another session removes it and uploads a new file, which SQLite gives the same id.
  const other = await s.login();
  assert.equal(await s.status(s.post(`/api/attachments/${a.id}/remove`, { uuid: a.uuid }, { as: other })), 200);
  const b = (await (await s.up("b.txt", Buffer.from("b"), 1, other)).json() as any).attachment;
  assert.equal(b.id, a.id);
  // The first session still holds {a.id, a.uuid}.
  const r = await s.post("/api/chats/1/send", { text: "x", attachments: [{ id: a.id, uuid: a.uuid }] });
  assert.equal(r.status, 409);
  assert.match((await r.json() as any).error, /새로 고친/);
  assert.equal(await s.status(s.post(`/api/attachments/${a.id}/remove`, { uuid: a.uuid })), 409);
  assert.deepEqual(await list(), [b], "the new upload is untouched; the refreshed list shows it");
  assert.equal(s.store.events(1).length, 0, "nothing was sent");
  assert.equal(await s.status(s.post(`/api/attachments/${b.id}/remove`, {})), 400, "remove needs the uuid");
});

test("D4: send and remove only accept this chat's pending remote uploads, named by {id, uuid}", async (t) => {
  const s = await setup(t);
  const { attachment: a } = await (await s.up("a.png", PNG)).json() as any;
  const key = { id: a.id, uuid: a.uuid };
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "", attachments: [] })), 400);
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "x", attachments: [key, key] })), 400, "duplicates");
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "x", attachments: [{ id: a.id }] })), 400, "no uuid");
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "x", attachmentIds: [a.id] })), 400, "the old id-only form");
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "", attachments: [{ id: 50, uuid: a.uuid }] })), 409, "not a pending remote upload");
  assert.equal(await s.status(s.post("/api/chats/2/send", { text: "x", attachments: [key] })), 409, "other chat");
  assert.equal(await s.status(s.get(`/api/attachments/${a.id}?chat=1`)), 404, "an unsent upload needs its uuid to be downloaded");
  assert.equal(await s.status(s.get(`/api/attachments/${a.id}?chat=1&uuid=${a.uuid}`)), 200);
  assert.equal(await s.status(s.post(`/api/attachments/${a.id}/remove`, { uuid: a.uuid })), 200);
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "", attachments: [key] })), 409, "removed meanwhile");
  const { attachment: again } = await (await s.up("a.png", PNG)).json() as any;
  assert.equal(await s.status(s.post("/api/chats/1/send", { text: "", attachments: [{ id: again.id, uuid: again.uuid }] })), 200);
  assert.equal(await s.status(s.post(`/api/attachments/${again.id}/remove`, { uuid: again.uuid })), 404, "already sent");
  assert.equal(await s.status(s.get(`/api/attachments/${again.id}?chat=1`)), 200, "a sent upload is downloadable from the history");
  assert.equal(s.store.attachment(again.id)!.path, join(s.files.remoteDir, `${again.uuid}.png`), "and still in remote-pending (nothing moved)");
});

test("attachment downloads need the owning chat; images inline, others as downloads", async (t) => {
  const s = await setup(t);
  assert.equal(await s.status(s.get("/api/attachments/50")), 400);
  assert.equal(await s.status(s.get("/api/attachments/50?chat=2")), 404);
  const r = await s.get("/api/attachments/50?chat=1");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-disposition")!, /^inline/);
  assert.match(r.headers.get("content-security-policy")!, /sandbox/);
  const txt = await (await s.up("n.txt", Buffer.from("hi"))).json() as any;
  const d = await s.get(`/api/attachments/${txt.attachment.id}?chat=1&uuid=${txt.attachment.uuid}`);
  assert.equal(d.headers.get("content-type"), "application/octet-stream");
  assert.match(d.headers.get("content-disposition")!, /^attachment/);
});

test("#7 usage and AI Studio usage carry no emails or folders; refresh is rate limited; snapshots strip paths", async (t) => {
  const s = await setup(t);
  const usage = await (await s.get("/api/usage")).json();
  assert.ok(!JSON.stringify(usage).includes("@example.com") && !JSON.stringify(usage).includes(".claude"));
  assert.equal(await s.status(s.get("/api/usage?refresh=1")), 200);
  assert.equal(await s.status(s.get("/api/usage?refresh=1")), 429);
  assert.equal(await s.status(s.get("/api/aistudio/usage?range=1y")), 400);
  const studio = await (await s.get("/api/aistudio/usage?range=7d")).json() as any;
  assert.ok(!JSON.stringify(studio).includes("@"), JSON.stringify(studio));
  assert.deepEqual(studio.report.groups.account.map((g: any) => g.key), ["계정 1", "계정 2"]);
  assert.equal(anonymizeAccounts({ groups: { account: [{ key: "x@y" }] } } as any).groups.account[0].key, "계정 1");
  const snap = await (await s.get("/api/chats/1")).json() as any;
  assert.deepEqual(Object.keys(snap.events[0].event.attachments[0]).sort(), ["id", "mime", "name", "size"]);
  assert.deepEqual(stripLocalPaths({ a: [{ id: 1, name: "n", mime: "m", size: 1, path: "C:\\x" }], path: "kept-not-attachment" }), { a: [{ id: 1, name: "n", mime: "m", size: 1 }], path: "kept-not-attachment" });
});

test("D1: projects only as one new folder under an allowed root; no paths in answers", async (t) => {
  const s = await setup(t);
  const list = await (await s.get("/api/projects")).json() as any;
  assert.deepEqual(list.roots, []);
  assert.ok(!JSON.stringify(list).includes("secret") && !("folder" in list.projects[0]) && !("accountPolicy" in list.projects[0].settings));
  assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId: "x", folderName: "new" })), 409, "no root configured = off");
  await s.remote.action("update", { projectRoots: [{ id: "", label: "작업", path: s.root }] });
  const rootId = ((await (await s.get("/api/projects")).json()) as any).roots[0].id;
  for (const bad of ["..", "../x", "a/b", "a\\b", ".hidden", "con", "C:", " x", "x".repeat(65)])
    assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId, folderName: bad })), 400, bad);
  assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId, folderName: "existing" })), 409);
  const ok = await s.post("/api/projects", { name: "새 프로젝트", rootId, folderName: "fresh" });
  assert.equal(ok.status, 201);
  assert.ok(existsSync(join(s.root, "fresh")));
  assert.ok(!JSON.stringify(await ok.json()).includes(s.root));
  await assert.rejects(s.remote.action("update", { projectRoots: [{ id: "", label: "", path: join(s.dir, "missing") }] }), /찾을 수 없습니다/);
});

test("#4 D1: a root saved before pinning (no real path / file id) is refused until re-registered", async (t) => {
  const s = await setup(t);
  (s.remote as any).config.projectRoots = [{ id: "legacy", label: "예전", path: s.root }];
  assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId: "legacy", folderName: "x" })), 409);
  assert.ok(!existsSync(join(s.root, "x")));
  // Saving the list again (desktop re-registration) pins it, and creation works.
  await s.remote.action("update", { projectRoots: [{ id: "", label: "예전", path: s.root }] });
  assert.ok(s.remote.status().projectRoots![0].fileId);
  const rootId = s.remote.status().projectRoots![0].id;
  assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId, folderName: "x" })), 201);
});

test("#8 D1: a root swapped for a junction after registration is refused", async (t) => {
  const s = await setup(t);
  await s.remote.action("update", { projectRoots: [{ id: "", label: "작업", path: s.root }] });
  const rootId = ((await (await s.get("/api/projects")).json()) as any).roots[0].id;
  const elsewhere = join(s.dir, "elsewhere");
  mkdirSync(elsewhere);
  renameSync(s.root, join(s.dir, "root-old"));
  symlinkSync(elsewhere, s.root, "junction");
  assert.equal(await s.status(s.post("/api/projects", { name: "N", rootId, folderName: "escape" })), 409);
  assert.ok(!existsSync(join(elsewhere, "escape")));
});

test("content sniffing rejects executables, SVG/other images and mismatched types; private IP ranges", () => {
  assert.equal(contentMatches("image/png", PNG), true);
  assert.equal(contentMatches("application/pdf", Buffer.from("%PDF-1.7")), true);
  assert.equal(contentMatches("application/pdf", Buffer.from("MZ%PDF")), false);
  assert.equal(contentMatches("image/svg+xml", Buffer.from("<svg/>")), false);
  assert.equal(contentMatches("image/bmp", Buffer.from("BM")), false);
  assert.equal(contentMatches("text/plain", Buffer.from([0x61, 0, 0x62])), false);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.144", "::1", "::ffff:192.168.1.2", "fd00::1", "fe80::1"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "220.94.146.33", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8"]) assert.equal(isPrivateIp(ip), false, ip);
});

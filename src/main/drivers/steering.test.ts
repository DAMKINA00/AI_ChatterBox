import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "./claude";
import { CodexDriver } from "./codex";

const opts = { cwd: process.cwd(), nativeId: null, exePath: "unused" };

function codex() {
  const calls: { method: string; params: any }[] = [];
  const server: any = {
    loaded: new Set(),
    ensure: async () => {},
    attach() {},
    detach() {},
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return { thread: { id: "thread" }, turn: { id: "turn" } };
    },
    respond() {},
  };
  const driver = new CodexDriver({ ...opts }, server, { nativeId() {}, emit() {}, approve: async () => ({ verdict: "allow_chat" }) });
  return { driver, calls };
}

function claude() {
  const events: any[] = [];
  const writes: string[] = [];
  const driver: any = new ClaudeDriver({ ...opts }, {} as any, {
    emit: (event: any) => events.push(event),
    nativeId() {},
    approve: async () => ({ verdict: "allow_chat" }),
  });
  driver.child = {
    stdin: {
      writable: true,
      write(value: string) {
        writes.push(value);
        return true;
      },
    },
  };
  driver._running = true;
  driver.onLine(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.286" }));
  return { driver, events, writes };
}

function attachment(id: number, name: string, mime: string, path: string) {
  return { id, name, mime, size: 1, path };
}

test("Codex steer sends the active turn id and separates images from file notes", async () => {
  const f = codex();
  await f.driver.send({ text: "first", attachments: [] });
  const image = attachment(1, "screen.png", "image/png", "C:/tmp/screen.png");
  const document = attachment(2, "notes.txt", "text/plain", "C:/tmp/notes.txt");

  assert.equal(await f.driver.steer({ text: "continue", attachments: [image, document] }), true);
  const steer = f.calls.at(-1)!;
  assert.equal(steer.method, "turn/steer");
  assert.equal(steer.params.threadId, "thread");
  assert.equal(steer.params.expectedTurnId, "turn");
  assert.deepEqual(steer.params.input, [
    { type: "localImage", path: image.path },
    { type: "text", text: `continue\n\n[첨부 파일]\n- ${document.name}: ${document.path}\n(필요하면 위 경로의 파일을 읽어서 참고하세요.)`, text_elements: [] },
  ]);
});

test("Codex steer returns false while idle and after stop", async () => {
  const idle = codex();
  assert.equal(await idle.driver.steer({ text: "idle", attachments: [] }), false);

  const active = codex();
  await active.driver.send({ text: "running", attachments: [] });
  await active.driver.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.driver.running, true);
  assert.equal(await active.driver.steer({ text: "after stop", attachments: [] }), false);
});

test("Claude enables steering only from version 2.1.286", () => {
  for (const [version, expected] of [["2.1.285", false], ["2.1.286", true], ["2.2.0", true]] as const) {
    const f = claude();
    f.driver.canSteer = false;
    f.driver.onLine(JSON.stringify({ type: "system", subtype: "init", claude_code_version: version }));
    assert.equal(f.driver.canSteer, expected, version);
  }
});

test("Claude steer writes a priority-now human UUID with image and file input", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "chatterbox-steering-"));
  const imagePath = join(fixture, "screen.png");
  writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
  try {
    const f = claude();
    const image = attachment(1, "screen.png", "image/png", imagePath);
    const document = attachment(2, "notes.txt", "text/plain", join(fixture, "notes.txt"));
    assert.equal(await f.driver.steer({ text: "follow up", attachments: [image, document] }), true);

    const message = JSON.parse(f.writes[0]);
    assert.match(message.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(message.priority, "now");
    assert.deepEqual(message.origin, { kind: "human" });
    assert.equal(message.client_composed, true);
    assert.equal(message.message.role, "user");
    assert.equal(message.message.content[0].type, "image");
    assert.equal(message.message.content[0].source.media_type, "image/png");
    assert.equal(message.message.content[0].source.data, Buffer.from([137, 80, 78, 71]).toString("base64"));
    assert.equal(message.message.content[1].type, "text");
    assert.match(message.message.content[1].text, /notes\.txt/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Claude holds turn_end until every steer UUID is returned", async () => {
  const f = claude();
  await f.driver.steer({ text: "one", attachments: [] });
  await f.driver.steer({ text: "two", attachments: [] });
  const ids = f.writes.map((line) => JSON.parse(line).uuid);

  f.driver.onLine(JSON.stringify({ type: "result", user_message_uuids: [ids[0], "unrelated"] }));
  assert.equal(f.driver.running, true);
  assert.equal(f.events.some((event: any) => event.type === "turn_end"), false);

  f.driver.onLine(JSON.stringify({ type: "result", user_message_uuids: [ids[1]] }));
  assert.equal(f.driver.running, false);
  assert.deepEqual(f.events.at(-1), { type: "turn_end", ok: true, interrupted: false });
});

test("Claude stop sends an interrupt that cancels queued steering", async () => {
  const f = claude();
  let scheduled: (() => void) | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (callback: () => void) => {
    scheduled = callback;
    return 0;
  };
  try {
    await f.driver.stop();
    const control = JSON.parse(f.writes.at(-1)!);
    assert.equal(control.type, "control_request");
    assert.equal(control.request.subtype, "interrupt");
    assert.equal(control.request.cancel_queued, true);
    assert.match(control.request_id, /^[0-9a-f-]{36}$/i);
    assert.ok(scheduled);

    f.driver.onLine(JSON.stringify({ type: "result", user_message_uuids: [] }));
    assert.equal(f.driver.running, false);
    assert.deepEqual(f.events.at(-1), { type: "turn_end", ok: false, interrupted: true });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

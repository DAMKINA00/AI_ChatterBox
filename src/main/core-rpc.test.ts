import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreRpc } from "./core-rpc";

async function pair(wrongToken = false) {
  const token = randomBytes(32).toString("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\cbx-rpc-test-${token}` : join(tmpdir(), `cbx-${token.slice(0, 16)}.sock`);
  const server = createServer();
  server.listen(address);
  await once(server, "listening");
  const incoming = once(server, "connection");
  const socket = connect(address);
  const client = new CoreRpc(socket, wrongToken ? "wrong" : token, true);
  const [accepted] = await incoming;
  const host = new CoreRpc(accepted, token);
  return { client, host, socket, async close() {
    client.close(); host.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("private pipe rejects the wrong launch token before running a handler", async () => {
  const p = await pair(true);
  let called = false;
  p.host.handle("write", () => { called = true; });
  try {
    await assert.rejects(p.client.call("write"), /연결이 끊어졌습니다/);
    assert.equal(called, false);
  } finally { await p.close(); }
});

test("RPC preserves binary attachments and correlates concurrent results and errors", async () => {
  const p = await pair();
  p.host.handle("bytes", async (bytes: Uint8Array, wait: number) => {
    await new Promise(resolve => setTimeout(resolve, wait));
    return { bytes, name: "첨부 자료.png" };
  });
  p.host.handle("fail", () => { throw new Error("fixture failure"); });
  try {
    const values = await Promise.all([p.client.call("bytes", [new Uint8Array([0, 255, 19]), 20]), p.client.call("bytes", [new Uint8Array([7]), 0])]);
    assert.deepEqual(values[0], { bytes: new Uint8Array([0, 255, 19]), name: "첨부 자료.png" });
    assert.deepEqual(values[1].bytes, new Uint8Array([7]));
    await assert.rejects(p.client.call("fail"), /fixture failure/);
    await assert.rejects(p.client.call("arbitrary-command"), /지원하지 않는 코어 요청/);
  } finally { await p.close(); }
});

test("authenticated core events cross the pipe without becoming requests", async () => {
  const p = await pair();
  try {
    await Promise.all([p.client.ready, p.host.ready]);
    const event = new Promise(resolve => { p.client.onEvent = (channel, args) => resolve({ channel, args }); });
    p.host.emit("chat:event", { chatId: 3, event: { type: "text", text: "마스터 응답" } });
    assert.deepEqual(await event, { channel: "chat:event", args: [{ chatId: 3, event: { type: "text", text: "마스터 응답" } }] });
  } finally { await p.close(); }
});

test("timeouts and disconnects reject waiting calls instead of leaving promises pending", async () => {
  const p = await pair();
  p.host.handle("wait", () => new Promise(() => {}));
  try {
    await assert.rejects(p.client.call("wait", [], 15), /응답 시간이 초과/);
    const pending = p.client.call("wait");
    const rejected = assert.rejects(pending, /연결이 끊어졌습니다/);
    p.host.close();
    await rejected;
  } finally { await p.close(); }
});

test("invalid frame sizes close the connection before allocating the declared payload", async () => {
  for (const length of [0, 128 * 1024 * 1024 + 1]) {
    const p = await pair();
    try {
      await Promise.all([p.client.ready, p.host.ready]);
      const closed = once(p.socket, "close");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      p.socket.write(header);
      await closed;
      await assert.rejects(p.client.call("anything"), /종료됐습니다/);
    } finally { await p.close(); }
  }
});

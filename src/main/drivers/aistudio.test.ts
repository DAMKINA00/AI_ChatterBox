import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AIStudioService } from "../aistudio";
import { AIStudioDriver, studioCompletion, type StudioMessage } from "./aistudio";

function sseResponse(frames: readonly (unknown | string)[], oneBytePackets = false, omitDone = false): Response {
  const body = frames.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\r\n\r\n`).join("")
    + (omitDone ? "" : "data: [DONE]\r\n\r\n");
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + (oneBytePackets ? 1 : bytes.length));
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function contentFrame(text: string, finish_reason?: string) {
  return { choices: [{ delta: { ...(text ? { content: text } : {}) }, ...(finish_reason ? { finish_reason } : {}) }] };
}

function toolFrame(piece: Record<string, unknown>) {
  return { choices: [{ delta: { tool_calls: [piece] } }] };
}

function toolResponse(id: string, name: string, args: unknown, signature?: string, oneBytePackets = false) {
  return sseResponse([
    toolFrame({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) }, ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) }),
    contentFrame("", "tool_calls"),
  ], oneBytePackets);
}

function driverFixture(cwd: string, hostOverrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const events: any[] = [];
  const approvals: any[] = [];
  const host: any = {
    emit: (event: any) => events.push(event),
    nativeId: () => undefined,
    approve: async (input: any) => {
      approvals.push(input);
      return { verdict: "allow" as const };
    },
    ...hostOverrides,
  };
  const service: any = {
    settings: () => ({ baseUrl: "http://127.0.0.1:2048", model: "gemini-4-argon", hasApiKey: false, executable: "", videoEnabled: false }),
    json: async () => ({ data: [{ id: "gemini-4-argon" }] }),
    response: async () => { throw new Error("unexpected AI Studio request"); },
  };
  const driver = new AIStudioDriver({ cwd, nativeId: null, exePath: "unused", model: "aistudio:gemini-4-argon", ...options }, { service }, host);
  return { driver, service, host, events, approvals };
}

test("studioCompletion handles CRLF boundaries split across packets", async () => {
  const deltas: string[] = [];
  const result = await studioCompletion(
    sseResponse([contentFrame("hello"), contentFrame(" world", "stop")], true),
    new AbortController().signal,
    text => deltas.push(text),
  );

  assert.equal(result.message.content, "hello world");
  assert.deepEqual(deltas, ["hello", " world"]);
  assert.equal(result.message.tool_calls, undefined);
});

test("studioCompletion rejects a dropped stream without a DONE marker", async () => {
  await assert.rejects(
    studioCompletion(
      sseResponse([contentFrame("partial", "stop")], false, true),
      new AbortController().signal,
      () => undefined,
    ),
    /완료되지 않았습니다/,
  );
});

test("studioCompletion joins fragmented function arguments and preserves Google thought signatures", async () => {
  const result = await studioCompletion(
    sseResponse([
      toolFrame({ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: '{"path":"out.txt","' } }),
      toolFrame({ index: 0, function: { arguments: 'content":"done"' }, extra_content: { google: { thought_signature: "sig-1" } } }),
      toolFrame({ index: 0, function: { arguments: "}" } }),
      contentFrame("", "tool_calls"),
    ], true),
    new AbortController().signal,
    () => undefined,
  );

  assert.deepEqual(result.message.tool_calls, [{
    id: "call-1",
    type: "function",
    function: { name: "write_file", arguments: '{"path":"out.txt","content":"done"}' },
    extra_content: { google: { thought_signature: "sig-1" } },
  }]);
});

test("driver performs read, approved write, Node test command, and final response using mocked API", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-driver-"));
  writeFileSync(join(project, "input.txt"), "seed value\n", "utf8");
  writeFileSync(join(project, "check.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fixture", () => assert.equal(2 + 2, 4));\n', "utf8");

  const requests: any[] = [];
  const responses = [
    sseResponse([
      toolFrame({ index: 0, id: "read-1", type: "function", function: { name: "read_file", arguments: '{"path":"input.txt","' } }),
      toolFrame({ index: 0, function: { arguments: 'offset":1,"limit":10}' }, extra_content: { google: { thought_signature: "read-signature" } } }),
      contentFrame("", "tool_calls"),
    ], true),
    toolResponse("write-1", "write_file", { path: "output.txt", content: "written by AI Studio" }),
    toolResponse("run-1", "run_command", { command: "node --test check.mjs", timeout_ms: 120000 }),
    sseResponse([contentFrame("All steps completed.", "stop")]),
  ];
  const fixture = driverFixture(project);
  fixture.service.response = async (path: string, body: unknown) => {
    assert.equal(path, "/v1/chat/completions");
    requests.push(body);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra completion request");
    return response;
  };

  try {
    await fixture.driver.send({ text: "Complete the fixture", attachments: [] });
    await (fixture.driver as any).task;

    assert.equal(readFileSync(join(project, "output.txt"), "utf8"), "written by AI Studio");
    assert.equal(responses.length, 0);
    assert.equal(requests.length, 4);
    const followupMessages = requests[1].messages as StudioMessage[];
    const assistant = followupMessages.findLast(message => message.role === "assistant");
    assert.equal(assistant?.tool_calls?.[0].function.arguments, '{"path":"input.txt","offset":1,"limit":10}');
    assert.equal(assistant?.tool_calls?.[0].extra_content?.google.thought_signature, "read-signature");

    const toolResults = fixture.events.filter(event => event.type === "tool_result");
    assert.equal(toolResults.length, 3);
    assert.match(toolResults[0].output, /1: seed value/);
    assert.equal(toolResults[0].ok, true);
    assert.equal(toolResults[1].ok, true);
    assert.match(toolResults[2].output, /exit_code: 0/);
    assert.ok(fixture.events.some(event => event.type === "text" && event.text === "All steps completed."));
    assert.deepEqual(fixture.events.at(-1), { type: "turn_end", ok: true, error: undefined, interrupted: false });
    assert.equal(fixture.approvals.length, 3);
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

test("noWrites rejects file writes and mutating commands before side effects", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-readonly-"));
  const fixture = driverFixture(project);
  const signal = new AbortController().signal;
  try {
    await assert.rejects((fixture.driver as any).tool("write_file", { path: "blocked.txt", content: "no" }, "write-1", true, signal), /읽기 전용/);
    await assert.rejects((fixture.driver as any).tool("run_command", { command: "Set-Content blocked.txt no" }, "run-1", true, signal), /읽기 전용/);
    assert.equal(existsSync(join(project, "blocked.txt")), false);
    assert.equal(fixture.approvals.length, 0);
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

test("disabled video tools are not advertised and an unsolicited video call cannot execute", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-video-disabled-"));
  const fixture = driverFixture(project);
  const requests: any[] = [];
  let videoRequests = 0;
  const responses = [
    toolResponse("video-1", "generate_video", { model: "synthetic-video", prompt: "never send", seconds: 4, size: "1280x720" }),
    sseResponse([contentFrame("Video call rejected.", "stop")]),
  ];
  fixture.service.json = async (path: string) => {
    if (path === "/v1/models") return { data: [{ id: "gemini-4-argon" }] };
    videoRequests++;
    throw new Error(`unexpected JSON request ${path}`);
  };
  fixture.service.response = async (path: string, body: unknown) => {
    if (path === "/v1/videos") {
      videoRequests++;
      throw new Error("video request must not be sent");
    }
    assert.equal(path, "/v1/chat/completions");
    requests.push(body);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra completion request");
    return response;
  };

  try {
    await fixture.driver.send({ text: "Do not generate video", attachments: [] });
    await (fixture.driver as any).task;
    const advertised = (requests[0].tools ?? []).map((tool: any) => tool.function?.name);
    assert.equal(advertised.includes("generate_video"), false);
    assert.equal(advertised.includes("video_status"), false);
    assert.equal(advertised.includes("save_video"), false);
    const result = fixture.events.find(event => event.type === "tool_result");
    assert.equal(result?.ok, false);
    assert.match(result?.output ?? "", /허용되지 않은 도구 또는 잘못된 입력/);
    assert.equal(videoRequests, 0);
    assert.ok(fixture.events.some(event => event.type === "text" && event.text === "Video call rejected."));
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

test("denied write approval creates no file", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-deny-"));
  const fixture = driverFixture(project);
  fixture.host.approve = async (input: any) => {
    fixture.approvals.push(input);
    return { verdict: "deny", reason: "rejected" };
  };
  try {
    await assert.rejects((fixture.driver as any).tool("write_file", { path: "denied.txt", content: "must not exist" }, "write-1", false, new AbortController().signal), /rejected/);
    assert.equal(existsSync(join(project, "denied.txt")), false);
    assert.equal(fixture.approvals.length, 1);
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

test("abort during approval prevents the approved write from taking effect", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-abort-"));
  let approvalStarted!: () => void;
  let releaseApproval!: (value: { verdict: "allow" }) => void;
  const started = new Promise<void>(resolve => { approvalStarted = resolve; });
  const approval = new Promise<{ verdict: "allow" }>(resolve => { releaseApproval = resolve; });
  const fixture = driverFixture(project);
  fixture.host.approve = async () => {
    approvalStarted();
    return approval;
  };
  const controller = new AbortController();
  try {
    const operation = (fixture.driver as any).tool("write_file", { path: "aborted.txt", content: "must not exist" }, "write-1", false, controller.signal);
    await started;
    controller.abort();
    releaseApproval({ verdict: "allow" });
    await assert.rejects(operation);
    assert.equal(existsSync(join(project, "aborted.txt")), false);
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

function serviceStore() {
  const values = new Map<string, string>();
  return { getSetting: (key: string) => values.get(key), setSetting: (key: string, value: string) => values.set(key, value) };
}

function serviceSecrets() {
  return { encrypt: (value: string) => value, decrypt: (value: string) => value };
}

test("429 and other HTTP failures emit one error and perform no duplicate actions", async () => {
  for (const status of [429, 500]) {
    let chatRequests = 0;
    const service = new AIStudioService(serviceStore(), serviceSecrets(), async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return new Response(JSON.stringify({ data: [{ id: "gemini-4-argon" }] }), { headers: { "content-type": "application/json" } });
      if (path === "/v1/chat/completions") {
        chatRequests++;
        return new Response(JSON.stringify({ error: { message: "quota failure" } }), { status, statusText: status === 429 ? "Too Many Requests" : "Internal Server Error", headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected ${path}`);
    });
    const events: any[] = [];
    const driver = new AIStudioDriver(
      { cwd: process.cwd(), nativeId: null, exePath: "unused", model: "aistudio:gemini-4-argon" },
      { service },
      { emit: event => events.push(event), nativeId: () => undefined, approve: async () => ({ verdict: "deny" as const }) },
    );
    try {
      await driver.send({ text: "fail once", attachments: [] });
      await (driver as any).task;
      assert.equal(chatRequests, 1);
      assert.equal(events.filter(event => event.type === "error").length, 1);
      assert.equal(events.filter(event => event.type === "tool_call").length, 0);
      assert.equal(events.filter(event => event.type === "file_change").length, 0);
      assert.deepEqual(events.filter(event => event.type === "turn_end"), [{ type: "turn_end", ok: false, error: `AIStudio2API ${status}: quota failure`, interrupted: false }]);
    } finally {
      await driver.dispose();
    }
  }
});

test("driver reports cumulative token usage across tool rounds", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-usage-"));
  writeFileSync(join(project, "input.txt"), "usage fixture\n", "utf8");
  const requests: any[] = [];
  const responses = [
    sseResponse([
      { usage: { prompt_tokens: 2, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } } },
      toolFrame({ index: 0, id: "usage-read", type: "function", function: { name: "read_file", arguments: '{"path":"input.txt"}' } }),
      contentFrame("", "tool_calls"),
    ]),
    sseResponse([
      { usage: { prompt_tokens: 5, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } } },
      contentFrame("usage complete", "stop"),
    ]),
  ];
  const fixture = driverFixture(project);
  fixture.service.response = async (path: string, body: unknown) => {
    assert.equal(path, "/v1/chat/completions");
    requests.push(body);
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra completion request");
    return response;
  };

  try {
    await fixture.driver.send({ text: "Read the fixture", attachments: [] });
    await (fixture.driver as any).task;

    assert.equal(requests.length, 2);
    assert.deepEqual(
      fixture.events.filter(event => event.type === "agent_usage").map(event => ({
        inputTokens: event.metrics.inputTokens,
        outputTokens: event.metrics.outputTokens,
        cachedInputTokens: event.metrics.cachedInputTokens,
      })),
      [
        { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 },
        { inputTokens: 7, outputTokens: 10, cachedInputTokens: 3 },
      ],
    );
    assert.deepEqual(fixture.events.at(-1), { type: "turn_end", ok: true, error: undefined, interrupted: false });
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

test("write_file refuses approval-time changes and prevents a new-file overwrite race", async () => {
  const project = mkdtempSync(join(tmpdir(), "aichatterbox-aistudio-write-race-"));
  const existingPath = join(project, "existing.txt");
  const newPath = join(project, "new.txt");
  writeFileSync(existingPath, "before", "utf8");
  const fixture = driverFixture(project);
  const pendingApproval = () => {
    let resolveStarted!: () => void;
    let resolveApproval!: (value: { verdict: "allow" }) => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const approval = new Promise<{ verdict: "allow" }>(resolve => { resolveApproval = resolve; });
    fixture.host.approve = async (input: any) => {
      fixture.approvals.push(input);
      resolveStarted();
      return approval;
    };
    return { started, release: resolveApproval };
  };

  try {
    let gate = pendingApproval();
    const existingWrite = (fixture.driver as any).tool(
      "write_file", { path: "existing.txt", content: "replacement" }, "race-existing", false, new AbortController().signal,
    );
    await gate.started;
    writeFileSync(existingPath, "changed while waiting", "utf8");
    gate.release({ verdict: "allow" });
    await assert.rejects(existingWrite, /승인 대기 중 파일이 변경되었습니다/);
    assert.equal(readFileSync(existingPath, "utf8"), "changed while waiting");

    gate = pendingApproval();
    const newWrite = (fixture.driver as any).tool(
      "write_file", { path: "new.txt", content: "replacement" }, "race-new", false, new AbortController().signal,
    );
    await gate.started;
    writeFileSync(newPath, "created while waiting", "utf8");
    gate.release({ verdict: "allow" });
    await assert.rejects(newWrite, /EEXIST|already exists/);
    assert.equal(readFileSync(newPath, "utf8"), "created while waiting");
  } finally {
    await fixture.driver.dispose();
    rmSync(project, { recursive: true, force: true });
  }
});

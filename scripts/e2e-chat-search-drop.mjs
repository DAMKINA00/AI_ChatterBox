// Isolated renderer + real attachment IPC checks. No model turns or production data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "chat-search-drop", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
mkdirSync(data, { recursive: true });
mkdirSync(workspace, { recursive: true });
const diskFile = join(workspace, "드롭 문서.txt");
writeFileSync(diskFile, "원본 문서 보존");
const userAttachmentPath = join(workspace, "사용자 첨부 파일.txt");
const agentAttachmentPath = join(workspace, "작업자 첨부 파일.md");
writeFileSync(userAttachmentPath, "사용자 첨부 원본");
writeFileSync(agentAttachmentPath, "작업자 첨부 원본");
const db = new DatabaseSync(join(data, "chatterbox.db"));
db.exec(readFileSync(join(root, "src/main/db.ts"), "utf8").match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
const now = Date.now();
db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)")
  .run("첨부·검색 확인", workspace, JSON.stringify(DEFAULTS), now);
const chat = db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)");
chat.run(1, "검색 확인", now, now + 1);
chat.run(2, "다른 대화", now, now);
const userAttachment = { id: 1, name: "사용자 첨부 파일.txt", path: userAttachmentPath, mime: "text/plain", size: Buffer.byteLength("사용자 첨부 원본") };
const agentAttachment = { id: 2, name: "작업자 첨부 파일.md", path: agentAttachmentPath, mime: "text/markdown", size: Buffer.byteLength("작업자 첨부 원본") };
const attachment = db.prepare("INSERT INTO attachments (id, chat_id, event_id, name, path, mime, size) VALUES (?, 1, NULL, ?, ?, ?, ?)");
attachment.run(userAttachment.id, userAttachment.name, userAttachment.path, userAttachment.mime, userAttachment.size);
attachment.run(agentAttachment.id, agentAttachment.name, agentAttachment.path, agentAttachment.mime, agentAttachment.size);
const insert = db.prepare("INSERT INTO chat_events (chat_id, node, role, ts, type, payload_json) VALUES (1, ?, ?, ?, ?, ?)");
const event = (role, value, node = "orch") => insert.run(node, role, now, value.type, JSON.stringify(value));
const deepToolOutput = `${Array.from({ length: 80 }, (_, i) => `도구 출력 줄 ${i}`).join("\n")}\n깊은 도구 출력`;
event(null, { type: "user", text: "첫 번째 바늘 · C++ · [] · /path\\file", attachments: [userAttachment] });
for (let i = 0; i < 28; i++) event("orch", { type: "text", text: `긴 대화 ${i}\n\n중간 설명입니다.` });
event("orch", { type: "text", text: "두 번째 **바늘** · Alpha ALPHA\n\n강조된 **검색** 결과도 찾습니다.\n\n```ts\nconst sample = '바늘';\n```" });
event("orch", { type: "text", text: "경계 앞문장\n\n경계 뒷문장" });
event("orch", { type: "tool_call", id: "search-tool", name: "Bash", input: "숨겨진 도구 입력" });
event("orch", { type: "tool_result", id: "search-tool", ok: true, output: deepToolOutput });
event("orch", {
  type: "file_change",
  id: "multi-file-diff",
  ok: true,
  files: [
    { path: "src/first.ts", kind: "update", diff: "@@ -1 +1 @@\n-old first\n+first diff line" },
    { path: "src/second.ts", kind: "update", diff: "@@ -1 +1 @@\n-old second\n+collapsed diff target" },
  ],
});
event("orch", { type: "consult_start", consultId: 1, kind: "review", from: "orch", to: "w1", request: "숨겨진 **요청** 문장", attachments: [agentAttachment], reason: "검토를 위해 작업자에게 요청" });
event("w1", { type: "text", text: "작업자 바늘 확인 완료" }, "consult:1");
event("orch", { type: "consult_end", consultId: 1, status: "done", summary: "검토 완료", files: ["src/검색 대상.ts"] });
db.close();

let app;
try {
  const launched = await launch(data);
  app = launched.app;
  const page = launched.page;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.locator('[data-chat-id="1"] [role="treeitem"]').click();
  await page.getByTestId("timeline").waitFor();
  await page.keyboard.press("Control+f");
  const query = page.getByLabel("대화에서 찾을 내용");
  const search = async value => { await query.fill(value); await query.press("Enter"); };
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await query.fill("g");
  await page.clock.runFor(499);
  check("typing does not scan or expand the timeline before 500ms", await page.getByTestId("chat-search-count").innerText() === "검색 대기…" && await page.evaluate(() => CSS.highlights.get("chat-search").size) === 0 && await page.getByTestId("consult-request-body").count() === 0);
  await query.fill("alpha");
  await page.clock.runFor(499);
  check("each new keystroke restarts the 500ms delay", await page.evaluate(() => CSS.highlights.get("chat-search").size) === 0);
  await page.clock.runFor(1);
  check("search runs 500ms after the final input", await page.getByTestId("chat-search-count").innerText() === "1 / 2");
  await query.dispatchEvent("compositionstart");
  await query.fill("조합 중인 글자");
  await page.clock.runFor(700);
  await query.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  check("IME composition does not trigger a partial search", await page.evaluate(() => CSS.highlights.get("chat-search").size) === 2 && await page.getByTestId("chat-search-count").innerText() === "검색 대기…");
  await query.dispatchEvent("compositionend");
  await search("바늘");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "1 / 4");
  check("Enter searches immediately without waiting for the debounce", await page.evaluate(() => CSS.highlights.get("chat-search").size) === 4);
  const activeSignature = () => page.evaluate(() => {
    const range = [...(CSS.highlights.get("chat-search-active") ?? [])][0];
    return range ? `${range.startContainer.nodeValue ?? range.startContainer.textContent ?? ""}:${range.startOffset}` : "";
  });
  const firstActive = await activeSignature();
  const firstScroll = await page.getByTestId("timeline").evaluate(el => el.scrollTop);
  check("search starts at the bottom-most match", firstActive.includes("작업자 바늘 확인 완료") && firstScroll > 100);
  await page.clock.runFor(500);
  check("the cleared debounce does not advance an Enter-submitted search", await page.getByTestId("chat-search-count").innerText() === "1 / 4" && await activeSignature() === firstActive);
  await query.press("Enter");
  const secondActive = await activeSignature();
  check("Enter advances upward to older matches", await page.getByTestId("chat-search-count").innerText() === "2 / 4" && firstActive !== secondActive && await page.getByTestId("timeline").evaluate(el => el.scrollTop) < firstScroll);
  await query.press("Shift+Enter");
  await page.getByLabel("이전 검색 결과").click();
  check("downward navigation wraps from newest to oldest", await page.getByTestId("chat-search-count").innerText() === "4 / 4" && (await activeSignature()).includes("첫 번째 바늘"));
  await page.getByLabel("다음 검색 결과").click();
  check("upward navigation wraps from oldest to newest", await page.getByTestId("chat-search-count").innerText() === "1 / 4" && await activeSignature() === firstActive);
  await search("검색 결과");
  check("search spans markdown emphasis without changing the message", await page.getByTestId("chat-search-count").innerText() === "1 / 1" && await page.evaluate(() => [...CSS.highlights.get("chat-search")][0]?.toString()) === "검색 결과");
  await search("요청 문장");
  check("collapsed requests are searchable across formatting", await page.getByTestId("chat-search-count").innerText() === "1 / 1" && await page.getByTestId("consult-request-body").isVisible());
  await search("alpha");
  check("English search is case insensitive", await page.getByTestId("chat-search-count").innerText() === "1 / 2");
  for (const literal of ["C++", "[]", "/path\\file"]) {
    await search(literal);
    check(`literal query ${literal}`, await page.getByTestId("chat-search-count").innerText() === "1 / 1");
  }
  await search("사용자 첨부 파일.txt");
  check("user attachment filenames are searchable", await page.getByTestId("chat-search-count").innerText() === "1 / 1");
  await search("작업자 첨부 파일.md");
  check("worker attachment filenames are searchable", await page.getByTestId("chat-search-count").innerText() === "1 / 1" && await page.getByTestId("consult-request-details").isVisible());
  await search("깊은 도구 출력");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "1 / 1");
  const deepTool = page.locator('[data-testid="tool-card"] pre').filter({ hasText: "깊은 도구 출력" });
  const deepToolView = await deepTool.evaluate((el) => {
    const target = "깊은 도구 출력";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = (node.nodeValue ?? "").indexOf(target);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + target.length);
      const rect = range.getBoundingClientRect();
      const viewport = el.getBoundingClientRect();
      return { scrollTop: el.scrollTop, visible: rect.top >= viewport.top && rect.bottom <= viewport.bottom };
    }
    return { scrollTop: el.scrollTop, visible: false };
  });
  check("collapsed tool output expands and scrolls deep matches into view", deepToolView.scrollTop > 0 && deepToolView.visible);
  await search("collapsed diff target");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "1 / 1");
  const diffMatch = page.locator('[data-chat-search-text]').filter({ hasText: "collapsed diff target" });
  check("collapsed multi-file diffs expand for search", await diffMatch.count() === 1 && await diffMatch.isVisible());
  await search("앞문장뒷문장");
  check("block boundaries do not create concatenated matches", await page.getByTestId("chat-search-count").innerText() === "결과 없음");
  await search("작업자에게 요청");
  check("consult reasons are searchable", await page.getByTestId("chat-search-count").innerText() === "1 / 1");
  await search("검색 대상.ts");
  check("consult changed filenames are searchable", await page.getByTestId("chat-search-count").innerText() === "1 / 1");
  await search("없는 결과");
  check("no match disables navigation", await page.getByTestId("chat-search-count").innerText() === "결과 없음" && await page.getByLabel("다음 검색 결과").isDisabled());
  await search("바늘");
  const liveActive = await activeSignature();
  const liveScroll = await page.getByTestId("timeline").evaluate(el => el.scrollTop);
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send("chat:event", value), {
    id: 10000, chatId: 1, node: "orch", role: "orch", at: now + 1, event: { type: "text", text: "새 바늘" },
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-search-count"]')?.textContent === "2 / 5");
  check("newer live matches preserve the selected occurrence and scroll position", await activeSignature() === liveActive && Math.abs(await page.getByTestId("timeline").evaluate(el => el.scrollTop) - liveScroll) < 2);
  await page.screenshot({ path: join(base, "search-dark.png") });
  await query.press("Escape");
  check("Escape removes highlights and restores collapsed requests and diffs", await page.getByTestId("chat-search").count() === 0 && await page.getByTestId("consult-request-body").count() === 0 && await diffMatch.count() === 0 && await page.evaluate(() => !CSS.highlights.has("chat-search") && !CSS.highlights.has("chat-search-active")));
  await page.keyboard.press("Control+f");
  await query.fill("닫은 뒤 실행되면 안 되는 검색");
  await query.press("Escape");
  await page.clock.runFor(500);
  check("closing search cancels the pending debounce", await page.getByTestId("chat-search").count() === 0 && await page.evaluate(() => !CSS.highlights.has("chat-search")));

  // Use a real disk-backed File so this exercises preload webUtils.getPathForFile.
  await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "disk-drop-fixture"; input.hidden = true; document.body.append(input); });
  await page.locator("#disk-drop-fixture").setInputFiles(diskFile);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(document.querySelector("#disk-drop-fixture").files[0]);
    dt.items.add(new File(["메모 내용"], "메모.md", { type: "text/markdown" }));
    const view = document.querySelector('[data-testid="chat-view"]');
    view.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    view.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="pending-attachments"] [data-testid="attachment"]').length === 2);
  check("multi-file drop attaches disk paths and in-memory files", (await page.getByTestId("pending-attachments").innerText()).includes("드롭 문서.txt") && (await page.getByTestId("pending-attachments").innerText()).includes("메모.md"));
  const verifyDb = new DatabaseSync(join(data, "chatterbox.db"), { readOnly: true });
  const rows = verifyDb.prepare("SELECT * FROM attachments ORDER BY id").all();
  verifyDb.close();
  const dropped = rows.filter(row => row.name === "드롭 문서.txt" || row.name === "메모.md");
  check("dropped files are persisted without changing the source", rows.length === 4 && dropped.length === 2 && readFileSync(dropped.find(row => row.name === "드롭 문서.txt").path, "utf8") === "원본 문서 보존" && readFileSync(dropped.find(row => row.name === "메모.md").path, "utf8") === "메모 내용" && readFileSync(diskFile, "utf8") === "원본 문서 보존");
  await page.locator('[data-chat-id="2"] [role="treeitem"]').click();
  check("attachments and search do not leak into another chat", await page.getByTestId("pending-attachments").count() === 0 && await page.getByTestId("chat-search").count() === 0);
  await page.locator('[data-chat-id="1"] [role="treeitem"]').click();
  check("unsent attachments survive returning to the original chat", await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').count() === 2);
  await page.getByLabel("테마 전환").click();
  await page.getByLabel("대화 내용 검색", { exact: true }).click();
  await search("바늘");
  await page.screenshot({ path: join(base, "search-light.png") });
  check("renderer completed without errors", errors.length === 0, errors.join("\n"));
  console.log(`Screenshots: ${base}`);
} catch (error) {
  console.error(error);
  check("chat search and drop flow completed", false, error.stack ?? error.message);
} finally {
  await app?.close().catch(() => {});
}
finish();

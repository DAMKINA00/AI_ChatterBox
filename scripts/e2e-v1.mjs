// V1 stage e2e: projects/chats/tree, attachments (📎, Ctrl+V, drag & drop), image understanding,
// markdown + code rendering, model inheritance UI, theme, persistence across restart.
// Usage: npm run build && node scripts/e2e-v1.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, scratchDir, launch, DEFAULTS, waitIdle, send, lastAgentText, shot, snapshot, leftovers, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = scratchDir("e2e-v1");
const data = join(base, "data");
const wsA = scratchDir("e2e-v1/shop");
const wsB = scratchDir("e2e-v1/pipeline");
const icon = join(root, "build", "icon.png");
const before = snapshot();

let { app, page } = await launch(data);

// ---- projects through the real dialog (folder picker stubbed: native dialogs can't be driven)
async function stubFolder(path) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, path);
}
await stubFolder(wsA);
await page.getByLabel("새 프로젝트").first().click();
await page.getByRole("button", { name: "찾아보기" }).click();
await page.waitForFunction(() => document.querySelector("#proj-name")?.value === "shop");
await page.fill("#proj-name", "웹 쇼핑몰");
await page.getByRole("button", { name: "만들기" }).click();
await page.waitForSelector('[data-testid="chat-title"]');
check("project 1 created via dialog and a chat opened", (await page.textContent('[data-testid="chat-title"]')) === "새 채팅");

await stubFolder(wsB);
await page.getByLabel("새 프로젝트").first().click();
await page.getByRole("button", { name: "찾아보기" }).click();
await page.waitForFunction(() => document.querySelector("#proj-name")?.value === "pipeline");
await page.getByRole("button", { name: "만들기" }).click();
await page.waitForTimeout(500);
// second chat in project 1 via the row button
await page.locator('[data-testid="project-node"]', { hasText: "웹 쇼핑몰" }).getByRole("button", { name: "새 채팅" }).last().click();
await page.waitForTimeout(400);
const projectsShown = await page.locator('[data-testid="project-node"]').count();
const chatsShown = await page.locator('[data-testid="chat-node"]').count();
check("tree shows 2 projects and 3 chats", projectsShown === 2 && chatsShown === 3, `projects=${projectsShown} chats=${chatsShown}`);

// ---- chat 1 in project 1: attachments three ways + image question to Claude
await page.locator('[data-testid="project-node"]', { hasText: "웹 쇼핑몰" }).locator('[data-testid="chat-node"] [role="treeitem"]').first().click();
await page.waitForSelector('[data-testid="chat-title"]');

// a) 📎 (dialog stubbed)
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
}, icon);
await page.getByLabel("파일 첨부").click();
await page.waitForSelector('[data-testid="pending-attachments"] [data-testid="attachment"]');
check("📎 attaches a file", (await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').count()) === 1);
// remove it again (thumbnail × button)
await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').first().hover();
await page.getByLabel(/첨부 삭제/).first().click();
await page.waitForTimeout(300);
check("attachment can be removed", (await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').count()) === 0);

// b) drag & drop (synthetic DataTransfer with the image bytes)
const b64 = (await import("node:fs")).readFileSync(icon).toString("base64");
await page.evaluate((data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
  const target = document.querySelector('[data-testid="timeline"]');
  for (const type of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}, b64);
await page.waitForSelector('[data-testid="pending-attachments"] [data-testid="attachment"]');
check("drag & drop attaches an image", (await page.locator('[data-testid="pending-attachments"] img').count()) === 1);
await page.locator('[data-testid="pending-attachments"] [data-testid="attachment"]').first().hover();
await page.getByLabel(/첨부 삭제/).first().click();
await page.waitForTimeout(300);

// c) Ctrl+V with an image on the system clipboard
// Electron 44 clipboard API: write([ClipboardItem]) (writeImage is gone).
await app.evaluate(
  ({ clipboard, ClipboardItem }, data) =>
    clipboard.write([new ClipboardItem({ "image/png": new Blob([Buffer.from(data, "base64")], { type: "image/png" }) })]),
  b64,
);
await page.getByLabel("메시지 입력").click();
await page.keyboard.press("Control+V");
await page.waitForSelector('[data-testid="pending-attachments"] img', { timeout: 10_000 }).catch(() => undefined);
check("Ctrl+V pastes a clipboard image", (await page.locator('[data-testid="pending-attachments"] img').count()) === 1);

await send(page, "붙여넣은 이미지에 무엇이 보이는지 한 문장으로 설명해 줘. 말풍선 색을 꼭 포함해.");
await waitIdle(page);
let reply = await lastAgentText(page, "orch");
check("Claude (orchestrator) describes the pasted image", /주황|오렌지|orange/i.test(reply) && /초록|민트|녹색|green|teal|청록/i.test(reply), reply);
check("user message shows the image thumbnail", (await page.locator('[data-testid="user-message"] img').count()) >= 1);
check("chat title taken from the first message", (await page.textContent('[data-testid="chat-title"]'))?.startsWith("붙여넣은 이미지에"));
check("attachment copied into the app's attachments folder", existsSync(join(data, "attachments")));
await shot(page, "v1-image-chat.png");

// ---- markdown, code highlight, table
await send(page, "TypeScript로 두 수를 더하는 add 함수를 코드 블록 하나로 보여 주고, 그 아래에 열이 '이름'과 '설명'인 2행짜리 표를 마크다운으로 만들어 줘. 파일은 만들지 마.");
await waitIdle(page);
check("code block rendered with highlight + copy", (await page.locator(".prose-chat pre code.hljs").count()) >= 1 && (await page.getByLabel("코드 복사").count()) >= 1);
check("markdown table rendered", (await page.locator(".prose-chat table").count()) >= 1);
await shot(page, "v1-markdown.png");

// ---- tree navigation: chat node expands to the orchestrator conversation
await page.locator('[data-testid="chat-node"]').first().getByLabel("펼치기").click();
await page.getByRole("button", { name: "오케스트레이터 대화" }).first().click();
await page.waitForTimeout(400);
check("orchestrator node view opens", (await page.textContent("header")).includes("오케스트레이터 대화"));
await page.locator('[data-testid="chat-node"] [role="treeitem"]').first().click();

// The picker shows only the model name; an override is visible as a "프로젝트 값 사용" menu item.
async function hasOverride(picker) {
  await picker.click();
  const n = await page.getByRole("menuitem", { name: /프로젝트 값 사용/ }).count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  return n > 0;
}
// ---- model inheritance in the chat header
const claudePicker = page.getByLabel("이 채팅의 Claude 모델");
check("chat follows the project's Claude model (no override, no label)", !(await hasOverride(claudePicker)) && !(await claudePicker.textContent()).includes("프로젝트 기본값"));
await claudePicker.click();
await page.getByRole("menuitem", { name: /Sonnet/ }).first().click();
await page.waitForTimeout(300);
check("per-chat Claude override sticks", (await hasOverride(claudePicker)) && /Sonnet/.test(await claudePicker.textContent()));
// project change: GPT model → another model; chat (not overridden) follows, Claude override stays
const projects = await page.evaluate(() => window.chatterbox.listProjects());
const p1 = projects.find((p) => p.name === "웹 쇼핑몰");
await page.evaluate(([id, s]) => window.chatterbox.updateProject(id, { settings: s }), [p1.id, { ...p1.settings, codexModel: "gpt-6-sol", claudeModel: "haiku" }]);
await page.reload();
await page.waitForSelector('[data-testid="chat-title"]');
const gptText = await page.getByLabel("이 채팅의 GPT 모델").textContent();
const claudeText = await page.getByLabel("이 채팅의 Claude 모델").textContent();
check("non-overridden GPT model follows the project change", /Sol/i.test(gptText) && !(await hasOverride(page.getByLabel("이 채팅의 GPT 모델"))), gptText);
check("overridden Claude model keeps the chat value", /Sonnet/.test(claudeText) && (await hasOverride(page.getByLabel("이 채팅의 Claude 모델"))), claudeText);
await page.getByLabel("이 채팅의 Claude 모델").click();
await page.getByRole("menuitem", { name: /프로젝트 값 사용/ }).click();
await page.waitForTimeout(300);
check("reset to project value", /Haiku/.test(await page.getByLabel("이 채팅의 Claude 모델").textContent()) && !(await hasOverride(page.getByLabel("이 채팅의 Claude 모델"))));

// ---- rename + delete through the context menu
const thirdChat = page.locator('[data-testid="chat-node"] [role="treeitem"]').nth(1);
await thirdChat.click({ button: "right" });
await page.getByRole("menuitem", { name: "이름 변경" }).click();
await page.getByLabel("새 이름").fill("결제 모듈");
await page.getByRole("button", { name: "저장" }).click();
await page.waitForTimeout(300);
check("rename via context menu", (await page.locator('[data-testid="chat-node"]').allTextContents()).some((t) => t.includes("결제 모듈")));
await page.locator('[data-testid="chat-node"] [role="treeitem"]', { hasText: "결제 모듈" }).click({ button: "right" });
await page.getByRole("menuitem", { name: "삭제" }).click();
await page.getByRole("button", { name: "삭제" }).click();
await page.waitForTimeout(300);
check("delete via context menu", !(await page.locator('[data-testid="chat-node"]').allTextContents()).some((t) => t.includes("결제 모듈")));

// ---- search
await page.getByLabel("채팅 검색").fill("붙여넣은");
await page.waitForTimeout(200);
check("search filters the tree", (await page.locator('[data-testid="chat-node"]').count()) === 1);
await page.getByLabel("검색 지우기").click();

// ---- theme
await page.getByLabel("테마 전환").click();
await page.waitForTimeout(200);
check("light theme toggles", !(await page.evaluate(() => document.documentElement.classList.contains("dark"))));
await shot(page, "v1-light.png");
await page.getByLabel("테마 전환").click();

// ---- restart: everything persisted, and the Claude session continues
await app.close();
await new Promise((r) => setTimeout(r, 1500));
const left = leftovers(before);
check("no CLI processes left after quit", left.length === 0, left.join(", "));
({ app, page } = await launch(data));
await page.waitForSelector('[data-testid="chat-title"]');
check("last chat reopens after restart", (await page.textContent('[data-testid="chat-title"]'))?.startsWith("붙여넣은 이미지에"));
check("history restored", (await page.locator('[data-testid="user-message"]').count()) === 2);
await send(page, "처음에 내가 보낸 이미지에 말풍선이 몇 개 있었지? 숫자만 답해.");
await waitIdle(page);
reply = await lastAgentText(page, "orch");
check("resumed session remembers the image", /2|두/.test(reply), reply);
await shot(page, "v1-resumed.png");
await app.close();
finish();

// Isolated artifact Markdown verification. It seeds only SQLite/files and mocks the preview IPC;
// no CLI turn or arbitrary shell command is started. Run after the production build.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "artifact-preview-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const dbFile = join(data, "chatterbox.db");
const sourceImage = join(root, "src", "renderer", "public", "characters", "gpt", "happy.png");
const imagePath = join(workspace, "이미지 폴더", "미리보기 이미지.png");
const citationPath = join(workspace, "결과 폴더", "결과 보고서.pdf");
const attachmentPath = join(data, "attachments", "1", "미리보기 이미지.png");
const imageHref = "<이미지 폴더/미리보기 이미지.png>";
const attachment = {
  id: 901,
  name: "미리보기 이미지.png",
  mime: "image/png",
  size: 0,
  path: attachmentPath,
};

mkdirSync(dirname(imagePath), { recursive: true });
mkdirSync(dirname(citationPath), { recursive: true });
mkdirSync(dirname(attachmentPath), { recursive: true });
copyFileSync(sourceImage, imagePath);
copyFileSync(sourceImage, attachmentPath);
writeFileSync(citationPath, "artifact output\n");
attachment.size = statSync(attachmentPath).size;

const settings = {
  claudeStrengths: "artifact UI test",
  claudeCautions: "artifact UI test",
  gptStrengths: "artifact UI test",
  gptCautions: "artifact UI test",
  geminiStrengths: "artifact UI test",
  geminiCautions: "artifact UI test",
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  geminiModel: "",
  orchestratorEffort: "xhigh",
  claudeEffort: "auto",
  codexEffort: "auto",
  geminiEffort: "auto",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  maxGeminiWorkers: 1,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

const citation = `:codex-file-citation{path="${citationPath.replaceAll("\\", "/")}" purpose="output"}`;
const malformed = ":codex-file-citation{purpose=\"output\"}";
const inlineCitation = ':codex-file-citation{path="inline.md" purpose="output"}';
const fencedCitation = ':codex-file-citation{path="fenced.md" purpose="output"}';
const markdown = [
  `인용 결과: ${citation}`,
  "",
  `일반 이미지 링크 [미리보기 링크](${imageHref})`,
  `직접 이미지 ![직접 미리보기](${imageHref})`,
  "누락 이미지 [누락 파일](<없음/누락 이미지.png>)",
  "원격 이미지 ![원격 이미지](https://example.com/image.png)",
  "위험 링크 [위험 링크](javascript:alert(1))",
  malformed,
  `인라인 코드 \`${inlineCitation}\``,
  "",
  "```text",
  fencedCitation,
  "```",
].join("\n");

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (?, ?, ?, ?, ?, 0)").run(
      1,
      "Artifact 미리보기 UI",
      workspace,
      JSON.stringify(settings),
      now,
    );
    db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (?, 1, ?, 'idle', 0, 0, ?, ?)").run(
      1,
      "결과물 미리보기",
      now,
      now + 1,
    );
    db.prepare("INSERT INTO attachments (id, chat_id, event_id, name, path, mime, size) VALUES (?, 1, NULL, ?, ?, ?, ?)").run(
      attachment.id,
      attachment.name,
      attachment.path,
      attachment.mime,
      attachment.size,
    );
    const event = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, 'orch', 'orch', ?, 'text', ?)");
    event.run(1, now + 1, JSON.stringify({ type: "text", text: markdown }));
  } finally {
    db.close();
  }
}

async function stubPreview(app) {
  await app.evaluate(({ ipcMain }, payload) => {
    globalThis.__artifactPreviewCalls = [];
    ipcMain.removeHandler("artifacts:previewImage");
    ipcMain.handle("artifacts:previewImage", (_event, chatId, href) => {
      globalThis.__artifactPreviewCalls.push({ chatId, href });
      let decoded = String(href);
      try { decoded = decodeURIComponent(decoded); } catch { /* keep the original href */ }
      return chatId === 1 && decoded.includes("미리보기 이미지.png") ? payload : null;
    });
  }, attachment);
}

async function previewCalls(app) {
  return app.evaluate(() => globalThis.__artifactPreviewCalls ?? []);
}

let app;
try {
  seedDatabase();
  let launched = await launch(data);
  app = launched.app;
  const page = launched.page;
  await stubPreview(app);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="timeline"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-preview"] img').length === 2);

  check("citation path with spaces and Korean becomes a FileLink", (await page.getByRole("button", { name: "결과 보고서.pdf" }).count()) === 1);
  check("citation source syntax is not shown as rendered prose", !(await page.locator('[data-testid="agent-message"]').textContent()).includes(citation));
  check("ordinary local Markdown image links keep a visible preview and FileLink", (await page.locator('[data-testid="artifact-preview"] img').count()) === 2 && (await page.getByRole("button", { name: "미리보기 링크" }).count()) === 1);
  check("remote images stay links without an automatic image request", (await page.getByRole("link", { name: "원격 이미지" }).count()) === 1 && (await page.getByRole("link", { name: "원격 이미지" }).getAttribute("href")) === "https://example.com/image.png");
  check("missing images fall back to a FileLink without a broken image", (await page.getByRole("button", { name: "누락 파일" }).count()) === 1 && (await page.locator('img[alt="누락 파일"]').count()) === 0);
  const renderedText = await page.locator('[data-testid="agent-message"]').textContent();
  check("malformed citation and unsafe scheme remain harmless visible text", renderedText.includes(malformed) && (await page.getByText("위험 링크", { exact: true }).count()) === 1);
  const calls = await previewCalls(app);
  check("preview IPC uses the selected chat and skips remote URLs", calls.length >= 3 && calls.every((call) => call.chatId === 1) && calls.every((call) => !String(call.href).startsWith("https://")), JSON.stringify(calls));
  await page.screenshot({ path: join(base, "artifact-dark.png") });

  await app.close();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 300));
  launched = await launch(data);
  app = launched.app;
  await launched.page.setViewportSize({ width: 1280, height: 900 });
  await launched.page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await launched.page.waitForSelector('[data-testid="timeline"]');
  await launched.page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-preview"] img').length === 2);
  check("normalized citations and previews survive restart with the real preview IPC", (await launched.page.getByRole("button", { name: "결과 보고서.pdf" }).count()) === 1 && (await launched.page.locator('[data-testid="artifact-preview"] img').count()) === 2);
  await launched.page.getByRole("button", { name: "테마 전환" }).click();
  await launched.page.screenshot({ path: join(base, "artifact-light.png") });
} catch (error) {
  console.error(error);
  check("artifact Markdown UI verification completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Scratch data: ${base}`);
finish();

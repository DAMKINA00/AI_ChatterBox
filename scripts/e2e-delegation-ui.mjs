// 0.3.2 delegation, generated-image, usage, and local-link UI verification.
// Uses a disposable Electron data directory and stubs all OS shell/dialog actions.
// Run after the production build: node scripts/e2e-delegation-ui.mjs
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "delegation-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const screenshots = join(base, "screenshots");
const dbFile = join(data, "chatterbox.db");
const relativeFile = join(workspace, "relative doc.md");
const absoluteFile = join(workspace, "absolute doc.md");
const encodedFile = join(workspace, "encoded name.txt");
const executableFile = join(workspace, "blocked.exe");
const saveCopy = resolve(base, "saved-copy.md");
const cancelCopy = resolve(base, "cancelled-copy.md");

function ensureWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`test output escaped scratch directory: ${child}`);
  }
}

ensureWithin(base, saveCopy);
ensureWithin(base, cancelCopy);
mkdirSync(workspace, { recursive: true });
mkdirSync(screenshots, { recursive: true });
for (const [path, content] of [
  [relativeFile, "relative document bytes\n"],
  [absoluteFile, "absolute document bytes\n"],
  [encodedFile, "encoded document bytes\n"],
  [executableFile, "not executable in this test\n"],
]) {
  writeFileSync(path, content);
}

const DEFAULT_PROFILE = {
  claudeStrengths: "소스 구조·동작 흐름 분석, 원인 조사. 구현·테스트·문서 작성은 맥락에 따라 배정.",
  claudeCautions: "이미지 생성은 이미지 도구를 사용할 수 있는 지피티에게 맡깁니다. 성능 우열은 작업마다 다를 수 있습니다.",
  gptStrengths: "이미지 생성·편집, 시각 자료 제작. 구현·테스트·문서 작성은 맥락에 따라 배정.",
  gptCautions: "이미지 생성 도구의 실제 사용 가능 여부를 확인합니다. 소스 분석은 기본적으로 클로드를 우선 고려합니다.",
};

const oldSettings = {
  orchestratorModel: "claude:opus",
  claudeModel: "opus",
  codexModel: "gpt-6-astra",
  reviewGate: true,
  maxConsults: 8,
  maxReviews: 3,
  maxMinutes: 60,
  maxClaudeWorkers: 3,
  maxGptWorkers: 3,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

const fixturePng = join(root, "src", "renderer", "public", "characters", "gpt", "happy.png");
const attachmentPath = join(data, "attachments", "generated-preview.png");
mkdirSync(dirname(attachmentPath), { recursive: true });
copyFileSync(fixturePng, attachmentPath);
const attachment = {
  id: 901,
  name: "generated-preview.png",
  mime: "image/png",
  size: statSync(attachmentPath).size,
  path: attachmentPath,
};

const markdownPath = (value) => value.replaceAll("\\", "/").replaceAll(" ", "%20");
const relativeHref = "relative%20doc.md";
const absoluteHref = markdownPath(absoluteFile);
const encodedHref = "encoded%20name.txt";
const markdown = [
  "로컬 파일 링크 확인:",
  "",
  `- [상대 파일](${relativeHref})`,
  `- [절대 파일](${absoluteHref})`,
  `- [인코딩 파일](${encodedHref})`,
  "- [웹 문서](https://example.com/e2e-doc)",
].join("\n");

function seedDatabase() {
  const source = readFileSync(join(root, "src", "main", "db.ts"), "utf8");
  const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)?.[1];
  if (!schema) throw new Error("could not read the current SQLite schema");

  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(schema);
    const consultColumns = new Set(db.prepare("PRAGMA table_info(consults)").all().map((c) => c.name));
    for (const [column, ddl] of [
      ["scope_json", "scope_json TEXT"],
      ["instruction_id", "instruction_id INTEGER"],
      ["reason", "reason TEXT"],
      ["supersedes", "supersedes INTEGER"],
    ]) {
      if (!consultColumns.has(column)) db.exec(`ALTER TABLE consults ADD COLUMN ${ddl}`);
    }

    const now = Date.now();
    // Simulate a project saved before worker profiles were added.
    db.prepare("INSERT INTO projects (id, name, folder, settings_json, created_at, archived) VALUES (1, ?, ?, ?, ?, 0)").run(
      "Delegation UI",
      workspace,
      JSON.stringify(oldSettings),
      now,
    );
    db.prepare("INSERT INTO chats (id, project_id, title, status, unread, archived, created_at, last_active_at) VALUES (1, 1, ?, 'idle', 0, 0, ?, ?)").run(
      "협의와 생성 이미지",
      now,
      now + 1,
    );
    const insertAgent = db.prepare(
      "INSERT INTO agents (id, chat_id, kind, number, nickname, job, session_id, status, created_at) VALUES (?, 1, ?, 1, ?, ?, ?, 'active', ?)",
    );
    insertAgent.run(1, "claude", "클로드 1호", "reason and summary", "claude-e2e", now + 1);
    insertAgent.run(2, "gpt", "지피티 1호", "generated image", "gpt-e2e", now + 2);
    db.prepare("INSERT INTO consults (id, chat_id, seq, from_role, to_role, kind, request, response_summary, files_changed_json, status, started_at, ended_at, scope_json, instruction_id, reason, supersedes) VALUES (1, 1, 1, 'orch', 'w1', 'implement', ?, ?, '[]', 'done', ?, ?, '[]', 1, ?, NULL)").run(
      "설정된 요청을 확인하고 결과를 요약해 주세요.",
      "설정된 요청을 확인했습니다. 이 요약은 접힌 카드에서도 읽을 수 있습니다.",
      now,
      now + 1000,
      "소스 구조를 파악한 Claude에게 요청했습니다.",
    );
    db.prepare("INSERT INTO attachments (id, chat_id, event_id, name, path, mime, size) VALUES (?, 1, NULL, ?, ?, ?, ?)").run(
      attachment.id,
      attachment.name,
      attachment.path,
      attachment.mime,
      attachment.size,
    );

    const insertEvent = db.prepare("INSERT INTO chat_events (id, chat_id, node, role, ts, type, payload_json) VALUES (?, 1, ?, ?, ?, ?, ?)");
    const event = (id, node, role, payload) => insertEvent.run(id, node, role, now + id, payload.type, JSON.stringify(payload));
    event(1, "orch", null, { type: "user", text: "검증용 작업입니다.", attachments: [] });
    event(2, "orch", "orch", { type: "text", text: markdown });
    event(3, "orch", "orch", {
      type: "consult_start",
      consultId: 1,
      kind: "implement",
      from: "orch",
      to: "w1",
      request: "설정된 요청을 확인하고 결과를 요약해 주세요.",
      attachments: [],
      instructionId: 1,
      reason: "소스 구조를 파악한 Claude에게 요청했습니다.",
    });
    event(4, "consult:1", "w1", { type: "text", text: "요청을 확인했고 요약했습니다." });
    event(5, "orch", "orch", {
      type: "consult_end",
      consultId: 1,
      status: "done",
      summary: "설정된 요청을 확인했습니다. 이 요약은 접힌 카드에서도 읽을 수 있습니다.",
      files: [],
    });
    event(6, "orch", "orch", { type: "agent_usage", metrics: { turnId: "shared-turn", inputTokens: 600, outputTokens: 200, cachedInputTokens: 120, cacheWriteInputTokens: 30, elapsedMs: 20_000, model: "claude-opus" } });
    event(7, "w1", "w1", { type: "agent_usage", metrics: { turnId: "shared-turn", inputTokens: 100, outputTokens: 40, cachedInputTokens: 10, cacheWriteInputTokens: 2, elapsedMs: 20_000, model: "claude-sonnet" } });
    event(8, "w2", "w2", { type: "agent_usage", metrics: { turnId: "gpt-turn", inputTokens: 300, outputTokens: 70, cachedInputTokens: 0, cacheWriteInputTokens: 0, elapsedMs: 35_000, model: "gpt-6-astra", approximate: true } });
    // Repeated snapshot replaces this turn; the aggregate must be 50 + 20, not 40 + 50 + 20.
    event(9, "w1", "w1", { type: "agent_usage", metrics: { turnId: "shared-turn", inputTokens: 120, outputTokens: 50, cachedInputTokens: 15, cacheWriteInputTokens: 3, elapsedMs: 25_000, model: "claude-sonnet" } });
    event(10, "w1", "w1", { type: "agent_usage", metrics: { turnId: "second-turn", inputTokens: 80, outputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 1, elapsedMs: 10_000, model: "claude-sonnet" } });
    event(11, "w2", "w2", { type: "image_generation", id: "image-job-1", status: "done", prompt: "A friendly blue robot icon", attachment });
  } finally {
    db.close();
  }
}

function projectRecord() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id = 1").get();
    return JSON.parse(row.settings_json);
  } finally {
    db.close();
  }
}

function windowsEqual(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

async function openSettings(page) {
  const project = page.locator('[data-testid="project-node"]', { hasText: "Delegation UI" });
  await project.getByRole("button", { name: "Delegation UI 메뉴" }).click();
  await page.getByRole("menuitem", { name: "프로젝트 설정" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "프로젝트 설정" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function setMainLinkHooks(app) {
  const installed = await app.evaluate(({ shell, dialog }) => {
    globalThis.__e2eLinkLog = [];
    globalThis.__e2eOpenError = "";
    globalThis.__e2eSaveResult = { canceled: true };
    shell.openPath = async (path) => {
      globalThis.__e2eLinkLog.push({ kind: "openPath", path });
      return globalThis.__e2eOpenError;
    };
    shell.showItemInFolder = (path) => globalThis.__e2eLinkLog.push({ kind: "reveal", path });
    shell.openExternal = async (url) => globalThis.__e2eLinkLog.push({ kind: "openExternal", url });
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      globalThis.__e2eLinkLog.push({ kind: "saveDialog", defaultPath: options?.defaultPath });
      return { ...globalThis.__e2eSaveResult };
    };
    return {
      openPath: shell.openPath.toString().includes("__e2eLinkLog"),
      reveal: shell.showItemInFolder.toString().includes("__e2eLinkLog"),
      openExternal: shell.openExternal.toString().includes("__e2eLinkLog"),
      saveDialog: dialog.showSaveDialog.toString().includes("__e2eLinkLog"),
    };
  });
  if (!Object.values(installed).every(Boolean)) throw new Error(`could not safely stub Electron shell/dialog: ${JSON.stringify(installed)}`);
  return installed;
}

async function mainLog(app) {
  return app.evaluate(() => globalThis.__e2eLinkLog ?? []);
}

async function clickFileAction(page, label, action) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  const actionLabel = action === "open" ? "파일 열기" : action === "reveal" ? "탐색기에서 보기" : "다른 이름으로 저장 (다운로드)";
  await page.getByRole("menuitem", { name: actionLabel, exact: true }).click();
}

async function waitForCall(app, count) {
  for (let i = 0; i < 80; i++) {
    const calls = await mainLog(app);
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return mainLog(app);
}

let app;
let page;
try {
  seedDatabase();
  ({ app, page } = await launch(data));
  page.on("requestfailed", (request) => console.log(`[requestfailed] ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  await page.setViewportSize({ width: 1420, height: 1000 });
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="timeline"]');

  // Older settings rows receive defaults in the app without rewriting storage until Save.
  const listedBefore = (await page.evaluate(() => window.chatterbox.listProjects())).find((p) => p.id === 1);
  check("legacy project settings receive profile defaults", Object.entries(DEFAULT_PROFILE).every(([key, value]) => listedBefore?.settings[key] === value));
  let dialog = await openSettings(page);
  const profileFields = [
    ["claudeStrengths", "클로드가 잘 맡는 작업"],
    ["claudeCautions", "클로드 작업자 주의점"],
    ["gptStrengths", "지피티가 잘 맡는 작업"],
    ["gptCautions", "지피티 작업자 주의점"],
  ];
  const fields = Object.fromEntries(profileFields.map(([key, label]) => [key, dialog.getByRole("textbox", { name: label })]));
  const defaultsVisible = await Promise.all(profileFields.map(async ([key]) => (await fields[key].inputValue()) === DEFAULT_PROFILE[key]));
  check("profile defaults appear in the editable settings form", defaultsVisible.every(Boolean));
  await fields.claudeStrengths.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "profile-defaults.png"), fullPage: true });
  const cancelledProfile = {
    claudeStrengths: "취소할 Claude 강점",
    claudeCautions: "취소할 Claude 주의점",
    gptStrengths: "취소할 GPT 강점",
    gptCautions: "취소할 GPT 주의점",
  };
  for (const [key] of profileFields) await fields[key].fill(cancelledProfile[key]);
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  check("cancel leaves legacy profile fields absent from stored settings", profileFields.every(([key]) => !(key in projectRecord())));

  dialog = await openSettings(page);
  const editable = Object.fromEntries(profileFields.map(([key, label]) => [key, dialog.getByRole("textbox", { name: label })]));
  const savedProfile = {
    claudeStrengths: "Claude 강점: 소스 흐름 분석",
    claudeCautions: "Claude 주의점: 이미지 도구 여부 확인",
    gptStrengths: "GPT 강점: 이미지 생성",
    gptCautions: "GPT 주의점: 실제 도구 사용 여부 확인",
  };
  for (const [key] of profileFields) await editable[key].fill(savedProfile[key]);
  await editable.gptCautions.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, "profile-edited.png"), fullPage: true });
  await dialog.getByRole("button", { name: "저장" }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  check("save persists all four worker profile fields", Object.entries(savedProfile).every(([key, value]) => projectRecord()[key] === value));

  // Completed consult keeps its reason, request, and summary visible while collapsed.
  const consult = page.locator('[data-testid="consult-card"][data-status="done"]');
  await consult.waitFor({ state: "visible" });
  check(
    "completed collapsed consult shows assignment reason, request, and summary",
    (await consult.locator('[data-testid="consult-reason"]').textContent())?.includes("소스 구조를 파악한 Claude") &&
      (await consult.textContent())?.includes("설정된 요청을 확인하고 결과를 요약해 주세요.") &&
      (await consult.locator('[data-testid="consult-summary"]').textContent())?.includes("접힌 카드에서도 읽을 수 있습니다"),
  );

  // The real protocol handler must load the copied fixture through cbx://.
  const image = page.locator('[data-testid="image-generation"][data-role="w2"][data-status="done"] img[src^="cbx://"]');
  await image.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="image-generation"][data-role="w2"] img[src^="cbx://"]');
    return img instanceof HTMLImageElement && img.src.startsWith("cbx://attachment/901") && img.complete && img.naturalWidth > 0;
  }, undefined, { timeout: 5000 }).catch(() => undefined);
  const imageState = await image.evaluate((img) => ({ src: img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }));
  const previewLoaded = imageState.src === "cbx://attachment/901" && imageState.complete && imageState.naturalWidth > 0;
  check("generated image preview loads the isolated cbx attachment", previewLoaded, JSON.stringify(imageState));
  await page.screenshot({ path: join(screenshots, "generated-image-preview.png"), fullPage: true });

  // Per-role totals replace a repeated turn snapshot, keep shared IDs separate, and have details.
  const usage = page.locator('[data-testid="agent-usage-w1"]');
  await usage.click();
  const detailMenu = page.getByRole("menu");
  await detailMenu.waitFor({ state: "visible" });
  const details = await detailMenu.textContent();
  check("worker usage deduplicates turns and exposes token/cache/time details", details?.includes("출력 70") && details.includes("입력 200") && details.includes("캐시 읽기 20") && details.includes("35초"), details);
  await page.screenshot({ path: join(screenshots, "usage-details.png"), fullPage: true });
  await page.keyboard.press("Escape");
  const masterUsage = page.locator('[data-testid="agent-usage-orch"]');
  await masterUsage.click();
  const masterDetails = page.getByRole("menu");
  await masterDetails.waitFor({ state: "visible" });
  const masterText = await masterDetails.textContent();
  check("the same turn id remains isolated in master usage", masterText?.includes("출력 200") && !masterText.includes("270 출력"));
  await page.keyboard.press("Escape");
  check("approximate usage is marked on the GPT role", (await page.locator('[data-testid="agent-usage-w2"]').textContent())?.includes("≈"));
  await page.screenshot({ path: join(screenshots, "delegation-usage-image.png"), fullPage: true });

  // Check local Markdown links through the renderer menu, with every OS effect stubbed.
  const hooks = await setMainLinkHooks(app);
  check("Electron shell and save dialog hooks are installed before use", Object.values(hooks).every(Boolean), JSON.stringify(hooks));
  const relativeButton = page.getByRole("button", { name: "상대 파일", exact: true }).first();
  await relativeButton.click();
  await page.getByRole("menuitem", { name: "파일 열기", exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: join(screenshots, "local-link-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await clickFileAction(page, "상대 파일", "open");
  let calls = await waitForCall(app, 1);
  check("relative Markdown link opens the decoded project file through IPC", calls[0]?.kind === "openPath" && windowsEqual(calls[0].path, relativeFile), JSON.stringify(calls[0]));

  await clickFileAction(page, "절대 파일", "reveal");
  calls = await waitForCall(app, 2);
  check("Windows absolute Markdown link reveals its file through IPC", calls[1]?.kind === "reveal" && windowsEqual(calls[1].path, absoluteFile), JSON.stringify(calls[1]));

  await app.evaluate((_electron, target) => { globalThis.__e2eSaveResult = { canceled: false, filePath: target }; }, saveCopy);
  await clickFileAction(page, "인코딩 파일", "save");
  calls = await waitForCall(app, 3);
  check("encoded relative link opens a save dialog for the decoded filename", calls.some((c) => c.kind === "saveDialog" && c.defaultPath === "encoded name.txt"));
  check("save action copies the exact source bytes inside scratch", existsSync(saveCopy) && readFileSync(saveCopy).equals(readFileSync(encodedFile)), `exists=${existsSync(saveCopy)} path=${saveCopy}`);

  await app.evaluate((_electron, target) => { globalThis.__e2eSaveResult = { canceled: true, filePath: target }; }, cancelCopy);
  await clickFileAction(page, "상대 파일", "save");
  calls = await waitForCall(app, 4);
  check("cancelled save dialog does not create a destination copy", calls.filter((c) => c.kind === "saveDialog").length === 2 && !existsSync(cancelCopy));

  await page.getByRole("link", { name: "웹 문서", exact: true }).click();
  calls = await waitForCall(app, 5);
  check("web Markdown link routes to the external browser IPC", calls.some((c) => c.kind === "openExternal" && c.url === "https://example.com/e2e-doc"));

  await app.evaluate(() => { globalThis.__e2eOpenError = "simulated shell failure"; });
  const shellError = await page.evaluate(async (href) => {
    try {
      await window.chatterbox.linkAction(1, href, "open");
      return "";
    } catch (error) {
      return String(error);
    }
  }, relativeHref);
  check("shell open errors are returned through the renderer IPC promise", shellError.includes("simulated shell failure"), shellError);
  const missingError = await page.evaluate(async () => {
    try {
      await window.chatterbox.linkAction(1, "missing%20file.md", "open");
      return "";
    } catch (error) {
      return String(error);
    }
  });
  check("missing local file reports an IPC error without shell access", missingError.includes("파일이나 폴더를 찾을 수 없습니다"), missingError);
  const blockedError = await page.evaluate(async () => {
    try {
      await window.chatterbox.linkAction(1, "blocked.exe", "open");
      return "";
    } catch (error) {
      return String(error);
    }
  });
  check("executable file is rejected by the open route", blockedError.includes("탐색기에서 보기"), blockedError);

  await app.close();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 500));
  ({ app, page } = await launch(data));
  await page.setViewportSize({ width: 1420, height: 1000 });
  await page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]').click();
  await page.waitForSelector('[data-testid="timeline"]');
  const restartedProject = (await page.evaluate(() => window.chatterbox.listProjects())).find((p) => p.id === 1);
  check("edited worker profiles survive app restart", Object.entries(savedProfile).every(([key, value]) => restartedProject?.settings[key] === value));
  const restartedUsage = page.locator('[data-testid="agent-usage-w1"]');
  await restartedUsage.click();
  const restartedDetails = page.getByRole("menu");
  await restartedDetails.waitFor({ state: "visible" });
  check("usage replay after restart preserves the deduplicated worker total", (await restartedDetails.textContent())?.includes("출력 70"));
  await page.keyboard.press("Escape");
  check("saved local copy remains exact after app restart", existsSync(saveCopy) && readFileSync(saveCopy).equals(readFileSync(encodedFile)));
  await page.screenshot({ path: join(screenshots, "delegation-reloaded.png"), fullPage: true });
} catch (error) {
  console.error(error);
  check("delegation UI verification completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Scratch data and screenshots: ${base}`);
finish();

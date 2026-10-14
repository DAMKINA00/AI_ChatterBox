// Real read-only CLI metadata/quotas, then simulated transient failures in isolated app data.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "gemini-usage-ui", String(Date.now()));
mkdirSync(base, { recursive: true });
const bundle = join(base, "defaults.cjs");
await build({ entryPoints: [join(root, "src/shared/types.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs" });
const { DEFAULT_SETTINGS } = createRequire(import.meta.url)(bundle);
const data = join(base, "data");
let app, page;
try {
  ({ app, page } = await launch(data));
  const cli = await page.evaluate(() => window.chatterbox.cliInfo());
  check("installed Gemini CLI detected without PATH", !!cli.find((c) => c.agent === "gemini")?.path);
  const models = await page.evaluate(() => window.chatterbox.models("gemini"));
  check("actual account models loaded", models.length > 0 && models.every((m) => m.id.startsWith("gemini-")));
  const bar = () => page.locator('[data-testid="usage-bar"]').filter({ hasText: "Gemini" });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="usage-bar"]')].some((e) => /Gemini.*\d+%/.test(e.textContent)), null, { timeout: 45000 });
  const actual = await page.evaluate(() => window.chatterbox.usage());
  check("actual Gemini account quota reaches sidebar", /Gemini\s*(주간|5시간)\s*\d+%/.test(await bar().innerText()), await bar().innerText());
  check("weekly and five-hour values collected", !!actual.gemini?.weekly && !!actual.gemini?.fiveHour && !!actual.gemini?.updatedAt);
  check("all three providers shown", await page.locator('[data-testid="usage-bar"]').count() === 3);
  writeFileSync(join(base, "actual-usage.json"), JSON.stringify(actual, null, 2));

  // First mount fails; opening the menu retries; explicit retry recovers after availability changes.
  await app.evaluate(({ ipcMain }, list) => {
    globalThis.__geminiQueryTest = { count: 0, available: false };
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_e, agent) => {
      if (agent !== "gemini") return [];
      globalThis.__geminiQueryTest.count++;
      if (!globalThis.__geminiQueryTest.available) throw new Error("격리 테스트: 일시적 CLI 탐색 실패");
      return list;
    });
  }, models);
  const chatId = await page.evaluate(async ({ settings, folder }) => {
    const p = await window.chatterbox.createProject({ name: "Gemini 연결 확인", folder, settings });
    return (await window.chatterbox.createChat(p.id)).id;
  }, { settings: DEFAULT_SETTINGS, folder: base });
  await page.reload();
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
  await page.waitForTimeout(300);
  const beforeOpen = await app.evaluate(() => globalThis.__geminiQueryTest.count);
  await page.getByRole("button", { name: "이 채팅의 Gemini 모델", exact: true }).click();
  await page.getByText("격리 테스트: 일시적 CLI 탐색 실패", { exact: false }).waitFor();
  check("failed model query offers retry", await page.getByRole("menuitem", { name: "목록 다시 확인" }).isVisible());
  check("reopening failed picker automatically retries", await app.evaluate(() => globalThis.__geminiQueryTest.count) > beforeOpen);
  await app.evaluate(() => { globalThis.__geminiQueryTest.available = true; });
  await page.getByRole("menuitem", { name: "목록 다시 확인" }).click();
  await page.getByRole("menuitem").filter({ hasText: models[0].label }).first().waitFor();
  check("retry recovers models without restart", await page.getByText("격리 테스트: 일시적 CLI 탐색 실패", { exact: false }).count() === 0);
  await page.screenshot({ path: join(base, "gemini-models.png") });
  await page.keyboard.press("Escape");

  const emit = (gemini) => app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send("usage", u), { ...actual, gemini });
  await emit({ weekly: { usedPercent: 20 }, fiveHour: { usedPercent: 95 }, updatedAt: Date.now() });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="usage-bar"]')].some((e) => /Gemini.*5시간.*5%/.test(e.textContent)));
  check("Gemini near-exhausted five-hour window takes priority", /5시간\s*5%/.test(await bar().innerText()));
  await emit({ error: "격리 테스트: 로그인 상태 확인 필요" });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="usage-bar"]')].some((e) => /Gemini.*조회 실패/.test(e.textContent)));
  check("failure never displays a fabricated or stale percentage", !/%/.test(await bar().innerText()));
  await emit(actual.gemini);
  await page.screenshot({ path: join(base, "gemini-usage-dark.png") });
  await page.evaluate(() => window.chatterbox.setTheme("light"));
  await page.reload();
  await bar().waitFor();
  await page.screenshot({ path: join(base, "gemini-usage-light.png") });
  await app.close();
  app = undefined;

  ({ app, page } = await launch(data));
  await bar().waitFor();
  check("saved Gemini quota restores after restart", /Gemini\s*(주간|5시간)\s*\d+%/.test(await bar().innerText()));
  console.log("Evidence:", base);
} finally { if (app) await app.close(); }
finish();

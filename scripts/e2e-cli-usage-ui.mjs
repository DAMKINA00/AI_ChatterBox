// Isolated usage refresh receipt and provider snapshots; no model prompts are sent.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, root } from "./e2e-lib.mjs";

const data = join(root, ".scratch", "cli-usage-ui", String(Date.now()));
mkdirSync(data, { recursive: true });
let app;
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS ${name}`); count++; };
try {
  const fixture = await launch(data);
  app = fixture.app;
  const page = fixture.page;
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => { if (channel !== "usage") send(channel, ...args); };
    globalThis.fixtureSendUsage = value => send("usage", value);
    for (const channel of ["cli:info", "models:list", "usage:get"]) ipcMain.removeHandler(channel);
    ipcMain.handle("cli:info", () => new Promise(resolve => setTimeout(() => resolve([]), 300)));
    ipcMain.handle("models:list", () => []);
    globalThis.fixtureUsage = { gemini: { error: "fixture timeout" }, grok: { error: "fixture connection" } };
    globalThis.usageRequests = [];
    ipcMain.handle("usage:get", (_e, wait) => {
      globalThis.usageRequests.push(wait);
      if (!wait) {
        setTimeout(() => send("usage", { gemini: { weekly: { usedPercent: 20 } }, grok: { weekly: { usedPercent: 0 } } }), 30);
        return globalThis.fixtureUsage;
      }
      return new Promise(resolve => { globalThis.finishUsage = resolve; });
    });
  });
  await page.reload();
  const button = page.getByTestId("usage-refresh");
  await button.waitFor();
  const gemini = page.getByTestId("usage-bar").filter({ hasText: "제미나이" });
  const grok = page.getByTestId("usage-bar").filter({ hasText: "그록" });
  check("startup keeps fresh usage arriving before CLI initialization completes", (await gemini.textContent()).includes("80%") && (await grok.textContent()).includes("100%"));
  await app.evaluate(() => globalThis.fixtureSendUsage(globalThis.fixtureUsage));
  await gemini.getByText("조회 실패", { exact: true }).waitFor();
  check("cached failures show no invented percentages", (await gemini.textContent()).includes("조회 실패") && !(await gemini.textContent()).includes("%"));
  await button.click();
  check("manual refresh stays disabled while the providers are pending", await button.isDisabled());
  check("manual refresh requests completed results", (await app.evaluate(() => globalThis.usageRequests)).at(-1) === true);
  await app.evaluate(() => {
    globalThis.fixtureUsage = { gemini: { weekly: { usedPercent: 20 }, updatedAt: Date.now() }, grok: { weekly: { usedPercent: 0 }, updatedAt: Date.now() } };
    globalThis.finishUsage(globalThis.fixtureUsage);
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="usage-refresh"]')?.disabled);
  check("Gemini recovery clears the old error and displays real remaining usage", (await gemini.textContent()).includes("80%") && !(await gemini.textContent()).includes("조회 실패"));
  check("Grok zero usage shows a full remaining gauge", (await grok.textContent()).includes("100%") && await grok.locator('[style]').evaluate(element => element.style.width === "100%"));
  await button.click();
  await app.evaluate(() => globalThis.finishUsage({ gemini: { error: "로그인이 필요합니다" }, grok: { monthly: { usedPercent: 25 }, updatedAt: Date.now() } }));
  await page.waitForFunction(() => !document.querySelector('[data-testid="usage-refresh"]')?.disabled);
  check("new errors remove stale percentages", (await gemini.textContent()).includes("조회 실패") && !(await gemini.textContent()).includes("80%"));
  check("monthly Grok allowance is labeled correctly", (await grok.textContent()).includes("월간") && (await grok.textContent()).includes("75%"));
  await page.screenshot({ path: join(data, "usage-refresh.png") });
  console.log(`${count}/${count} passed; evidence: ${data}`);
} finally { await app?.close(); }

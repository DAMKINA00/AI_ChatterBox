// DeepSeek balance UI with mocked IPC. No CLI, network, or paid completion is allowed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "deepseek-balance", String(Date.now()));
const data = join(base, "data");
mkdirSync(join(base, "workspace"), { recursive: true });

let app;
try {
  ({ app } = await launch(data));
  const page = await app.firstWindow();

  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    const state = globalThis.__deepseekBalanceTest = {
      apiKeySet: false,
      connectionState: "unconfigured",
      models: ["deepseek-flash"],
      calls: [],
      paidCalls: 0,
      usageRequests: [],
      usageEvents: [],
      saveEventStart: -1,
      usage: { deepseek: { state: "unconfigured", balances: [] } },
      nextUsage: { deepseek: { state: "ready", isAvailable: true, updatedAt: Date.now(), balances: [
        { currency: "USD", total: "1.46", granted: "0.46", toppedUp: "1.00" },
        { currency: "CNY", total: "8.20", granted: "3.20", toppedUp: "5.00" },
      ] } },
      sendUsage: (value) => {
        state.usageEvents.push(value?.deepseek?.state);
        send("usage", value);
      },
    };
    // Keep late results from the real startup refresh out of this fixture.
    contents.send = (channel, ...args) => { if (channel !== "usage") send(channel, ...args); };
    const status = () => ({
      apiKeySet: state.apiKeySet,
      state: state.connectionState,
      models: state.models,
      ...(state.connectionState === "ready" ? { checkedAt: Date.now() } : {}),
    });
    ipcMain.removeHandler("deepseek");
    ipcMain.handle("deepseek", async (_event, action, input) => {
      state.calls.push({ action, hasInput: input !== undefined, hasApiKey: !!input?.apiKey });
      if (action === "save") {
        if (input?.apiKey) state.apiKeySet = true;
        state.connectionState = state.apiKeySet ? "configured" : "unconfigured";
        state.saveEventStart = state.usageEvents.length;
        state.usage = { deepseek: state.apiKeySet ? { state: "loading", balances: [] } : { state: "unconfigured", balances: [] } };
        state.sendUsage(state.usage);
        return status();
      }
      if (action === "remove") {
        state.apiKeySet = false;
        state.connectionState = "unconfigured";
        state.usage = { deepseek: { state: "unconfigured", balances: [] } };
        state.sendUsage(state.usage);
        return status();
      }
      if (action === "check") {
        state.connectionState = state.apiKeySet ? "ready" : "unconfigured";
        return status();
      }
      if (action === "balance") {
        if (!state.apiKeySet) {
          state.usage = { deepseek: { state: "unconfigured", balances: [] } };
        } else {
          state.usage = state.nextUsage;
        }
        state.sendUsage(state.usage);
        return status();
      }
      if (action === "completion") {
        state.paidCalls++;
        throw new Error("paid completion is forbidden in this fixture");
      }
      return status();
    });
    ipcMain.removeHandler("usage:get");
    ipcMain.handle("usage:get", (_event, wait) => {
      state.usageRequests.push(wait);
      return state.usage;
    });
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => [
      { agent: "claude", path: "C:\\mock\\claude.exe", authStatus: "authenticated" },
      { agent: "codex", path: "C:\\mock\\codex.exe", authStatus: "authenticated" },
      { agent: "gemini", path: "C:\\mock\\gemini.exe", authStatus: "authenticated" },
      { agent: "grok", path: "C:\\mock\\grok.exe", authStatus: "authenticated" },
      { agent: "deepseek", path: null, error: "DeepSeek API 설정에서 API 키를 저장하세요." },
    ]);
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", () => []);
    ipcMain.removeHandler("aistudio:usage");
    ipcMain.handle("aistudio:usage", () => ({
      from: new Date().toISOString(), to: new Date().toISOString(), generatedAt: new Date().toISOString(),
      totals: { requests: 0, succeeded: 0, failed: 0, canceled: 0, rateLimited: 0, inputTokens: 0, cachedTokens: 0, reasoningTokens: 0, replyTokens: 0, totalTokens: 0 },
      groups: { account: [], model: [], channel: [] },
    }));
    ipcMain.removeHandler("aistudio");
    ipcMain.handle("aistudio", () => ({ state: "STOPPED", accounts: [], models: [], cooldowns: [], webLinks: {}, settings: { hasApiKey: false, videoEnabled: false } }));
  });

  await page.reload();
  await page.getByTestId("deepseek-balance").waitFor();
  const summary = page.getByTestId("deepseek-balance");
  const initialSummary = await summary.innerText();
  check("unconfigured balance is distinct from a zero balance", /미설정|조회 전/.test(initialSummary) && !initialSummary.includes("0.00"));

  await summary.click();
  const dialog = page.getByRole("dialog").filter({ hasText: "DeepSeek API" });
  await dialog.waitFor();
  const details = page.getByTestId("deepseek-balance-details");
  await details.waitFor();
  check("balance summary opens DeepSeek settings and exposes the unconfigured state", await dialog.getByTestId("deepseek-status").innerText().then(text => /키 미설정|저장된 키 없음/.test(text)));

  await dialog.getByTestId("deepseek-api-key").fill("sk-test-balance-fixture");
  await dialog.getByTestId("deepseek-save").click();
  await page.getByTestId("deepseek-balance-refresh").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent?.includes("USD 1.46"));
  check("deepseek-save publishes loading then automatic balance refresh reaches ready", await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    const events = s.usageEvents.slice(s.saveEventStart);
    return events.includes("loading") && events.at(-1) === "ready" && s.calls.some(c => c.action === "save") && s.calls.some(c => c.action === "balance");
  }) && /연결 확인됨|키 저장됨/.test(await dialog.getByTestId("deepseek-status").innerText()));

  await dialog.getByTestId("deepseek-balance-refresh").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent?.includes("USD 1.46"));
  const readyDetails = await details.innerText();
  const readySummary = await summary.innerText();
  check("manual refresh calls the balance action and keeps the existing status return", await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    return s.calls.some(c => c.action === "balance") && s.calls.every(c => c.action !== "completion") && s.paidCalls === 0;
  }) && /연결 확인됨|키 저장됨/.test(await dialog.getByTestId("deepseek-status").innerText()));
  check("USD keeps its exact total and separates topped-up and granted amounts", readyDetails.includes("총 사용 가능") && readyDetails.includes("USD 1.46") && readyDetails.includes("충전") && readyDetails.includes("USD 1.00") && readyDetails.includes("지급") && readyDetails.includes("USD 0.46"));
  check("sidebar truncates USD to one decimal while details keep both currencies and the exact gauge", readySummary.includes("1.4$") && !readySummary.includes("¥") && readyDetails.includes("CNY 8.20") && await summary.locator('[role="progressbar"]').getAttribute("aria-valuenow") === "14.6" && await details.getByRole("progressbar").count() === 1 && readyDetails.includes("$10 기준"));
  check("the rendered gauge width uses the USD balance", await summary.locator('[role="progressbar"] > div').evaluate(el => Math.abs(parseFloat(el.style.width) - 14.6) < 0.001));
  check("balance details include the query time", /조회|확인/.test(readyDetails));
  await page.screenshot({ path: join(base, "deepseek-balance.png") });

  for (const [amount, formatted, expected] of [["10.00", "10.0$", "100"], ["12.50", "12.5$", "100"], ["-0.20", "-0.2$", "0"], ["6", "6.0$", "60"]]) {
    await app.evaluate((_electron, value) => {
      const s = globalThis.__deepseekBalanceTest;
      s.usage = { deepseek: { state: "ready", isAvailable: true, updatedAt: Date.now(), balances: [{ currency: "USD", total: value, granted: "0.00", toppedUp: value }] } };
      s.sendUsage(s.usage);
    }, amount);
    await page.waitForFunction(value => document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent?.includes(`USD ${value}`), amount);
    check(`USD ${amount} displays ${formatted}, preserves detail precision and uses ${expected} percent`, (await summary.innerText()).includes(formatted) && (await details.innerText()).includes(`USD ${amount}`) && await summary.locator('[role="progressbar"]').getAttribute("aria-valuenow") === expected);
  }

  await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    s.usage = { deepseek: { state: "ready", isAvailable: true, updatedAt: Date.now(), balances: [{ currency: "CNY", total: "8.20", granted: "3.20", toppedUp: "5.00" }] } };
    s.sendUsage(s.usage);
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="deepseek-balance"] [role="progressbar"]'));
  check("CNY alone is displayed without assuming a dollar conversion", (await summary.innerText()).includes("8.2¥") && (await details.innerText()).includes("CNY 8.20") && await details.getByRole("progressbar").count() === 0);

  await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    s.nextUsage = { deepseek: { state: "ready", isAvailable: true, updatedAt: Date.now(), balances: [{ currency: "USD", total: "0.00", granted: "0.00", toppedUp: "0.00" }] } };
    s.usage = s.nextUsage;
    s.sendUsage(s.usage);
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent?.includes("USD 0.00"));
  const zeroDetails = await details.innerText();
  const zeroSummary = await summary.innerText();
  check("a reported zero balance has an empty gauge rather than being treated as not queried", zeroSummary.includes("0.0$") && zeroDetails.includes("USD 0.00") && !/미조회|조회 중|키 미설정/.test(zeroDetails) && await summary.locator('[role="progressbar"]').getAttribute("aria-valuenow") === "0");

  await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    s.nextUsage = { deepseek: { state: "error", balances: [], updatedAt: Date.now(), error: "잔고 조회 실패" } };
    s.usage = s.nextUsage;
    s.sendUsage(s.usage);
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent?.includes("잔고 조회 실패"));
  const errorDetails = await details.innerText();
  const errorSummary = await summary.innerText();
  check("balance failure hides stale monetary values and the gauge", /실패|오류/.test(errorDetails) && !/[0-9]+\.[0-9]{2}/.test(errorDetails) && !/[0-9]+\.[0-9]{2}/.test(errorSummary) && await summary.locator('[role="progressbar"]').count() === 0);

  await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    s.nextUsage = { deepseek: { state: "ready", isAvailable: false, updatedAt: Date.now(), balances: [{ currency: "USD", total: "0.00", granted: "0.00", toppedUp: "0.00" }] } };
    s.usage = s.nextUsage;
    s.sendUsage(s.usage);
  });
  await page.waitForFunction(() => /잔고 부족|잔액 부족|사용 불가/.test(document.querySelector('[data-testid="deepseek-balance-details"]')?.textContent ?? ""));
  const shortageDetails = await details.innerText();
  check("isAvailable=false shows a shortage independently of model connection status", /잔고 부족|잔액 부족|사용 불가/.test(shortageDetails) && /연결 확인됨|키 저장됨/.test(await dialog.getByTestId("deepseek-status").innerText()));

  await dialog.getByText("닫기", { exact: true }).click();
  await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    s.nextUsage = { deepseek: { state: "ready", isAvailable: true, updatedAt: Date.now(), balances: [{ currency: "USD", total: "6.46", granted: "0.00", toppedUp: "6.46" }] } };
    s.usage = s.nextUsage;
    s.sendUsage(s.usage);
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="deepseek-balance"]')?.textContent?.includes("6.4$"));
  check("USD 6.46 displays 6.4 dollars without rounding the 64.6 percent gauge", await summary.getByRole("progressbar").getAttribute("aria-valuenow") === "64.6");
  check("DeepSeek name, gauge and amount align with the other provider columns on one row", await page.evaluate(() => {
    const reference = document.querySelector('[data-testid="usage-bar"]');
    const row = document.querySelector('[data-testid="deepseek-balance"]');
    if (!reference || !row || reference.children.length !== 3 || row.children.length !== 3) return false;
    const bounds = row.getBoundingClientRect();
    return Math.abs(bounds.height - reference.getBoundingClientRect().height) < 1 && Array.from(row.children).every((child, i) => {
      const actual = child.getBoundingClientRect();
      const expected = reference.children[i].getBoundingClientRect();
      return Math.abs(actual.x - expected.x) < 1 && Math.abs(actual.width - expected.width) < 1 && Math.abs(actual.y + actual.height / 2 - bounds.y - bounds.height / 2) < 1;
    });
  }));
  await summary.hover();
  await page.getByRole("tooltip").filter({ hasText: "USD 총 6.46" }).waitFor();
  check("sidebar tooltip preserves the full USD balance", (await page.getByRole("tooltip").innerText()).includes("USD 총 6.46"));
  await page.keyboard.press("Escape");
  await page.mouse.move(600, 100);
  await page.getByRole("tooltip").waitFor({ state: "hidden" });
  await page.screenshot({ path: join(base, "deepseek-inline-balance.png") });
  await page.getByTestId("usage-refresh").click();
  await page.waitForTimeout(80);
  check("global usage refresh requests a completed usage snapshot", await app.evaluate(() => globalThis.__deepseekBalanceTest.usageRequests.includes(true)));

  await summary.click();
  const reopenedDialog = page.getByRole("dialog").filter({ hasText: "DeepSeek API" });
  await reopenedDialog.waitFor();
  check("opening the compact 6.4 dollar row reveals the exact 6.46 dollar total", (await details.innerText()).includes("USD 6.46"));
  await reopenedDialog.getByTestId("deepseek-remove").click();
  await reopenedDialog.getByTestId("deepseek-status").getByText("키 미설정", { exact: true }).waitFor();
  await page.waitForTimeout(80);
  check("deepseek-remove publishes unconfigured usage and clears the old balance", await app.evaluate(() => {
    const s = globalThis.__deepseekBalanceTest;
    return s.usage.deepseek.state === "unconfigured" && s.usage.deepseek.balances.length === 0 && s.calls.some(c => c.action === "remove");
  }) && !(await details.innerText()).includes("0.00"));
} catch (error) {
  console.error(error);
  check("DeepSeek balance UI flow completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`evidence: ${base}`);
finish();

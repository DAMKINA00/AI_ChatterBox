// Isolated Gemini web account/worker UI verification. No browser login or model turn is started.
// Run after the production build: node scripts/e2e-gemini-web-ui.mjs
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeChecks, launch, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const base = join(root, ".scratch", "gemini-web-ui", String(Date.now()));
const data = join(base, "data");
const workspace = join(base, "workspace");
const screenshots = join(base, "screenshots");
mkdirSync(workspace, { recursive: true });
mkdirSync(screenshots, { recursive: true });

const settings = {
  claudeStrengths: "",
  claudeCautions: "",
  gptStrengths: "",
  gptCautions: "",
  geminiStrengths: "문장 다듬기·캐릭터 대사·문서 본문",
  geminiCautions: "웹·CLI 글쓰기 전용 · 로컬 파일 반영은 Claude/GPT",
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
  maxClaudeWorkers: 1,
  maxGptWorkers: 1,
  maxGeminiWorkers: 1,
  approvalMode: "orchestrator",
  delegateHighRisk: false,
};

function usage(status, detail, extra = {}) {
  return { status, detail, checkedAt: Date.now(), ...extra };
}

async function installMocks(app) {
  await app.evaluate(({ ipcMain }) => {
    const state = {
      phase: "closed",
      calls: [],
      usage: { status: "unknown", detail: "웹 계정 1에 로그인하세요.", checkedAt: Date.now() },
    };
    const status = () => ({
      accountId: "gemini-1",
      state: state.phase,
      message:
        state.phase === "closed"
          ? "웹 계정 1에 로그인하세요."
          : state.phase === "login_required"
            ? "전용 브라우저에서 Google 계정 로그인을 완료하세요."
            : state.phase === "ready"
              ? "계정 1 · Argon 연결 준비 완료"
              : state.phase === "busy"
                ? "웹 계정 1 작업 중"
                : "웹 상태를 읽지 못했습니다.",
      ...(state.phase === "ready" || state.phase === "busy" ? { model: "Gemini 4 Argon" } : {}),
      checkedAt: Date.now(),
      usage: state.usage,
    });

    globalThis.__geminiWebUiTest = state;
    ipcMain.removeHandler("cli:info");
    ipcMain.handle("cli:info", () => [
      { agent: "claude", path: "C:\\mock\\claude.exe" },
      { agent: "codex", path: "C:\\mock\\codex.exe" },
      { agent: "gemini", path: "C:\\mock\\agy.exe" },
    ]);
    ipcMain.removeHandler("models:list");
    ipcMain.handle("models:list", (_event, agent) => agent === "gemini" ? [
      { id: "gemini-cli-test", label: "Gemini CLI 테스트 모델", reasoningEfforts: ["medium", "high", "xhigh"] },
      { id: "gemini-web-argon", label: "Gemini 웹 · Argon (계정 1)" },
    ] : []);
    ipcMain.removeHandler("usage:get");
    ipcMain.handle("usage:get", () => ({ geminiWeb: state.usage }));
    ipcMain.removeHandler("gemini:web");
    ipcMain.handle("gemini:web", (_event, action) => {
      state.calls.push(action);
      if (action === "open") state.phase = "login_required";
      return status();
    });
  });
  // Ensure the renderer starts after every model/usage-related handler is mocked.
  await (await app.firstWindow()).reload();
}

async function mockState(app, patch) {
  await app.evaluate((_electron, next) => Object.assign(globalThis.__geminiWebUiTest, next), patch);
}

async function calls(app) {
  return app.evaluate(() => [...globalThis.__geminiWebUiTest.calls]);
}

async function pushUsage(app, nextUsage) {
  await app.evaluate(({ BrowserWindow }, next) => {
    globalThis.__geminiWebUiTest.usage = next;
    BrowserWindow.getAllWindows()[0].webContents.send("usage", { geminiWeb: next });
  }, nextUsage);
}

let app;
let page;
try {
  ({ app, page } = await launch(data));
  await installMocks(app);

  const chatId = await page.evaluate(async ({ folder, projectSettings }) => {
    const project = await window.chatterbox.createProject({ name: "Gemini 웹 UI 점검", folder, settings: projectSettings });
    const chat = await window.chatterbox.createChat(project.id);
    return chat.id;
  }, { folder: workspace, projectSettings: settings });
  await page.reload();
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
  await page.getByLabel("이 채팅의 Gemini 모델", { exact: true }).waitFor();

  const picker = page.getByLabel("이 채팅의 Gemini 모델", { exact: true });
  await picker.click();
  check("Gemini CLI model remains in the web-enabled picker", await page.getByRole("menuitem", { name: /Gemini CLI 테스트 모델/ }).count() === 1);
  check("Gemini web model id is offered", await page.getByRole("menuitem", { name: /gemini-web-argon/ }).count() === 1);
  const connect = page.getByRole("menuitem", { name: "웹 계정 1 연결…", exact: true });
  check("web account connection menu item is present", await connect.count() === 1);
  const beforeDialog = await calls(app);
  await connect.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Gemini 웹 계정 1" });
  await dialog.waitFor({ state: "visible" });
  await page.getByTestId("gemini-web-status").getByText("브라우저 닫힘", { exact: true }).waitFor();
  const afterStatus = await calls(app);
  check("opening the connection dialog only checks status", afterStatus.length > beforeDialog.length && !afterStatus.includes("open"), JSON.stringify(afterStatus));
  check("Argon use stays disabled before login", await page.getByTestId("gemini-web-use-argon").isDisabled());

  await page.getByTestId("gemini-web-open").click();
  await dialog.getByText("로그인 필요", { exact: true }).waitFor();
  let webCalls = await calls(app);
  check("browser opening is explicit and recorded once", webCalls.filter((action) => action === "open").length === 1, JSON.stringify(webCalls));

  await mockState(app, {
    phase: "ready",
    usage: usage("available", "Argon 사용 가능", {
      current: { usedPercent: 2, resetText: "오후 8:45" },
      weekly: { usedPercent: 0, resetText: "10월 21일" },
    }),
  });
  await page.getByTestId("gemini-web-refresh").click();
  await dialog.getByText("사용 가능", { exact: true }).waitFor();
  check("login recovery reports a ready web account", await page.getByTestId("gemini-web-status").getByText("사용 가능", { exact: true }).count() === 1);
  check("Argon use enables after ready status", !(await page.getByTestId("gemini-web-use-argon").isDisabled()));
  check("dialog shows both web quota windows", (await dialog.getByTestId("gemini-web-usage").innerText()).includes("현재 98% 남음") && (await dialog.getByTestId("gemini-web-usage").innerText()).includes("주간 100% 남음"));

  await page.getByTestId("gemini-web-use-argon").click();
  await page.waitForFunction(async () => (await window.chatterbox.listChats()).some((chat) => chat.geminiModelOverride === "gemini-web-argon"));
  check("Argon action selects the web model id", (await page.evaluate(async (id) => (await window.chatterbox.listChats()).find((chat) => chat.id === id)?.geminiModelOverride, chatId)) === "gemini-web-argon");
  const effort = page.getByLabel("이 채팅의 Gemini 추론 수준", { exact: true });
  await effort.waitFor();
  check("web effort picker is disabled", await effort.isDisabled());
  check("web effort picker explains unavailable CLI levels", (await effort.getAttribute("title"))?.includes("medium") && (await effort.getAttribute("title"))?.includes("xhigh"));

  const webBar = page.locator('[data-testid="usage-bar"][data-provider="gemini-web"]');
  await pushUsage(app, usage("available", "웹 사용량 확인 완료", {
    current: { usedPercent: 2, resetText: "오후 8:45" },
    weekly: { usedPercent: 0, resetText: "10월 21일" },
  }));
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-provider="gemini-web"]');
    return row?.textContent?.includes("주간") && row.textContent.includes("100%");
  });
  const numericText = await webBar.innerText();
  check("numeric web usage shows weekly remaining and bar", numericText.includes("주간") && numericText.includes("100%"), numericText);
  const numericTip = await webBar.getAttribute("title");
  check("web usage tooltip includes both windows and reset details", numericTip?.includes("현재 2% 사용") && numericTip.includes("주간 0% 사용") && numericTip.includes("오후 8:45") && numericTip.includes("10월 21일") && numericTip.includes("조회"), numericTip);
  check("CLI usage row keeps its provider name", await page.locator('[data-testid="usage-bar"]').filter({ hasText: "Gemini CLI" }).count() === 1);

  await pushUsage(app, usage("unknown", "웹 사용량을 알 수 없습니다."));
  await webBar.getByText("웹 사용량을 알 수 없습니다.", { exact: true }).waitFor();
  check("unknown web usage shows detail without a fabricated percentage", !(await webBar.innerText()).includes("%"));

  await pushUsage(app, usage("limited", "웹 사용량 제한", {
    current: { usedPercent: 95, resetText: "내일" },
    weekly: { usedPercent: 20, resetText: "10월 21일" },
  }));
  await page.waitForFunction(() => document.querySelector('[data-provider="gemini-web"]')?.textContent?.includes("현재") && document.querySelector('[data-provider="gemini-web"]')?.textContent?.includes("5%"));
  check("limited web usage shows current remaining when low", (await webBar.innerText()).includes("현재") && (await webBar.innerText()).includes("5%") && (await webBar.getAttribute("title"))?.includes("웹 사용량 제한"));

  await pushUsage(app, usage("available", "잘못된 수치는 무시됨", {
    current: { usedPercent: -1, resetText: "무시" },
    weekly: { usedPercent: 101, resetText: "무시" },
  }));
  await webBar.getByText("잘못된 수치는 무시됨", { exact: true }).waitFor();
  check("out-of-range web percentages are ignored", !(await webBar.innerText()).includes("%"), await webBar.innerText());

  await pushUsage(app, usage("error", "웹 사용량 조회 실패"));
  await webBar.getByText("웹 사용량 조회 실패", { exact: true }).waitFor();
  check("web usage errors show detail without stale percentages", !(await webBar.innerText()).includes("%"));

  await pushUsage(app, usage("available", "웹 사용량 확인 완료", {
    current: { usedPercent: 2, resetText: "오후 8:45" },
    weekly: { usedPercent: 0, resetText: "10월 21일" },
  }));
  await webBar.getByRole("button", { name: "Gemini 웹 사용량 새로 확인" }).click();
  await page.waitForFunction(() => document.querySelector('[data-provider="gemini-web"]')?.textContent?.includes("100%"));
  webCalls = await calls(app);
  check("web usage refresh uses the web refresh IPC", webCalls.filter((action) => action === "refresh").length >= 2, JSON.stringify(webCalls));
  check("usage updates never open a browser implicitly", webCalls.filter((action) => action === "open").length === 1, JSON.stringify(webCalls));

  await picker.click();
  await page.getByRole("menuitem", { name: "웹 계정 1 연결…", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  await dialog.getByText("사용 가능", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "gemini-web-dark.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByLabel("테마 전환", { exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await picker.click();
  await page.getByRole("menuitem", { name: "웹 계정 1 연결…", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  await dialog.getByText("사용 가능", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "gemini-web-light.png"), fullPage: true });
  await page.keyboard.press("Escape");
  check("dark and light web UI screenshots are kept in scratch", existsSync(join(screenshots, "gemini-web-dark.png")) && existsSync(join(screenshots, "gemini-web-light.png")));
} catch (error) {
  console.error(error);
  check("Gemini web UI verification completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await app?.close().catch(() => undefined);
}

console.log(`Scratch data and screenshots: ${base}`);
finish();

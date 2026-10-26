import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const bundle = await build({
  stdin: { contents: `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { CliAccountsDialog } from "./src/renderer/src/components/CliAccountsDialog";
    import { ModelPicker } from "./src/renderer/src/components/ModelPicker";
    import { UsageBar } from "./src/renderer/src/components/Usage";
    import { useStore } from "./src/renderer/src/store";
    import { ProjectDialog } from "./src/renderer/src/components/ProjectDialog";
    import { TooltipProvider } from "./src/renderer/src/components/ui";
    let projectMount = 0;
    let modelValue = "";
    window.uiStore = useStore;
    const root = createRoot(document.getElementById("root"));
    window.showAccounts = () => root.render(<TooltipProvider><CliAccountsDialog open onOpenChange={() => {}} /></TooltipProvider>);
    window.showProject = (settings = {}) => root.render(<TooltipProvider><ProjectDialog key={++projectMount} open onOpenChange={() => {}} project={{ id: 1, name: "계정 테스트", folder: "C:/Apps", settings, createdAt: 0 }} /></TooltipProvider>);
    window.showUsage = () => root.render(<TooltipProvider><UsageBar /></TooltipProvider>);
    window.showModel = (agents, value) => { modelValue = value; root.render(<TooltipProvider><ModelPicker agents={agents} value={value} onChange={next => { modelValue = next; }} ariaLabel="모델 테스트" /></TooltipProvider>); };
    window.getModelValue = () => modelValue;
    window.showAccounts();
  `, resolveDir: process.cwd(), sourcefile: "cli-accounts-ui-harness.tsx", loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "error",
});
const cssName = readdirSync("out/renderer/assets").find(name => name.endsWith(".css"));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ body: '<html><head></head><body><div id="root"></div></body></html>', contentType: "text/html" }));
  await page.goto("http://cli-accounts-ui.test");
  await page.addStyleTag({ content: readFileSync("out/renderer/assets/" + cssName, "utf8") });
  await page.evaluate(() => {
    const make = (kind, n) => ({ accountId: kind + "-" + n, kind, label: kind + " 계정 " + n, configDir: n === 1 ? null : "test", createdAt: Date.now(), enabled: true, isDefault: n === 1, runningWorkers: 0, authStatus: n === 1 ? "required" : "unknown", auth: n === 1 ? { loggedIn: false, checkedAt: Date.now() } : undefined, usage: { checkedAt: Date.now() } });
    let accounts = ["claude", "gpt", "grok"].map(kind => make(kind, 1));
    let policies = { grok: { mode: "auto" } };
    const projects = [{ id: 1, name: "계정 테스트", folder: "C:/Apps", settings: { accountPolicy: { claude: { mode: "fixed", accountId: "claude-2" } } } }];
    window.dropAccount = id => { accounts = accounts.filter(a => a.accountId !== id); };
    window.calls = [];
    window.setBusy = count => { accounts.find(a => a.accountId === "claude-2").runningWorkers = count; };
    const copy = value => JSON.parse(JSON.stringify(value));
    const record = (name, ...args) => window.calls.push([name, ...args]);
    window.chatterbox = {
      cliAccounts: {
        list: async () => { if (window.failList) throw new Error("계정 목록 조회 실패"); return copy(accounts); },
        getPolicy: async () => copy(policies),
        setPolicy: async value => { record("policy", value); policies = value; return copy(policies); },
        create: async kind => { record("create", kind); const next = make(kind, accounts.filter(a => a.kind === kind).length + 1); accounts.push(next); return copy(accounts); },
        update: async (id, patch) => { record("update", id, patch); Object.assign(accounts.find(a => a.accountId === id), patch); return copy(accounts); },
        login: async id => { record("login", id); if (window.failLogin) { window.failLogin = false; throw new Error("로그인 콘솔을 열지 못했습니다"); } Object.assign(accounts.find(a => a.accountId === id), { authStatus: "unknown", auth: undefined, usage: undefined, remainingPercent: undefined }); },
        refresh: async id => { record("refresh", id); Object.assign(accounts.find(a => a.accountId === id), { authStatus: "authenticated", auth: { loggedIn: true, checkedAt: Date.now(), email: "member@example.com" }, remainingPercent: 60, usage: { checkedAt: Date.now(), fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 40 } } }); return copy(accounts); },
        logout: async id => { record("logout", id); Object.assign(accounts.find(a => a.accountId === id), { authStatus: "required", auth: { loggedIn: false, checkedAt: Date.now() }, remainingPercent: undefined, usage: { checkedAt: Date.now() } }); return copy(accounts); },
        remove: async id => { record("remove", id); accounts = accounts.filter(a => a.accountId !== id); for (const project of projects) for (const [kind, policy] of Object.entries(project.settings.accountPolicy)) if (policy.accountId === id) delete project.settings.accountPolicy[kind]; return copy(accounts); },
      },
      usage: async wait => { record("usage", wait); if (window.failUsage) throw new Error("사용량 조회 실패"); return window.usageValue ?? { accounts: Object.fromEntries(accounts.map(a => [a.accountId, copy(a.usage ?? {})])) }; },
      listProjects: async () => { record("listProjects"); return copy(projects); },
      models: async () => [],
      cliInfo: async () => [],
      updateProject: async (id, patch) => { record("project", id, patch); return { id, ...patch }; },
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const card = id => page.locator('[data-testid="cli-account"][data-account-id="' + id + '"]');
  await card("claude-1").waitFor();
  check(await card("claude-1").getByRole("button", { name: "삭제", exact: true }).isDisabled(), "default account delete disabled");
  check(await card("claude-1").getByText("기본", { exact: true }).isVisible(), "default badge shown");
  check(await page.getByTestId("cli-new-account-note").isVisible(), "new account settings and plugins notice shown");
  check(await card("claude-1").getByRole("checkbox").isDisabled(), "default account assignment exclusion disabled");
  await card("claude-1").getByRole("button", { name: "로그아웃", exact: true }).click();
  check(await page.getByRole("alert").filter({ hasText: "평소 터미널에서 쓰는 기본 CLI 로그인" }).isVisible(), "default logout warns about terminal login");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await card("claude-1").getByRole("button", { name: "로그인", exact: true }).click();
  await card("claude-1").getByText("로그인 상태 미확인", { exact: true }).waitFor();
  check(await page.evaluate(() => window.uiStore.getState().cliAccounts.find(a => a.accountId === "claude-1").authStatus === "unknown"), "login reloads reset authentication state from backend");
  check(await page.getByText("특정 계정 지정: 이 계정만 사용, 한도 소진 시 멈추고 알림 / 자동 선택: 마스터가 계정별 잔여량을 보고 배분").isVisible(), "global mode description matches fixed policy decision");
  const create = page.getByTestId("cli-account-create");
  await create.click();
  await card("claude-2").waitFor();
  check(await page.getByTestId("cli-account").count() === 2, "new account card created");
  check(await card("claude-2").getByText("로그인 상태 미확인", { exact: true }).isVisible(), "new account authentication remains unknown");
  await page.evaluate(() => { window.failLogin = true; });
  await card("claude-2").getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "로그인 콘솔을 열지 못했습니다" }).waitFor();
  check(await create.isEnabled(), "IPC rejection restores available controls");
  await card("claude-2").getByRole("button", { name: "로그인", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "로그인 콘솔을 열었습니다" }).waitFor();
  check(await page.evaluate(() => window.calls.some(c => c[0] === "login" && c[1] === "claude-2")), "login invokes selected id");
  check(await card("claude-2").getByText("로그인 상태 미확인", { exact: true }).isVisible(), "opening login console does not imply completed authentication");
  check(await card("claude-2").getByText("로그인 창에서 로그인을 마친 뒤 상태 새로고침을 눌러주세요.", { exact: true }).isVisible(), "login completion and refresh guidance shown");
  await card("claude-2").getByRole("button", { name: "상태 새로고침" }).click();
  await card("claude-2").getByText("로그인됨 · member@example.com").waitFor();
  check(await card("claude-2").getByRole("progressbar", { name: "claude-2 5시간 잔여량" }).getAttribute("aria-valuenow") === "80", "refreshed remaining quota displayed");
  await page.evaluate(() => window.setBusy(1));
  await card("claude-2").getByRole("button", { name: "상태 새로고침" }).click();
  await card("claude-2").getByText("배분 참고 잔여량: 60% · 실행 중 1명").waitFor();
  check(await card("claude-2").getByRole("checkbox").isDisabled(), "running worker blocks assignment exclusion");
  for (const name of ["로그인", "로그아웃", "삭제"]) check(await card("claude-2").getByRole("button", { name, exact: true }).isDisabled(), "running worker disables " + name);
  await page.evaluate(() => window.setBusy(0));
  await card("claude-2").getByRole("button", { name: "상태 새로고침" }).click();
  await card("claude-2").getByText("배분 참고 잔여량: 60% · 실행 중 0명").waitFor();
  await card("claude-2").getByRole("textbox", { name: "claude-2 이름" }).fill("보조 계정");
  await card("claude-2").getByRole("button", { name: "이름 저장" }).click();
  await page.getByRole("option", { name: /보조 계정/ }).waitFor({ state: "attached" });
  await card("claude-2").getByRole("checkbox").uncheck();
  await page.waitForFunction(() => window.calls.some(c => c[0] === "update" && c[2].enabled === false));
  check(await card("claude-2").getByRole("checkbox").isChecked() === false, "assignment exclusion saved");
  await card("claude-2").getByRole("checkbox").check();
  await page.getByRole("combobox", { name: "Claude 지정 계정" }).selectOption("claude-2");
  await page.waitForFunction(() => window.calls.some(c => c[0] === "policy" && c[1].claude?.accountId === "claude-2"));
  checks++;
  check(await page.evaluate(() => window.calls.filter(c => c[0] === "policy").every(c => c[1].grok.mode === "auto")), "whole-policy replacement preserves other families");
  await page.getByRole("combobox", { name: "Claude 계정 선택 모드" }).selectOption("auto");
  await page.waitForFunction(() => window.calls.some(c => c[0] === "policy" && c[1].claude?.mode === "auto"));
  check(await page.getByRole("combobox", { name: "Claude 지정 계정" }).count() === 0, "automatic policy hides fixed picker");
  await card("claude-2").getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByRole("button", { name: "로그아웃 확인" }).click();
  await card("claude-2").getByText("로그인 필요", { exact: true }).waitFor();
  checks++;
  await card("claude-2").getByRole("button", { name: "삭제", exact: true }).click();
  check(!await page.evaluate(() => window.calls.some(c => c[0] === "remove")), "delete requires confirmation");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  check(await card("claude-2").count() === 1, "delete cancellation preserves account");
  await card("claude-2").getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제 확인" }).click();
  await card("claude-2").waitFor({ state: "detached" });
  checks++;
  await page.waitForFunction(() => window.calls.some(c => c[0] === "listProjects"));
  check(await page.evaluate(() => !window.uiStore.getState().projects[0].settings.accountPolicy.claude), "deletion reloads cleaned project policies into store");
  for (let n = 2; n <= 10; n++) {
    await create.click();
    await page.waitForFunction(expected => document.querySelectorAll('[data-testid="cli-account"]').length === expected, n);
    await page.waitForFunction(() => !document.querySelector('[aria-label="CLI 계열"] button').disabled);
  }
  check(await create.isDisabled(), "creation blocked at ten accounts");
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await card("gpt-1").waitFor();
  check(await page.getByTestId("cli-account").count() === 1, "family tabs isolate accounts");
  await page.evaluate(() => window.showProject());
  await page.getByTestId("project-cli-account-policy").waitFor();
  check(await page.getByRole("combobox", { name: "Claude 계정 선택 모드" }).inputValue() === "inherit", "project defaults to global policy");
  await page.getByRole("combobox", { name: "Claude 계정 선택 모드" }).selectOption("auto");
  await page.getByRole("combobox", { name: "Codex 계정 선택 모드" }).selectOption("fixed");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === "project"));
  const saved = await page.evaluate(() => window.calls.find(c => c[0] === "project")[2].settings.accountPolicy);
  check(saved.claude.mode === "auto" && saved.gpt.mode === "fixed" && saved.gpt.accountId === "gpt-1" && !saved.grok, "project overrides save per family");
  await page.evaluate(() => window.showProject({ accountPolicy: { claude: { mode: "fixed", accountId: "claude-2" }, gpt: { mode: "fixed", accountId: "gpt-9" }, grok: { mode: "auto" } } }));
  await page.waitForFunction(() => {
    const field = document.querySelector('[aria-label="Claude 계정 선택 모드"]');
    return field && !field.disabled && field.value === "fixed";
  });
  check(await page.getByRole("combobox", { name: "Codex 계정 선택 모드" }).inputValue() === "inherit", "missing project account displays global inheritance");
  check(await page.getByText("이 프로젝트에 적용할 계정 선택 모드입니다. 변경은 다음 배정부터 적용됩니다.").isVisible(), "project policy timing says next assignment");
  await page.evaluate(() => { window.dropAccount("claude-2"); window.calls = []; });
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === "project"));
  const cleaned = await page.evaluate(() => window.calls.find(c => c[0] === "project")[2].settings.accountPolicy);
  check(!cleaned.claude && !cleaned.gpt && cleaned.grok.mode === "auto", "save rechecks live accounts and removes vanished fixed selections");
  await page.evaluate(() => window.showProject({ codexModel: "gpt-save-with-cached-accounts", accountPolicy: { gpt: { mode: "fixed", accountId: "gpt-1" }, grok: { mode: "fixed", accountId: "grok-9" } } }));
  await page.waitForFunction(() => !document.querySelector('[aria-label="Codex 계정 선택 모드"]').disabled);
  await page.getByRole("textbox", { name: "이름", exact: true }).fill("목록 실패에도 저장");
  await page.evaluate(() => { window.failList = true; window.calls = []; });
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === "project"));
  const cachedSave = await page.evaluate(() => window.calls.find(c => c[0] === "project")[2]);
  check(cachedSave.name === "목록 실패에도 저장" && cachedSave.settings.codexModel === "gpt-save-with-cached-accounts", "account refresh failure does not block unrelated project settings");
  check(cachedSave.settings.accountPolicy.gpt.accountId === "gpt-1" && !cachedSave.settings.accountPolicy.grok, "save falls back to last known accounts for policy cleanup");
  await page.evaluate(() => { window.calls = []; window.showProject({ codexModel: "gpt-save-without-accounts", accountPolicy: { gpt: { mode: "fixed", accountId: "gpt-1" } } }); });
  await page.getByRole("alert").filter({ hasText: "계정 목록 조회 실패" }).waitFor();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === "project"));
  const unknownSave = await page.evaluate(() => window.calls.find(c => c[0] === "project")[2].settings);
  check(unknownSave.codexModel === "gpt-save-without-accounts" && unknownSave.accountPolicy.gpt.accountId === "gpt-1", "save preserves policy for server validation when no account list was ever loaded");
  await page.evaluate(() => {
    window.failList = true;
    window.usageValue = { codex: { weekly: { usedPercent: 17 } } };
    window.uiStore.setState({ cliAccounts: [] });
    window.showUsage();
  });
  await page.getByTestId("usage-refresh").click();
  await page.waitForFunction(() => window.uiStore.getState().usage.codex?.weekly?.usedPercent === 17);
  check(await page.getByTestId("usage-bar").filter({ hasText: "지피티" }).getByText("83%", { exact: true }).isVisible(), "account-list rejection does not block refreshed usage");
  await page.evaluate(() => { window.failList = false; window.failUsage = true; });
  await page.getByTestId("usage-refresh").click();
  await page.waitForFunction(() => window.uiStore.getState().cliAccounts.length > 0);
  check(await page.evaluate(() => window.uiStore.getState().usage.codex.weekly.usedPercent === 17), "usage rejection preserves last successful quota while accounts refresh");
  await page.evaluate(() => window.showModel(["gemini"], ""));
  const geminiModelPicker = page.getByRole("button", { name: "모델 테스트", exact: true });
  await geminiModelPicker.click();
  const geminiMenuText = await page.getByRole("menu").textContent();
  check(geminiMenuText?.includes("제미나이 웹 · Argon") && geminiMenuText.includes("AI Studio · Argon") && !geminiMenuText.includes("Pro 자동 선택") && !geminiMenuText.includes("직접 입력"), "Gemini worker exposes only Web and AI Studio models");
  await page.getByRole("menuitem").filter({ hasText: "aistudio:gemini-4-argon" }).click();
  check(await page.evaluate(() => window.getModelValue() === "aistudio:gemini-4-argon"), "AI Studio selection stores the fixed model id");
  await page.evaluate(() => window.showModel(["claude", "codex", "gemini", "grok", "deepseek"], "gemini:aistudio:gemini-4-argon"));
  await geminiModelPicker.click();
  const masterMenuText = await page.getByRole("menu").textContent();
  check(masterMenuText?.includes("AI Studio · Argon") && !masterMenuText.includes("제미나이 웹 · Argon"), "Gemini master picker exposes AI Studio only");
  check(errors.length === 0, "no browser runtime errors: " + errors.join(", "));
  console.log("CLI accounts UI browser checks passed: " + checks);
} finally {
  await browser.close();
}

// Remote web page (desktop renderer on the remote API) in headless Edge, desktop and phone sizes, against the
// real remote server with a fake core (scripts/fixtures/remote-ui-server.ts). No app, no user data.
// Run after `npm run build`:  node scripts/e2e-remote-ui-screens.mjs
// Screenshots: docs/remote-web-screens/
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeChecks, root } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const PASSWORD = "fixture-password-1234";
const shots = join(root, "docs", "remote-web-screens");
mkdirSync(shots, { recursive: true });
const bundle = join(root, ".scratch", "remote-ui", "fixture.mjs");
await build({ entryPoints: [join(root, "scripts", "fixtures", "remote-ui-server.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", external: ["electron"], logLevel: "error",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const { startFixture } = await import(pathToFileURL(bundle).href);
const server = await startFixture(join(root, "out", "renderer"), PASSWORD);
const browser = await chromium.launch({ channel: "msedge", headless: true });

try {
  // ---------- boundaries without a session
  for (const path of ["/api/chats", "/api/chats/1", "/api/cli", "/api/usage", "/api/projects", "/api/stream"]) {
    const res = await fetch(server.base + path);
    check(`no session: GET ${path} → 401`, res.status === 401, res.status);
  }
  const page0 = await fetch(server.base + "/");
  check("page has the strict CSP (no inline script/style)", /script-src 'self'; style-src 'self'/.test(page0.headers.get("content-security-policy") ?? ""));
  check("character art served for the avatars", (await fetch(server.base + "/characters/orch/happy.png")).headers.get("content-type") === "image/png");
  const small = await fetch(server.base + "/avatars/orch/happy.png");
  const smallBytes = (await small.arrayBuffer()).byteLength;
  check("small avatar copies for the remote page (≤ 40 KB)", small.headers.get("content-type") === "image/png" && smallBytes <= 40 * 1024, `${smallBytes} B`);

  async function open(viewport, mobile, path = "/") {
    const context = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    const errors = [];
    let dialog = false;
    page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("dialog", d => { dialog = true; void d.dismiss(); });
    await page.goto(server.base + path);
    await page.fill("#remote-password", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector(path === "/" ? '[data-testid="sidebar"]' : 'input[aria-label="채팅 검색"]', { timeout: 20_000 });
    await page.waitForTimeout(600);
    // The login page's own session probe answers 401 by design; count only what happens once signed in.
    errors.length = 0;
    return { context, page, errors, dialog: () => dialog };
  }
  const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---------- desktop 1440×900
  {
    const { context, page, errors, dialog } = await open({ width: 1440, height: 900 }, false);
    check("desktop: dark theme by default", await page.evaluate(() => document.documentElement.classList.contains("dark")));
    check("desktop: two-column app layout", (await page.getAttribute('[data-layout]', "data-layout")) === "desktop");
    check("desktop: projects with chats", (await page.locator('[data-testid="project-node"]').count()) === 3 && (await page.locator('[data-testid="chat-node"]').count()) === 6);
    check("desktop: usage bars from the server view", (await page.locator('[data-testid="remote-usage"] [data-testid="usage-bar"]').count()) >= 4);
    check("desktop: no new-project button (desktop-only)", (await page.locator('button[aria-label="새 프로젝트"]').count()) === 0);
    const projects = page.getByTestId("project-node");
    const search = page.getByRole("textbox", { name: "채팅 검색", exact: true });
    await projects.first().waitFor();
    await search.fill("검색 결과가 없는 회귀 검사 문자열");
    await projects.first().waitFor({ state: "detached" });
    check("desktop: an empty search keeps the sidebar mounted", await search.isVisible());
    await page.getByRole("button", { name: "검색 지우기" }).click();
    await projects.first().waitFor();
    check("desktop: clearing an empty search restores the project list", await projects.first().isVisible());
    await page.screenshot({ path: join(shots, "desktop-1-list.png") });

    await page.click('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]');
    await page.waitForSelector('[data-testid="chat-view"]');
    await page.waitForSelector('[data-testid="chat-title"]');
    // The header renders before the stream and history arrive; check the loaded chat, not a timer.
    await page.waitForSelector('[data-testid="plan-panel"]', { timeout: 15_000 });
    check("desktop: chat header with master and agent model pickers", (await page.locator('[data-testid="chat-header-master-row"]').count()) === 1 && (await page.locator('[data-testid="chat-header-agents-row"] [data-testid="provider-controls"]').count()) === 5);
    check("desktop: providers not shown as missing (CLI state from /api/cli)", (await page.locator('[data-testid="provider-controls"][data-state="inactive"]').count()) === 0);
    check("desktop: worker chips", (await page.locator('[data-testid="team-chips"]').count()) === 1);
    check("desktop: checklist with 4 steps", (await page.getByText("NAS Caddy를 새 IP·새 인증서로 변경").count()) >= 1);
    check("desktop: previous checklist, review summary and token rate are visible", await page.getByText(/이전 계획/).isVisible()
      && await page.getByText(/리뷰 1건/).first().isVisible() && await page.getByText(/24\.8 tok\/s/).first().isVisible());
    check("desktop: markdown rendered (table, code)", (await page.locator('[data-testid="chat-view"] table').count()) >= 1 && (await page.locator('[data-testid="chat-view"] pre').count()) >= 1);
    check("desktop: raw HTML in a message stays text (no script, no dialog)", (await page.locator('[data-testid="chat-view"] script').count()) === 0 && !dialog() && (await page.getByText('<script>alert("xss")</script>', { exact: false }).count()) >= 1);
    check("desktop: avatars loaded", await page.evaluate(() => [...document.querySelectorAll('img[data-testid="agent-avatar"]')].some(i => i.complete && i.naturalWidth > 0)));
    check("desktop: project folder path not shown", !(await page.locator('[data-testid="chat-header-title-row"]').innerText()).includes("fixture"));
    await page.screenshot({ path: join(shots, "desktop-2-chat.png") });
    const plan = page.locator('[data-testid="plan-panel"], [data-testid="plan"]').first();
    if (await plan.count()) await plan.screenshot({ path: join(shots, "desktop-3-checklist.png") });
    else await page.screenshot({ path: join(shots, "desktop-3-checklist.png"), clip: { x: 288, y: 150, width: 1152, height: 330 } });
    await page.fill('textarea[aria-label="메시지 입력"]', "추가 지시 예시: 모바일 화면도 확인해 줘");
    await page.screenshot({ path: join(shots, "desktop-4-composer.png") });
    await page.fill('textarea[aria-label="메시지 입력"]', "");

    await page.click('[data-testid="chat-node"][data-chat-id="4"] [role="treeitem"]');
    await page.waitForSelector('[data-testid="chat-view"]');
    await page.waitForTimeout(800);
    check("desktop: approval request with its buttons", (await page.getByText("robocopy", { exact: false }).count()) >= 1);
    await page.screenshot({ path: join(shots, "desktop-5-approval.png") });
    check("desktop: no horizontal page scroll", await noHorizontalScroll(page));
    check("desktop: avatars come from the small copies", await page.evaluate(() => [...document.querySelectorAll('img[data-testid="agent-avatar"]')].every(i => new URL(i.src).pathname.startsWith("/avatars/"))));
    await page.locator('[data-testid="older-approvals"] > button').click();
    await page.getByRole("button", { name: /더 보기/ }).click();
    await page.locator('[data-testid="older-approvals"]').getByText("파일 변경", { exact: true }).waitFor();
    check("desktop: older approvals load one more page", !await page.getByRole("button", { name: /더 보기/ }).count());

    // Dialog scroll lock under the CSP: the static body[data-scroll-locked] rule does the locking.
    await page.click('[data-testid="run-stats-open"]');
    await page.waitForSelector('[role="dialog"]');
    check("desktop: dialog locks page scroll without inline styles", await page.evaluate(() => document.body.hasAttribute("data-scroll-locked") && getComputedStyle(document.body).overflow === "hidden"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Review 1167 #1: chat 1's history answer arrives late (after 1 → 4); back on chat 1 the live stream
    // must be chat 1's, and its live events must show.
    const streams = [];
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/stream") streams.push(new URL(r.url()).search); });
    let delayed = false;
    await page.route(u => new URL(u).pathname === "/api/chats/1", async route => {
      if (!delayed) { delayed = true; await new Promise(ok => setTimeout(ok, 2500)); }
      await route.continue();
    });
    await page.click('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]');
    await page.waitForTimeout(150);
    await page.click('[data-testid="chat-node"][data-chat-id="4"] [role="treeitem"]');
    await page.waitForTimeout(3000);
    await page.click('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]');
    await page.waitForSelector('[data-testid="plan-panel"]');
    await page.waitForTimeout(800);
    check("desktop: after 1 → 4 → 1 with a late answer, the stream follows chat 1", streams.at(-1) === "?chat=1", streams.join(" "));
    server.liveText(1, "실시간 응답 확인용 새 메시지");
    await page.waitForTimeout(800);
    check("desktop: chat 1's live reply appears after the switch", (await page.getByText("실시간 응답 확인용 새 메시지").count()) === 1);
    await page.unroute(u => new URL(u).pathname === "/api/chats/1");

    // Review 1167 #2: a failed logout keeps the page signed in and offers another try.
    let failLogout = true;
    await page.route("**/api/logout", route => failLogout ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "잠시 후 다시 시도하세요." }) }) : route.continue());
    await page.click('[data-testid="remote-logout"]');
    await page.waitForSelector('[role="alert"]:has-text("로그아웃하지 못했습니다")');
    check("desktop: failed logout (503) is reported and the page stays signed in", (await page.locator('[data-testid="sidebar"]').count()) === 1);
    failLogout = false;
    await page.click('[data-testid="remote-logout"]');
    await page.waitForSelector("#remote-password", { timeout: 10_000 });
    check("desktop: logout again succeeds → login page", (await (await page.request.get(server.base + "/api/chats")).status()) === 401);
    // Expected: the 503 of the failed-logout check and the library's own refused <style> tag (lock works anyway).
    const blocking = errors.filter(e => !/Content Security Policy.*style/i.test(e) && !/status of 503/.test(e) && !/status of 401/.test(e));
    check("desktop: no page errors", blocking.length === 0, blocking.join(" | "));
    console.log(`desktop console CSP style notices: ${errors.length - blocking.length}`);
    await context.close();
  }

  // ---------- phone 390×844
  {
    const { context, page, errors } = await open({ width: 390, height: 844 }, true);
    check("phone: mobile layout (list only)", (await page.getAttribute('[data-layout]', "data-layout")) === "mobile" && (await page.locator('[data-testid="chat-view"]').count()) === 0);
    check("phone: no horizontal scroll (list)", await noHorizontalScroll(page));
    const rowHeights = await page.locator('[data-testid="chat-node"] [role="treeitem"]').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    check("phone: chat rows ≥ 44px", rowHeights.every(h => h >= 44), rowHeights.join(","));
    check("phone: usage bars folded by default", (await page.locator('[data-testid="usage-bar"]').count()) === 0);
    await page.screenshot({ path: join(shots, "mobile-1-list.png") });
    await page.click('[data-testid="mobile-usage-toggle"]');
    check("phone: usage bars open on demand", (await page.locator('[data-testid="usage-bar"]').count()) >= 4);
    await page.click('[data-testid="mobile-usage-toggle"]');

    await page.click('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"]');
    await page.waitForSelector('[data-testid="chat-view"]');
    await page.waitForTimeout(800);
    check("phone: chat replaces the list", (await page.locator('[data-testid="sidebar"]').count()) === 0);
    check("phone: model rows folded by default", (await page.locator('[data-testid="chat-header-master-row"]').count()) === 0);
    check("phone: live checklist folded by default", (await page.locator('[data-testid="plan-panel"] > button').getAttribute("aria-expanded")) === "false");
    check("phone: no horizontal scroll (chat)", await noHorizontalScroll(page));
    const targets = await page.locator('[data-testid="mobile-back"], [data-testid="mobile-controls-toggle"], [data-testid="send"], button[aria-label="파일 첨부"]').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
    check("phone: header/composer touch targets ≥ 44px", targets.length === 4 && targets.every(v => v >= 43.5), targets.join(","));
    const composerBottom = await page.locator('[data-testid="composer"]').evaluate(e => e.getBoundingClientRect().bottom);
    check("phone: composer pinned to the bottom", Math.abs(composerBottom - 844) <= 2, composerBottom);
    await page.screenshot({ path: join(shots, "mobile-2-chat.png") });
    await page.click('[data-testid="plan-panel"] > button');
    check("phone: checklist opens on tap", (await page.locator('[data-testid="plan-panel"] > button').getAttribute("aria-expanded")) === "true");
    await page.screenshot({ path: join(shots, "mobile-2b-checklist.png") });
    await page.click('[data-testid="plan-panel"] > button');

    await page.click('[data-testid="mobile-controls-toggle"]');
    await page.waitForSelector('[data-testid="chat-header-master-row"]');
    check("phone: controls sheet opens; still no horizontal scroll", await noHorizontalScroll(page));
    const controlSizes = await page.locator('[data-testid="chat-header-master-row"] button, [data-testid="chat-header-agents-row"] button')
      .evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
    check("phone: expanded model and approval control touch targets ≥ 44px", controlSizes.length >= 8 && controlSizes.every(h => h >= 43.5), controlSizes.join(","));
    await page.screenshot({ path: join(shots, "mobile-3-controls.png") });
    await page.click('[data-testid="mobile-controls-toggle"]');

    await page.fill('textarea[aria-label="메시지 입력"]', "첫 줄");
    await page.press('textarea[aria-label="메시지 입력"]', "Enter");
    await page.type('textarea[aria-label="메시지 입력"]', "둘째 줄");
    check("phone: Enter makes a new line (send is the button)", (await page.inputValue('textarea[aria-label="메시지 입력"]')) === "첫 줄\n둘째 줄");
    await page.screenshot({ path: join(shots, "mobile-4-composer.png") });
    await page.fill('textarea[aria-label="메시지 입력"]', "");

    await page.click('[data-testid="mobile-back"]');
    await page.waitForSelector('[data-testid="sidebar"]');
    check("phone: back returns to the list", (await page.locator('[data-testid="chat-view"]').count()) === 0);
    await page.click('[data-testid="chat-node"][data-chat-id="4"] [role="treeitem"]');
    await page.waitForSelector('[data-testid="chat-view"]');
    await page.waitForTimeout(800);
    const approve = await page.locator('[data-testid="approve-once"], [data-testid="approve-deny"]').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
    check("phone: approval buttons ≥ 44px", approve.length === 2 && approve.every(h => h >= 43.5), approve.join(","));
    await page.screenshot({ path: join(shots, "mobile-5-approval.png") });
    await page.goBack();
    await page.waitForSelector('[data-testid="sidebar"]');
    check("phone: browser back returns to the list", (await page.locator('[data-testid="chat-view"]').count()) === 0);
    const blocking = errors.filter(e => !/Content Security Policy.*style/i.test(e));
    check("phone: no page errors", blocking.length === 0, blocking.join(" | "));
    await context.close();
  }

  // ---------- ?classic (earlier remote page) still works with the allow-listed chat data
  {
    const { context, page, errors } = await open({ width: 1280, height: 800 }, false, "/?classic");
    await page.getByText("원격 웹 UI를 앱과 같게 개선").first().click();
    await page.waitForTimeout(1200);
    check("classic: chat opens and shows its messages", (await page.getByText("NAS에서 바꾼 것", { exact: false }).count()) >= 1);
    check("classic: no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  }

  // ---------- desktop actions: shared components → authenticated remote API → fixture core
  {
    const { context, page } = await open({ width: 1440, height: 900 }, false);
    const row = id => page.locator(`[data-testid="chat-node"][data-chat-id="${id}"] [role="treeitem"]`);
    const menu = name => page.getByRole("menuitem", { name, exact: true });
    check("usage: account labels, percent and reset time are visible", await page.getByTestId("remote-usage").getByText(/PRIVATE/).count() === 1
      && await page.getByTestId("usage-reset").count() >= 3);
    const usage = await (await page.request.get(server.base + "/api/usage")).json();
    check("usage: raw response omits internal account IDs", usage.groups.every(g => g.accounts.every(a => !("accountId" in a))));
    check("usage: CLI account settings stay hidden", await page.getByTestId("connection-settings").count() === 0);
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/usage?refresh=1") && r.ok()), page.getByTestId("usage-refresh").click()]);
    check("usage: refresh uses the existing read-only API", true);
    await page.screenshot({ path: join(shots, "desktop-6-sidebar.png") });

    // Incoming core status changes must update the footer while a different chat (or no chat) is open.
    server.updateStatus(3, "idle");
    const working = page.locator('[data-testid="working-chat"][data-chat-id="3"]');
    await working.waitFor({ state: "detached" });
    server.updateStatus(3, "working");
    await working.click();
    await page.getByTestId("chat-title").filter({ hasText: "카드 일러스트 교체 검토" }).waitFor();
    await page.getByText(/작업 중… ·/).waitFor();
    check("desktop: live working-chat updates navigate to the timer and working composer", await page.getByTestId("pause").isVisible() && await page.getByTestId("send-next").isVisible());
    await page.screenshot({ path: join(shots, "desktop-7-working-composer.png") });
    for (const [button, delivery] of [["send-next", "next"], ["send", "now"]]) {
      await page.getByRole("textbox", { name: "메시지 입력" }).fill(delivery);
      const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/3/send")), page.getByTestId(button).click()]);
      check(`desktop: composer ${delivery} reaches the core`, response.ok() && response.request().postDataJSON().delivery === delivery);
    }
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/3/pause") && r.ok()), page.getByTestId("pause").click()]);
    check("desktop: pause exposes resume", await page.getByTestId("resume").waitFor({ timeout: 5000 }).then(() => true));
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/3/resume") && r.ok()), page.getByTestId("resume").click()]);

    await row(1).click();
    const detail = await (await page.request.get(server.base + "/api/chats/1")).json();
    check("desktop: remote metrics omit native turn and session identifiers", !JSON.stringify(detail.events).includes("native-fixture-"));
    const master = page.getByRole("button", { name: "이 채팅의 마스터 모델", exact: true });
    await master.click();
    const [model] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/update") && r.ok()), page.getByText("Sonnet 5.5", { exact: true }).last().click()]);
    check("desktop: changing master model persists via the chat update API", model.request().postDataJSON().orchestratorModelOverride === "claude:sonnet");
    await page.getByRole("button", { name: "이 채팅의 마스터 추론 수준", exact: true }).click();
    const [effort] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/update") && r.ok()), page.getByText("high", { exact: true }).last().click()]);
    check("desktop: named reasoning effort is saved", effort.request().postDataJSON().orchestratorEffortOverride === "high");
    page.removeAllListeners("dialog");
    page.on("dialog", d => void d.accept());
    await page.getByRole("button", { name: "이 채팅의 승인 방식", exact: true }).click();
    const [approval] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/api/chats/1/update") && r.ok()),
      menu("전체 위험 승인").click(),
    ]);
    check("desktop: raising approval mode retries with the existing server confirmation", approval.request().postDataJSON().confirm === true);
    const waitsForExpression = page.locator('[data-testid="chat-header-master-row"] [data-kind="orch"][data-expression="thinking"]').waitFor();
    server.expression(1, "thinking");
    await waitsForExpression;
    check("desktop: master's live expression updates the existing avatar", true);
    await page.screenshot({ path: join(shots, "desktop-8-header.png") });

    await row(1).click({ button: "right" });
    check("desktop: chat context menu has rename, move, fork, archive and delete", (await Promise.all(
      ["이름 변경", "아래로 이동", "최근 메시지에서 분기", "보관", "삭제"].map(name => menu(name).isVisible()))).every(Boolean));
    await page.screenshot({ path: join(shots, "desktop-9-chat-menu.png") });
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/reorder") && r.ok()), menu("아래로 이동").click()]);
    check("desktop: context reorder updates the sidebar", await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-node"]')].slice(0, 2).map(el => el.getAttribute("data-chat-id")).join() === "2,1").then(() => true));
    await row(1).click({ button: "right" });
    await menu("최근 메시지에서 분기").click();
    await page.getByTestId("fork-dialog").waitFor();
    check("desktop: recent fork uses the server's anchor", await page.getByText("이전 페이지의 분기 기준").isVisible());
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/fork") && r.status() === 201), page.getByTestId("fork-submit").click()]);
    await row(7).click({ button: "right" });
    await menu("삭제").click();
    const confirm = page.getByRole("dialog");
    check("desktop: deletion waits for the shared confirmation", await confirm.isVisible() && !server.calls.includes("remote:chat-delete"));
    server.changeChat(7, { title: "외부에서 바꾼 분기 제목" });
    await confirm.waitFor({ state: "hidden" });
    const changedNotice = page.getByText("삭제할 채팅이 바뀌었습니다. 목록에서 다시 확인하세요.", { exact: true });
    await changedNotice.waitFor();
    check("desktop: a rename invalidates the deletion dialog with a notice", !server.calls.includes("remote:chat-delete"));
    await row(7).click({ button: "right" });
    await menu("삭제").click();
    await confirm.waitFor();
    const replacementTime = Date.now();
    server.changeChat(7, { createdAt: replacementTime });
    await confirm.waitFor({ state: "hidden" });
    check("desktop: a reused id invalidates the deletion dialog even with the same title", !server.calls.includes("remote:chat-delete"));
    await row(7).click({ button: "right" });
    await menu("삭제").click();
    const displayedTitle = "외부에서 바꾼 분기 제목";
    check("desktop: the new confirmation displays the replacement title", (await confirm.innerText()).includes(displayedTitle));
    const [deleted] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/7/delete") && r.ok()), confirm.getByRole("button", { name: "삭제" }).click()]);
    const submitted = deleted.request().postDataJSON();
    check("desktop: deletion submits the title and identity from the dialog", submitted.confirm === displayedTitle && submitted.createdAt === replacementTime);
    await row(7).waitFor({ state: "detached" });
    const deletesBeforeExternal = server.calls.filter(channel => channel === "remote:chat-delete").length;
    await row(1).click({ button: "right" });
    await menu("최근 메시지에서 분기").click();
    await page.getByTestId("fork-dialog").waitFor();
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/fork") && r.status() === 201), page.getByTestId("fork-submit").click()]);
    await row(8).click({ button: "right" });
    await menu("삭제").click();
    await confirm.waitFor();
    server.deleteExternally(8);
    await confirm.waitFor({ state: "hidden" });
    check("desktop: external deletion closes the dialog without a second deletion request", !await row(8).count()
      && server.calls.filter(channel => channel === "remote:chat-delete").length === deletesBeforeExternal);
    await row(1).click({ button: "right" });
    await menu("최근 메시지에서 분기").click();
    await page.getByTestId("fork-dialog").waitFor();
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/1/fork") && r.status() === 201), page.getByTestId("fork-submit").click()]);
    await row(9).click({ button: "right" });
    await menu("삭제").click();
    server.changeChat(9, { title: "알림이 늦은 변경" }, false);
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/9/delete") && r.status() === 412), confirm.getByRole("button", { name: "삭제" }).click()]);
    await confirm.waitFor({ state: "hidden" });
    check("desktop: stale confirmation closes on the server response without waiting for SSE", await row(9).isVisible());
    server.deleteExternally(9);
    await row(2).click({ button: "right" });
    await menu("이름 변경").click();
    const rename = page.getByRole("dialog");
    await rename.getByRole("textbox").fill("사용량 모니터 정리 · 원격");
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/2/update") && r.ok()), rename.getByRole("button", { name: "저장" }).click()]);
    check("desktop: context rename updates the list", await row(2).getByText("사용량 모니터 정리 · 원격", { exact: true }).isVisible());
    await row(2).click({ button: "right" });
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/2/update") && r.ok()), menu("보관").click()]);
    await row(2).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "보관된 항목 보기" }).click();
    check("desktop: archived chat appears with the existing toggle", await row(2).isVisible());
    await row(2).click({ button: "right" });
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chats/2/update") && r.ok()), menu("보관 해제").click()]);

    await page.getByRole("button", { name: "AI APPS 폴더" }).click({ button: "right" });
    check("desktop: project context menu omits PC folder and delete actions", !await menu("폴더 열기").count() && !await menu("삭제").count());
    await menu("프로젝트 설정").click();
    const projectDialog = page.getByRole("dialog");
    check("desktop: remote project settings omit folder and CLI policy", !await projectDialog.locator("#proj-folder").count() && !await projectDialog.getByTestId("project-cli-account-policy").count());
    await projectDialog.getByLabel("이름", { exact: true }).fill("AI APPS 원격");
    const [projectUpdate] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/projects/1/update") && r.ok()), projectDialog.getByRole("button", { name: "저장" }).click()]);
    check("desktop: project settings use the same route and send only changes", JSON.stringify(projectUpdate.request().postDataJSON()) === JSON.stringify({ name: "AI APPS 원격" }));
    await context.close();
  }

  // An actual touch pointer should open the same menu without selecting the row.
  {
    const { context, page } = await open({ width: 390, height: 844 }, true);
    await page.getByTestId("mobile-usage-toggle").click();
    await page.getByTestId("usage-reset").first().waitFor();
    await page.screenshot({ path: join(shots, "mobile-6-sidebar.png") });
    await page.getByTestId("mobile-usage-toggle").click();
    const session = await context.newCDPSession(page);
    async function longPress(target, visibleItem) {
      const rect = await target.boundingBox();
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
      await visibleItem.waitFor({ timeout: 3000 });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await longPress(page.locator('[data-testid="chat-node"][data-chat-id="1"] [role="treeitem"] > span').first(), page.getByRole("menuitem", { name: "최근 메시지에서 분기" }));
    check("phone: long press opens the chat menu without opening the chat", !await page.getByTestId("chat-view").count() && await page.getByRole("menuitem", { name: "이름 변경" }).isVisible());
    await page.screenshot({ path: join(shots, "mobile-7-chat-menu.png") });
    await page.keyboard.press("Escape");
    const projectSettings = page.getByRole("menuitem", { name: "프로젝트 설정" });
    await longPress(page.getByRole("button", { name: "AI APPS 원격 폴더" }), projectSettings);
    await projectSettings.click();
    const projectDialog = page.getByRole("dialog");
    check("phone: project long press opens settings within the viewport", await projectDialog.isVisible()
      && await projectDialog.evaluate(el => el.getBoundingClientRect().left >= 0 && el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: join(shots, "mobile-8-project-settings.png") });
    await context.close();
  }
} finally {
  await browser.close();
  await server.stop();
}
finish();

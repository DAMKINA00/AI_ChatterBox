import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./e2e-lib.mjs";

const output = join(root, ".scratch", "boardroom");
const modulePath = join(output, "fixture.mjs");
await build({ entryPoints: [join(root, "scripts", "fixtures", "remote-ui-server.ts")], outfile: modulePath, bundle: true,
  platform: "node", format: "esm", external: ["electron"], logLevel: "error",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const { startFixture } = await import(pathToFileURL(modulePath).href);
const password = "boardroom-fixture-password";
const server = await startFixture(join(root, "out", "renderer"), password);
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const path of ["/api/boardroom", "/api/boardroom/stream"])
    assert.equal((await fetch(server.base + path)).status, 401);
  const page = await browser.newPage({ viewport: { width: 1_140, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://images.example/meeting.png", route => route.fulfill({ contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9W3ioAAAAASUVORK5CYII=", "base64") }));
  await page.goto(server.base);
  await page.fill("#remote-password", password);
  await page.locator('button[type="submit"]').click();
  await page.getByRole("button", { name: "Boardroom", exact: true }).click();
  await page.getByText("연결됨", { exact: true }).waitFor();
  assert.equal(await page.locator("#workspace-panel").isVisible(), false);
  assert.equal(await page.getByRole("complementary", { name: "참가자" }).locator("li").count(), 6);
  await page.getByRole("textbox", { name: "회의 안건" }).fill("두 방안을 비교해 줘.");
  await page.getByRole("button", { name: "안건 보내기" }).click();
  await page.getByText("비교 기준을 확인하고 있어요.", { exact: false }).waitFor();
  const speaking = page.locator('article img[data-kind="gpt"][data-expression="speaking"]');
  await speaking.waitFor();
  assert.equal(await speaking.evaluate(el => getComputedStyle(el).animationName), "boardroom-speaking");
  await page.screenshot({ path: join(output, "streaming.png") });
  await page.getByText("회의를 마쳤어요.").waitFor();
  assert.equal(await page.locator("#boardroom-panel table").count(), 1);
  assert.equal(await page.locator('article img[alt="회의 자료"]').count(), 0);
  await page.getByRole("button", { name: "이미지 보기" }).click();
  await page.waitForFunction(() => document.querySelector('article img[alt="회의 자료"]')?.naturalWidth > 0);
  await page.screenshot({ path: join(output, "boardroom.png") });
  await page.getByRole("button", { name: "ChatterBox", exact: true }).click();
  assert.equal(await page.locator("#workspace-panel").isVisible(), true);
  await page.getByRole("button", { name: "Boardroom", exact: true }).click();
  await page.getByText("A안을 추천합니다.").waitFor();
  await page.setViewportSize({ width: 390, height: 760 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, "boardroom-mobile.png") });
  assert.deepEqual(errors, []);
  console.log("PASS authenticated Boardroom tab, live speaker, rich messages, reconnect and mobile layout");
} finally {
  await browser.close();
  await server.stop();
}

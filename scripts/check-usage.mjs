// Real-app check: account quotas for Claude, GPT and Gemini (no model turn).
import { launch, makeChecks, scratchDir, shot } from "./e2e-lib.mjs";

const { check, finish } = makeChecks();
const { app, page } = await launch(scratchDir("usage"));
let bars = [];
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  bars = await page.$$eval('[data-testid="usage-bar"]', (els) => els.map((e) => e.textContent ?? ""));
  if (bars.length === 3 && bars.every((b) => /\d+%/.test(b))) break;
}
check("Claude remaining usage shown at startup", /Claude\s*(주간|5시간)\s*\d+%/.test(bars[0] ?? ""), bars[0]);
check("GPT remaining usage shown", /GPT\s*(주간|5시간)\s*\d+%/.test(bars[1] ?? ""), bars[1]);
check("Gemini remaining usage shown", /Gemini\s*(주간|5시간)\s*\d+%/.test(bars[2] ?? ""), bars[2]);
await shot(page, "v022-usage.png");
await app.close();
finish();

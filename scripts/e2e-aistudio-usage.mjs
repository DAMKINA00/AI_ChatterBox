// Isolated read-only usage UI fixtures. No Google requests, model turns, or generated media.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { launch, root, makeChecks } from './e2e-lib.mjs';
const { check, finish } = makeChecks();
let app;
try {
  const launched = await launch(join(root, '.scratch', 'aistudio-usage-ui', String(Date.now())));
  app = launched.app;
  const page = launched.page;
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis.__studioUsageTest = { mode: 'normal', calls: [], slowSeven: false, releaseSeven: null };
    ipcMain.removeHandler('aistudio');
    ipcMain.handle('aistudio', () => ({
      settings: { baseUrl: 'http://127.0.0.1:2048', model: 'gemini-4-argon', hasApiKey: true, executable: '', videoEnabled: false },
      state: 'RUNNING', accounts: [], models: [], cooldowns: [],
    }));
    ipcMain.removeHandler('aistudio:usage');
    ipcMain.handle('aistudio:usage', async (_event, range = '24h') => {
      state.calls.push(range);
      const mode = state.mode;
      if (range === '7d' && state.slowSeven) await new Promise(resolve => { state.releaseSeven = resolve; });
      if (mode === 'error') throw new Error('사용량 서버 연결 실패');
      const requests = range === '7d' ? 70 : range === '30d' ? 300 : 13;
      const totals = { requests, succeeded: requests - 3, failed: 2, canceled: 1, rateLimited: 1,
        inputTokens: 43006, cachedTokens: 14002, reasoningTokens: 231, replyTokens: 3476, totalTokens: 46713 };
      if (mode === 'empty') for (const key of Object.keys(totals)) totals[key] = 0;
      return {
        from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00Z', generatedAt: '2026-10-20T00:00:01Z', totals,
        groups: { account: mode === 'empty' ? [] : [{ key: 'studio@example.test', ...totals }],
          model: mode === 'empty' ? [] : [{ key: 'gemini-4-argon', ...totals }],
          channel: mode === 'empty' ? [] : [{ key: 'playground', ...totals }] },
      };
    });
    ipcMain.removeHandler('usage:get');
    ipcMain.handle('usage:get', () => ({ geminiWeb: { status: 'available', detail: '현재 20% 사용', checkedAt: Date.now(), current: { usedPercent: 20 } } }));
  });
  await page.reload();
  const summary = page.getByTestId('aistudio-usage-summary');
  await summary.getByText(/13/).waitFor();
  check('sidebar displays AI Studio requests separately without a Web quota percentage', /AI Studio/.test(await summary.innerText()) && /13/.test(await summary.innerText()) && !/%/.test(await summary.innerText()));
  await page.getByTestId('aistudio-manage').click();
  const panel = page.getByTestId('aistudio-usage-panel');
  const totals = panel.getByTestId('aistudio-usage-totals');
  await totals.getByText('46,713', { exact: true }).waitFor();
  const text = await panel.innerText();
  check('independent request and input/cache/reply/reasoning token counters are displayed', ['43,006', '14,002', '3,476', '231', '46,713'].every(value => text.includes(value)));
  check('local usage and unavailable remaining quota are explicit', /로컬/.test(text) && /Gemini Web/.test(text) && /잔여 한도/.test(text) && /캐시/.test(text));
  const table = panel.getByTestId('aistudio-usage-table');
  check('account usage is shown by its own AI Studio identity', (await table.innerText()).includes('studio@example.test'));
  await panel.getByTestId('aistudio-usage-group').selectOption('model');
  check('model usage is separate', (await table.innerText()).includes('gemini-4-argon'));
  await panel.getByTestId('aistudio-usage-group').selectOption('channel');
  check('channel usage is separate', /playground/i.test(await table.innerText()));
  const range = panel.getByTestId('aistudio-usage-range');
  await range.selectOption('7d');
  await totals.getByText('70', { exact: true }).waitFor();
  check('seven day query reaches the backend while sidebar remains last 24 hours', await app.evaluate(() => globalThis.__studioUsageTest.calls.includes('7d')) && /13/.test(await summary.innerText()));
  await range.selectOption('30d');
  await totals.getByText('300', { exact: true }).waitFor();
  await app.evaluate(() => { globalThis.__studioUsageTest.slowSeven = true; });
  await range.selectOption('7d');
  for (let i = 0; i < 100 && !(await app.evaluate(() => !!globalThis.__studioUsageTest.releaseSeven)); i++) await page.waitForTimeout(20);
  assert.ok(await app.evaluate(() => !!globalThis.__studioUsageTest.releaseSeven));
  await range.selectOption('30d');
  await totals.getByText('300', { exact: true }).waitFor();
  await app.evaluate(() => { globalThis.__studioUsageTest.releaseSeven(); globalThis.__studioUsageTest.slowSeven = false; });
  await page.waitForTimeout(100);
  check('an older period response cannot overwrite the current period', (await totals.innerText()).includes('300') && await range.inputValue() === '30d');
  await app.evaluate(() => { globalThis.__studioUsageTest.mode = 'error'; });
  await panel.getByTestId('aistudio-usage-refresh').click();
  await panel.getByTestId('aistudio-usage-error').waitFor();
  check('usage errors remain distinct from zero usage and do not break service status', /조회|실패/.test(await panel.getByTestId('aistudio-usage-error').innerText()) && (await page.getByTestId('aistudio-status').innerText()).includes('RUNNING'));
  await app.evaluate(() => { globalThis.__studioUsageTest.mode = 'empty'; });
  await panel.getByTestId('aistudio-usage-refresh').click();
  await panel.getByTestId('aistudio-usage-empty').waitFor();
  check('a successful empty response is shown as no recorded requests', await panel.getByTestId('aistudio-usage-error').count() === 0 && !/100%/.test(await panel.innerText()));
  await page.screenshot({ path: join(root, '.scratch', 'aistudio-usage-ui-empty.png') });
  await app.evaluate(() => { globalThis.__studioUsageTest.mode = 'normal'; });
  await panel.getByTestId('aistudio-usage-refresh').click();
  await totals.getByText('46,713', { exact: true }).waitFor();
  await page.screenshot({ path: join(root, '.scratch', 'aistudio-usage-ui.png') });
} catch (error) {
  console.error(error);
  check('usage UI completed', false, error.stack ?? error.message);
} finally { await app?.close().catch(() => {}); }
finish();

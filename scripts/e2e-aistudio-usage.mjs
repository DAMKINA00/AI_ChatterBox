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
  const settings = page.getByTestId('connection-settings');
  const menu = page.getByTestId('connection-settings-menu');
  const summary = page.getByTestId('aistudio-usage-summary');
  check('one settings icon replaces the account links and usage summary in the sidebar', await settings.count() === 1 && await menu.count() === 0 && await summary.count() === 0 && await page.getByTestId('gemini-web-manage').count() === 0);
  await settings.click();
  await summary.getByText(/13/).waitFor();
  check('settings menu includes all three connections and the usage entry', await menu.getByRole('menuitem').count() === 4 && (await menu.innerText()).includes('연결 설정') && (await menu.innerText()).includes('사용 기록'));
  check('menu displays AI Studio requests separately without a Web quota percentage', /AI Studio/.test(await summary.innerText()) && /13/.test(await summary.innerText()) && !/%/.test(await summary.innerText()));
  await page.screenshot({ path: join(root, '.scratch', 'connection-menu-dark.png') });
  await menu.screenshot({ path: join(root, '.scratch', 'connection-menu-dark-detail.png') });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  check('Escape closes the menu and restores focus to settings', await settings.evaluate(el => el === document.activeElement));
  await settings.press('ArrowDown');
  await page.getByTestId('gemini-web-manage').waitFor();
  await page.keyboard.press('End');
  check('keyboard navigation reaches the usage entry', await summary.evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  const studioDialog = page.getByRole('dialog').filter({ hasText: 'AI Studio · Argon' });
  await studioDialog.waitFor();
  check('usage menu entry opens the existing detail dialog and closes the menu', await menu.count() === 0 && await page.getByTestId('aistudio-usage-panel').count() === 1);
  await studioDialog.getByText('닫기', { exact: true }).click();
  await settings.click();
  await page.mouse.click(650, 150);
  await menu.waitFor({ state: 'hidden' });
  check('clicking outside dismisses the settings menu', await settings.getAttribute('aria-expanded') === 'false');
  await page.getByLabel('테마 전환').click();
  await page.setViewportSize({ width: 900, height: 560 });
  await settings.click();
  await summary.getByText(/13/).waitFor();
  check('menu fits the smallest app window without clipping or horizontal overflow', await menu.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight;
  }));
  await page.screenshot({ path: join(root, '.scratch', 'connection-menu-light-small.png') });
  await page.keyboard.press('Escape');
  await page.getByLabel('테마 전환').click();
  await page.setViewportSize({ width: 1304, height: 820 });
  await settings.click();
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
  check('seven day query reaches the backend with the settings menu closed', await app.evaluate(() => globalThis.__studioUsageTest.calls.includes('7d')) && await menu.count() === 0);
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
  await studioDialog.getByText('닫기', { exact: true }).click();
  await settings.click();
  await summary.getByText(/13/).waitFor();
  check('reopening the menu always retrieves the latest 24-hour summary', /13/.test(await summary.innerText()) && await app.evaluate(() => globalThis.__studioUsageTest.calls.at(-1) === '24h'));
} catch (error) {
  console.error(error);
  check('usage UI completed', false, error.stack ?? error.message);
} finally { await app?.close().catch(() => {}); }
finish();

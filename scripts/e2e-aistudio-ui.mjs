// Isolated AI Studio account-linking UI. No Google login, consent navigation, model turns or video requests.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, makeChecks, launch, root } from './e2e-lib.mjs';

const { check, finish } = makeChecks();
const base = join(root, '.scratch', 'aistudio-web-link-ui', String(Date.now()));
const data = join(base, 'data');
const workspace = join(base, 'workspace');
mkdirSync(workspace, { recursive: true });

let app;
try {
  ({ app } = await launch(data));
  const page = await app.firstWindow();
  await app.evaluate(({ ipcMain }) => {
    const webStatus = (account) => ({
      accountId: account.accountId,
      state: account.state,
      message: account.message,
      checkedAt: Date.now(),
      usage: account.usage,
    });
    const state = globalThis.__aistudioUi = {
      accounts: [{
        accountId: 'gemini-1', label: '웹 계정 1', enabled: true, state: 'ready', message: '로그인 완료',
        checkedAt: Date.now(), remainingPercent: 80,
        usage: { status: 'available', detail: '현재 20% 사용', checkedAt: Date.now(), current: { usedPercent: 20, resetText: '오늘 저녁' } },
      }],
      calls: [],
      linked: false,
      studioEligible: true,
      studioInFlight: 0,
      studioMaxInFlight: 0,
    };
    const studioStatus = () => ({
      settings: { baseUrl: 'http://127.0.0.1:2048', model: 'gemini-4-argon', hasApiKey: false, executable: '', videoEnabled: false },
      state: 'RUNNING',
      version: 'test',
      accounts: state.linked ? [{ id: 'google@example.com', label: 'google@example.com', enabled: state.studioEligible, state: state.studioEligible ? 'ready' : 'disabled', benefit_tier: 'Pro', message: state.studioEligible ? '사용 가능' : '비활성 계정', models: ['gemini-4-argon'] }] : [],
      cooldowns: state.linked ? [{ account_id: 'google@example.com', account_label: 'google@example.com', model_id: 'gemini-4-argon', channel: 'standard', until: '2030-01-02T03:04:05Z', reason: '테스트 쿨다운' }] : [],
      models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }],
      webLinks: state.linked ? { 'gemini-1': { accountId: 'google@example.com', state: 'connected', message: '같은 Google 계정으로 AI Studio 연결됨', checkedAt: Date.now() } } : {},
    });
    ipcMain.removeHandler('gemini:web-accounts');
    ipcMain.handle('gemini:web-accounts', (_event, action, input) => {
      state.calls.push({ action, input });
      if (action === 'update') Object.assign(state.accounts.find(a => a.accountId === input.accountId), input);
      return state.accounts;
    });
    ipcMain.removeHandler('gemini:web');
    ipcMain.handle('gemini:web', (_event, action, id = 'gemini-1') => {
      state.calls.push({ action, id });
      return webStatus(state.accounts.find(a => a.accountId === id));
    });
    ipcMain.removeHandler('aistudio');
    ipcMain.handle('aistudio', async (_event, action, input = {}) => {
      state.calls.push({ action, input });
      if (action === 'sync-web') {
        state.studioInFlight++;
        state.studioMaxInFlight = Math.max(state.studioMaxInFlight, state.studioInFlight);
        await new Promise(resolve => setTimeout(resolve, 120));
        state.studioInFlight--;
        if (input.accountId !== 'gemini-1') throw new Error('unexpected account');
        state.linked = true;
      }
      return studioStatus();
    });
    ipcMain.removeHandler('aistudio:usage');
    ipcMain.handle('aistudio:usage', () => ({ from: new Date().toISOString(), to: new Date().toISOString(), generatedAt: new Date().toISOString(),
      totals: { requests: 0, succeeded: 0, failed: 0, canceled: 0, rateLimited: 0, inputTokens: 0, cachedTokens: 0, reasoningTokens: 0, replyTokens: 0, totalTokens: 0 },
      groups: { account: [], model: [], channel: [] } }));
    ipcMain.removeHandler('models:list');
    ipcMain.handle('models:list', (_event, provider) => provider === 'gemini' ? [{ id: 'gemini-web-argon', label: '웹 · Gemini 4 Argon' }] : []);
    ipcMain.removeHandler('cli:info');
    ipcMain.handle('cli:info', () => [{ agent: 'claude', path: 'C:\\mock\\claude.exe' }, { agent: 'codex', path: 'C:\\mock\\codex.exe' }, { agent: 'gemini', path: 'C:\\mock\\agy.exe' }]);
    ipcMain.removeHandler('usage:get');
    ipcMain.handle('usage:get', () => ({ geminiWeb: { status: 'available', detail: '현재 20% 사용', checkedAt: Date.now(), current: { usedPercent: 20 } } }));
  });
  const chatId = await page.evaluate(async ({ workspace, defaults }) => {
    const project = await window.chatterbox.createProject({ name: 'AI Studio 연결 검증', folder: workspace, settings: { ...defaults, geminiModel: '', geminiEffort: 'auto', maxGeminiWorkers: 1 } });
    return (await window.chatterbox.createChat(project.id)).id;
  }, { workspace, defaults: DEFAULTS });
  await page.reload();
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
  await page.getByTestId('gemini-web-manage').click();
  const dialog = page.getByRole('dialog').filter({ hasText: '제미나이 웹 계정 관리' });
  const card = dialog.locator('[data-account-id="gemini-1"]');
  await card.getByTestId('aistudio-link').waitFor();
  check('web account card exposes separate AI Studio link controls', await card.getByTestId('aistudio-sync').count() === 1 && await card.getByTestId('aistudio-sync-state').innerText() === '연결되지 않음');
  check('web quota remains separate from AI Studio details', (await card.getByTestId('gemini-web-account-usage').innerText()).includes('80% 남음') && !(await card.getByTestId('aistudio-link').innerText()).includes('% 남음'));
  await card.getByTestId('aistudio-sync').click();
  await card.getByTestId('aistudio-account-info').waitFor();
  check('explicit sync uses the selected web account', await app.evaluate(() => globalThis.__aistudioUi.calls.some(c => c.action === 'sync-web' && c.input?.accountId === 'gemini-1')));
  check('linked AI Studio tier state and Argon availability are shown', (await card.getByTestId('aistudio-account-info').innerText()).includes('등급 Pro') && (await card.getByTestId('aistudio-account-info').innerText()).includes('상태 ready') && (await card.getByTestId('aistudio-account-info').innerText()).includes('Argon 사용 가능: 예'));
  check('AI Studio cooldown keeps model channel and reset time', (await card.getByTestId('aistudio-cooldowns').innerText()).includes('gemini-4-argon') && (await card.getByTestId('aistudio-cooldowns').innerText()).includes('standard') && (await card.getByTestId('aistudio-cooldowns').innerText()).includes('2030.'));
  check('AI Studio polling stays single inflight', await app.evaluate(() => globalThis.__aistudioUi.studioMaxInFlight === 1));
  check('existing web login/browser controls remain present', await card.getByTestId('gemini-web-login').count() === 1 && await card.getByRole('button', { name: '사용량 확인', exact: true }).count() === 1);
  await dialog.getByText('닫기', { exact: true }).click();
  await app.evaluate(() => { globalThis.__aistudioUi.studioEligible = false; });
  await page.getByLabel('이 채팅의 제미나이 모델').click();
  await page.getByTestId('aistudio-connect').click();
  const studioDialog = page.getByRole('dialog').filter({ hasText: 'AI Studio · Argon' });
  const useArgon = studioDialog.getByTestId('aistudio-use-model');
  await useArgon.waitFor();
  check('missing eligible AI Studio account disables Argon use', await useArgon.isDisabled());
  await app.evaluate(() => { globalThis.__aistudioUi.studioEligible = true; });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="aistudio-use-model"]');
    return !!button && !(button instanceof HTMLButtonElement && button.disabled);
  }, null, { timeout: 7000 });
  check('restoring an enabled eligible account enables Argon use', !(await useArgon.isDisabled()));
} catch (error) {
  console.error(error);
  check('AI Studio account-linking UI completed', false, error.stack ?? error.message);
} finally {
  await app?.close().catch(() => {});
}
finish();

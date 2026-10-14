// Isolated multi-account management UI. No Google login, web navigation or model turn.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, makeChecks, launch, root } from './e2e-lib.mjs';
const { check, finish } = makeChecks();
const base = join(root, '.scratch', 'gemini-web-accounts-ui', String(Date.now()));
const data = join(base, 'data'), workspace = join(base, 'workspace'), screenshots = join(base, 'screenshots');
mkdirSync(workspace, {recursive:true}); mkdirSync(screenshots, {recursive:true});
let app, page;
try {
  ({app, page} = await launch(data));
  await app.evaluate(({ipcMain}) => {
    const fresh = () => ({status:'unknown', detail:'로그인이 필요합니다.', checkedAt:Date.now()});
    const account = n => ({accountId:`gemini-${n}`, label:`계정 ${n}`, enabled:true, state:'closed', message:'로그인을 확인하세요.', checkedAt:Date.now(), usage:fresh()});
    const state = globalThis.__webAccountsUi = {accounts:[account(1)], calls:[]};
    ipcMain.removeHandler('gemini:web-accounts');
    ipcMain.handle('gemini:web-accounts', (_e, action, input) => {
      state.calls.push({action, input});
      if (action === 'add') {
        if(state.accounts.length >= 10) throw new Error('계정은 최대 10개입니다.');
        state.accounts.push(account(state.accounts.length + 1));
      } else if(action === 'update') {
        const a = state.accounts.find(a => a.accountId === input.accountId);
        if(!a) throw new Error('등록되지 않은 계정');
        if(a.state === 'busy' && input.enabled === false) throw new Error('작업 중인 계정');
        Object.assign(a, input);
      } else if(action !== 'list') throw new Error('지원하지 않는 요청');
      return state.accounts;
    });
    ipcMain.removeHandler('gemini:web');
    ipcMain.handle('gemini:web', (_e, action, id='gemini-1') => {
      state.calls.push({action, id});
      const a = state.accounts.find(a => a.accountId === id);
      if(action === 'open') {
        a.state='ready'; a.message='로그인됨'; a.model='Gemini 4 Argon';
        a.usage={status:'available',detail:'현재 20% 사용 · 주간 5% 사용',checkedAt:Date.now(),current:{usedPercent:20,resetText:'오늘 저녁'},weekly:{usedPercent:5,resetText:'다음 주'}};
        a.remainingPercent=80;
      }
      return a;
    });
    ipcMain.removeHandler('models:list');
    ipcMain.handle('models:list', (_e, provider) => provider === 'gemini' ? [{id:'gemini-flash-test',label:'Gemini CLI 테스트'}, {id:'gemini-web-argon',label:'웹 · Gemini 4 Argon'}] : []);
    ipcMain.removeHandler('cli:info'); ipcMain.handle('cli:info', () => [{agent:'claude',path:'C:\\mock\\claude.exe'},{agent:'codex',path:'C:\\mock\\codex.exe'},{agent:'gemini',path:'C:\\mock\\agy.exe'}]);
    ipcMain.removeHandler('usage:get'); ipcMain.handle('usage:get', () => ({geminiWeb:{status:'limited',detail:'소진',checkedAt:Date.now(),current:{usedPercent:100},weekly:{usedPercent:100}}}));
  });
  const chatId = await page.evaluate(async ({workspace, defaults}) => {
    const project = await window.chatterbox.createProject({name:'웹 계정 관리 검증', folder:workspace,settings:{...defaults,claudeStrengths:'',claudeCautions:'',gptStrengths:'',gptCautions:'',geminiStrengths:'글쓰기',geminiCautions:'글쓰기 전용',geminiModel:'',orchestratorEffort:'xhigh',claudeEffort:'auto',codexEffort:'auto',geminiEffort:'auto',maxClaudeWorkers:3,maxGptWorkers:3,maxGeminiWorkers:1,delegateHighRisk:false}});
    return (await window.chatterbox.createChat(project.id)).id;
  }, {workspace,defaults:DEFAULTS});
  await page.reload(); await page.waitForSelector('[data-testid="sidebar"]');
  await page.locator(`[data-testid="chat-node"][data-chat-id="${chatId}"] [role="treeitem"]`).click();
  check('main sidebar has no separate Gemini web usage bar', await page.locator('[data-provider="gemini-web"]').count() === 0);
  await page.getByTestId('gemini-web-manage').click();
  let dialog = page.getByRole('dialog').filter({hasText:'Gemini 웹 계정 관리'});
  await dialog.getByTestId('gemini-web-account').waitFor();
  check('management starts with the existing account 1', await dialog.getByTestId('gemini-web-account').count() === 1);
  const dialogText = await dialog.innerText();
  check('management explains previous-account preference, idle fallback and waiting', ['10개', '이전 계정', '10% 이하', '쉬고 있는 계정', '대기', '주기적으로'].every(text => dialogText.includes(text)));
  check('opening management never opens Google or starts a model', await app.evaluate(() => !globalThis.__webAccountsUi.calls.some(c=>c.action==='open')));
  for(let n=2;n<=10;n++) {
    await dialog.getByTestId('gemini-web-add-account').click();
    await page.waitForFunction(n=>document.querySelectorAll('[data-testid="gemini-web-account"]').length===n,n);
  }
  check('ten separately identified accounts are rendered', await dialog.getByTestId('gemini-web-account').count()===10 && await dialog.locator('[data-account-id="gemini-10"]').count()===1);
  check('account add is disabled at the limit', await dialog.getByTestId('gemini-web-add-account').isDisabled());
  const overflow = await page.evaluate(async()=>{try{await window.chatterbox.geminiWebAccounts('add');return '';}catch(e){return String(e);}});
  check('an eleventh account is rejected by the API', overflow.includes('10'));
  const card = dialog.locator('[data-account-id="gemini-2"]');
  await card.getByRole('textbox',{name:'계정 2 이름'}).fill('문서 편집 계정');
  await card.getByRole('button',{name:'저장',exact:true}).click();
  await page.waitForFunction(()=>globalThis.document.querySelector('[aria-label="계정 2 이름"]')?.value==='문서 편집 계정');
  check('account label update reaches the intended account', await app.evaluate(()=>globalThis.__webAccountsUi.accounts.find(a=>a.accountId==='gemini-2').label==='문서 편집 계정'));
  await card.getByRole('checkbox',{name:'계정 2 자동 배정'}).uncheck();
  check('account exclusion reaches the intended account', await app.evaluate(()=>globalThis.__webAccountsUi.accounts.find(a=>a.accountId==='gemini-2').enabled===false));
  await card.getByRole('button',{name:'로그인 / 브라우저',exact:true}).click();
  await card.getByText('로그인됨',{exact:true}).waitFor();
  check('login opens only the selected profile', await app.evaluate(()=>globalThis.__webAccountsUi.calls.filter(c=>c.action==='open').every(c=>c.id==='gemini-2')));
  check('current and weekly quota are shown inside management', (await card.getByTestId('gemini-web-account-usage').innerText()).includes('80% 남음') && (await card.getByTestId('gemini-web-account-usage').innerText()).includes('95% 남음'));
  check('quota tooltip preserves reset information', (await card.getByTestId('gemini-web-account-usage').getAttribute('title')).includes('오늘 저녁'));
  await card.getByRole('button',{name:'사용량 확인',exact:true}).click();
  check('refresh is scoped to the selected profile', await app.evaluate(()=>globalThis.__webAccountsUi.calls.filter(c=>c.action==='refresh').every(c=>c.id==='gemini-2')));
  await app.evaluate(()=>{const a=globalThis.__webAccountsUi.accounts.find(a=>a.accountId==='gemini-3');a.state='busy';a.message='다른 글쓰기 작업 중';});
  await page.waitForTimeout(3100);
  check('busy account cannot be excluded from under a running job', await dialog.getByRole('checkbox',{name:'계정 3 자동 배정'}).isDisabled());
  await app.evaluate(()=>{const a=globalThis.__webAccountsUi.accounts.find(a=>a.accountId==='gemini-4');a.usage={status:'error',detail:'로그인 확인 필요',checkedAt:Date.now(),current:{usedPercent:15}};a.remainingPercent=undefined;});
  await page.waitForTimeout(3100);
  const failedText=await dialog.locator('[data-account-id="gemini-4"] [data-testid="gemini-web-account-usage"]').innerText();
  check('failed quota query is shown without stale numeric values', failedText.includes('로그인 확인 필요')&&!failedText.includes('% 남음'));
  await page.screenshot({path:join(screenshots,'accounts-dark.png'),fullPage:true});
  await dialog.getByText('닫기',{exact:true}).click();
  await page.getByLabel('테마 전환').click();
  await page.getByTestId('gemini-web-manage').click();
  dialog=page.getByRole('dialog').filter({hasText:'Gemini 웹 계정 관리'});
  await dialog.getByRole('textbox',{name:'계정 2 이름'}).waitFor();
  check('labels and exclusions remain after closing and reopening management', await dialog.getByRole('textbox',{name:'계정 2 이름'}).inputValue()==='문서 편집 계정' && !(await dialog.getByRole('checkbox',{name:'계정 2 자동 배정'}).isChecked()));
  await page.setViewportSize({width:760,height:900});
  const layout=await dialog.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
  check('management fits a narrow window without horizontal overflow', layout.scrollWidth<=layout.width+1,JSON.stringify(layout));
  await page.screenshot({path:join(screenshots,'accounts-light-narrow.png'),fullPage:true});
  await dialog.getByRole('checkbox',{name:'계정 2 자동 배정'}).check();
  await dialog.getByText('닫기',{exact:true}).click();
  await page.getByLabel('이 채팅의 Gemini 모델').click();
  await page.getByTestId('gemini-web-connect').click();
  dialog=page.getByRole('dialog').filter({hasText:'Gemini 웹 계정 관리'});
  await dialog.getByTestId('gemini-web-use-argon').waitFor();
  check('the model picker opens the same account management page', await dialog.getByTestId('gemini-web-account').count()===10);
  await dialog.getByTestId('gemini-web-use-argon').click();
  await page.waitForFunction(async id=>(await window.chatterbox.listChats()).find(c=>c.id===id)?.geminiModelOverride==='gemini-web-argon',chatId);
  check('automatic web allocation remains connected to the existing chat model', true);
  check('web usage stays absent from the main sidebar after management', await page.locator('[data-provider="gemini-web"]').count()===0);
  console.log('Scratch data and screenshots:',base);
} catch(e) {console.error(e);check('web account management UI completed',false,e.stack??e.message);}
finally {await app?.close().catch(()=>{});}
finish();

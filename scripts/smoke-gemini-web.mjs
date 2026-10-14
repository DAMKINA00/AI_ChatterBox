// Opt-in live subscription test. Uses an isolated app DB and the explicitly named web account profile.
// No production app restart, no credentials copied, no private project content sent.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, "..");
if (!process.env.CBX_WEB_PROFILE_DATA) throw new Error("Set CBX_WEB_PROFILE_DATA to the logged-in ChatterBox data directory. This test sends synthetic prompts using that account.");
const base = join(root, ".scratch", `gemini-web-smoke-${Date.now()}`);
const work = join(base, "workspace");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "AGENTS.md"), "# Test workspace\nUse the ChatterBox bridge. Only the synthetic material in the user request is relevant. Do not write files.\n");
const source = `
import {app} from 'electron';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {Store} from './src/main/db';
import {ChatManager} from './src/main/chats';
import {Orchestrator} from './src/main/orchestrator';
import {GeminiWebBrowser} from './src/main/drivers/gemini-web-browser';
import {GeminiWebDriver} from './src/main/drivers/gemini-web';
import {DEFAULT_SETTINGS,GEMINI_WEB_MODEL} from './src/shared/types';
const base=process.env.CBX_SMOKE_BASE!, work=join(base,'workspace');
app.setPath('userData',join(base,'electron'));
app.whenReady().then(async()=>{
 const store=new Store(join(base,'test.db')), events:any[]=[],checks:any[]=[];
 const check=(name:string,ok:boolean)=>{checks.push({name,ok});console.log(ok?'PASS':'FAIL',name);};
 const chats=new ChatManager(store,{agents(){},chat(){},consult(c){console.log('CONSULT',c.id,c.status);},usage(){},
 event(e){events.push(e);if(['error','turn_end','dispatch'].includes(e.event.type))console.log('EVENT',e.role,JSON.stringify(e.event));}},base,join(process.cwd(),'out/main/bridge-mcp.js'));
 const browser=new GeminiWebBrowser(process.env.CBX_WEB_PROFILE_DATA!,u=>chats.mergeUsage({geminiWeb:u}));
 chats.geminiWeb=()=>browser;
 const engine=new Orchestrator(chats);
 try{
  await chats.start();
  await browser.open(false);
  const usage=await browser.refreshUsage();
  console.log('USAGE',JSON.stringify(usage));
  check('actual web current and weekly quotas',!!usage.current && !!usage.weekly);
  if(process.env.CBX_WEB_BROWSER_ONLY==='1'){
   await browser.claim('first');
   let refused=false;try{await browser.claim('second');}catch{refused=true;}
   browser.release('second');
   check('same account refuses concurrent claim',refused&&(browser as any).owner==='first');
   const before=await browser.snapshot();
   if(before?.draft.trim()||before?.generating)throw new Error('Existing manual draft/response; leave it untouched.');
   const wc=(browser as any).win.webContents;
   await wc.executeJavaScript("document.querySelector('rich-textarea [contenteditable=true]').focus()");
   await wc.insertText('ChatterBox synthetic draft preservation test');
   refused=false;try{await browser.prepare('first',null,new AbortController().signal);}catch{refused=true;}
   check('manual draft preserved and navigation refused',refused&&(await browser.snapshot())?.draft.includes('synthetic draft'));
   wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
   wc.sendInputEvent({type:'keyDown',keyCode:'BACKSPACE'});wc.sendInputEvent({type:'keyUp',keyCode:'BACKSPACE'});
   await new Promise(r=>setTimeout(r,300));
   if((await browser.snapshot())?.draft.trim())throw new Error('Test draft was not cleared; keep browser for inspection.');
   browser.release('first');
   const ends:any[]=[];
   const driver=new GeminiWebDriver({cwd:work,exePath:'',nativeId:null},browser,{nativeId(){},approve:async()=>({verdict:'deny'}),
    emit(e){if(['notice','error','turn_end'].includes(e.type))console.log('STOP_EVENT',JSON.stringify(e));if(e.type==='turn_end')ends.push(e);}});
   try {
    await driver.send({text:'중지 기능 검증용 공개 요청: 1부터 500까지 각각 한 줄씩 번호와 짧은 인사말을 적어줘.',attachments:[],noWrites:true});
    const until=Date.now()+30000;
    let recorded=false;
    while(Date.now()<until){
     const s=await browser.snapshot();if(s?.generating||ends.length)break;
     if(s?.users.length&&!recorded){recorded=true;console.log('STOP_CONTROLS',await wc.executeJavaScript("Array.from(document.querySelectorAll('button')).map(el=>({text:el.innerText,label:el.getAttribute('aria-label')})).filter(x=>/stop|중지|취소/i.test((x.label||'')+' '+x.text))"));}
     await new Promise(r=>setTimeout(r,200));
    }
    const generating=!!(await browser.snapshot())?.generating;
    await driver.stop();
    check('actual generation interrupted by stop',generating&&ends.some(e=>e.interrupted)&&!driver.running);
    await new Promise(r=>setTimeout(r,1000));
    check('web stop control settled generation',!(await browser.snapshot())?.generating);
   } finally {await driver.dispose();}
   return;
  }
  const project=store.createProject('Web Argon integration',work,{...DEFAULT_SETTINGS,orchestratorModel:'claude:sonnet',orchestratorEffort:'high',geminiModel:GEMINI_WEB_MODEL,reviewGate:false,approvalMode:'user'});
  const chat=store.createChat(project.id,'Gemini web synthetic writing');
  await chats.send(chat.id,'Gemini 웹 Argon 작업자 한 명에게 writing으로 이 안내 문장을 자연스럽게 다듬게 해줘: "별빛 도서관은 아침 9시에 연다. 월요일은 쉰다." 사실과 별빛 도서관이라는 이름은 유지하고 친근한 한 문장으로 작성해. 마스터는 받은 문장과 담당자만 짧게 취합해. 파일 읽기·수정이나 코드 분석은 하지 마. 이 테스트에서는 다른 작업자는 부르지 마.',[]);
  const until=Date.now()+240000;
  while(['working','approval'].includes(store.chat(chat.id)!.status)&&Date.now()<until)await new Promise(r=>setTimeout(r,400));
  if(['working','approval'].includes(store.chat(chat.id)!.status))await engine.stop(chat.id);
  const cs=store.listConsults(chat.id),workers=store.listAgents(chat.id);
  check('master completed',store.chat(chat.id)!.status==='done');
  check('one Gemini worker created',workers.length===1&&workers[0].kind==='gemini');
  check('master delegated real web writing with recorded reason',cs.length===1&&cs[0].status==='done'&&cs[0].kind==='writing'&&!!cs[0].reason);
  check('Argon prose persisted and synthesized',events.some(e=>e.role===workers[0]?.key&&e.event.type==='text'&&/별빛 도서관/.test(e.event.text)&&/월요일/.test(e.event.text))&&events.findLast(e=>e.event.type==='text')?.role==='orch');
  check('native web conversation persisted',!!workers[0]?.sessionId?.startsWith('web:gemini-1:'));
  check('no invented web token counters',!events.some(e=>e.role===workers[0]?.key&&e.event.type==='agent_usage'));
  if(workers[0]?.sessionId) {
   const native=workers[0].sessionId;
   await chats.send(chat.id,'같은 Gemini 웹 작업자를 writing으로 다시 호출해 방금 도서관 안내 문장을 차분한 사서 캐릭터의 존댓말 대사로 다듬게 해줘. 도서관 이름·운영시간·휴무는 그대로 유지해. 원문을 다시 전달하지 말고 이전 웹 대화가 유지되는지 확인해. 한 문장 결과만 짧게 취합해.',[]);
   const secondUntil=Date.now()+240000;
   while(['working','approval'].includes(store.chat(chat.id)!.status)&&Date.now()<secondUntil)await new Promise(r=>setTimeout(r,400));
   if(['working','approval'].includes(store.chat(chat.id)!.status))await engine.stop(chat.id);
   const latest=store.listConsults(chat.id).at(-1);
   check('resumed same web conversation and received dialogue',store.chat(chat.id)!.status==='done'&&store.listAgents(chat.id)[0].sessionId===native&&latest?.status==='done'&&latest.kind==='writing'&&/별빛 도서관/.test(latest.responseSummary??'')&&/월요일/.test(latest.responseSummary??''));
  }
 }catch(e){console.error(e);check(String(e),false);}
 finally{
  await engine.judge.dispose();await chats.dispose();await browser.dispose();store.close();
  writeFileSync(join(base,'results.json'),JSON.stringify({base,checks},null,2));writeFileSync(join(base,'events.json'),JSON.stringify(events,null,2));
  console.log('Evidence:',base);app.exit(checks.every(c=>c.ok)?0:1);
 }
});
`;
const bundle=join(base,"harness.cjs");
await build({stdin:{contents:source,resolveDir:root,loader:"ts"},outfile:bundle,bundle:true,platform:"node",format:"cjs",external:["electron"]});
const electron=createRequire(import.meta.url)("electron");
const env={...process.env,CBX_SMOKE_BASE:base}; delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[bundle],{cwd:root,env,stdio:"inherit",windowsHide:true});
child.on("exit",code=>{process.exitCode=code??1;});

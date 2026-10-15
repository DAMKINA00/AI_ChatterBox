// Native account allocation against intercepted HTTPS fixtures; no Google requests or production data.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const data=join(root,".scratch",`gemini-account-wake-${Date.now()}`);
mkdirSync(data,{recursive:true});
const main=join(data,"main.cjs");
await build({stdin:{resolveDir:root,loader:"ts",contents:`
import {app,session,BrowserWindow} from 'electron';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {GeminiWebAccounts} from './src/main/drivers/gemini-web-accounts';
import {GeminiWebBrowser} from './src/main/drivers/gemini-web-browser';
const data=${JSON.stringify(data)}, results:{name:string;ok:boolean}[]=[];
const check=(name:string,ok:unknown)=>{results.push({name,ok:!!ok});if(!ok)throw Error(name);};
const delay=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(predicate:()=>boolean){for(let n=0;n<300;n++){if(predicate())return;await delay(50);}throw Error('Allocation did not settle');}
app.setPath('userData',join(data,'electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
let pool:GeminiWebAccounts, finishRead:(value:any)=>void;
const controller=new AbortController();let task:Promise<void>;
void app.whenReady().then(async()=>{
 try{
  for(let n=1;n<=4;n++){
   const ses=session.fromPath(join(data,'web-accounts','gemini-'+n));
   await ses.protocol.handle('https',req=>new Response('<!doctype html><html><body>'+(new URL(req.url).pathname==='/usage'
    ? '<div data-test-id="gxu-currently">'+(n===1?100:n)+'% used</div><div data-test-id="gxu-weekly">1% used</div>'
    : '<button aria-label="Model picker">Argon</button><rich-textarea><div contenteditable="true" role="textbox" style="min-height:40px"></div></rich-textarea>')+'</body></html>',{headers:{'content-type':'text/html; charset=utf-8'}}));
  }
  const settings=new Map<string,string>();
  pool=new GeminiWebAccounts(data,{getSetting:key=>settings.get(key),setSetting:(key,value)=>{settings.set(key,value);}});
  const first=pool.browser('gemini-1');await first.refreshUsage(true);
  let waiting=false,chosen:GeminiWebBrowser|undefined,stalled=false,inject=false;
  const refresh=first.refresh.bind(first);
  first.refresh=(read=true)=>inject?new Promise(resolve=>{stalled=true;finishRead=resolve;}):refresh(read);
  task=pool.acquire('native-waiting-request',controller.signal,'gemini-1',()=>{waiting=true;}).then(browser=>{chosen=browser;});
  await until(()=>waiting);
  check('exhausted original account keeps the request pending',!chosen&&pool.list()[0].remainingPercent===0);
  inject=true;await until(()=>stalled);
  check('previous account status lookup is still pending',!chosen&&stalled);
  for(let n=2;n<=4;n++)pool.add();
  const readyAt=Date.now();
  const second=pool.browser('gemini-2');await second.open(false);await second.refreshUsage(true);
  await until(()=>!!chosen);await task;
  check('new authenticated account wakes allocation before the old lookup completes',chosen===second&&Date.now()-readyAt<5000);
  check('the original request owns only its selected account',pool.list().filter(a=>a.state==='busy').map(a=>a.accountId).join(',')==='gemini-2');
  check('new account profile remains isolated from the original account', (first as any).win===undefined&&(second as any).win.webContents.session===session.fromPath(join(data,'web-accounts','gemini-2')));
  inject=false;finishRead(first.status());await delay(100);
  check('a late original-account lookup cannot release the selected account',second.busy&&!first.busy);
  second.release('native-waiting-request');
  check('wake subscriptions are removed after assignment',(pool as any).changes.size===0);
  await pool.dispose();check('native windows are closed on disposal',BrowserWindow.getAllWindows().length===0);
  writeFileSync(join(data,'results.json'),JSON.stringify({results},null,2));app.exit(0);
 }catch(error){controller.abort();finishRead?.(undefined);await task?.catch(()=>{});await pool?.dispose();writeFileSync(join(data,'results.json'),JSON.stringify({results,error:String(error)},null,2));app.exit(1);}
});
`},outfile:main,bundle:true,platform:"node",format:"cjs",external:["electron"],logLevel:"error"});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let failure;
await new Promise(resolve=>execFile(join(root,"node_modules","electron","dist","electron.exe"),[main],{cwd:root,env,windowsHide:true,timeout:60000},error=>{failure=error;resolve();}));
const report=JSON.parse(readFileSync(join(data,"results.json"),"utf8"));
for(const r of report.results)console.log((r.ok?"PASS ":"FAIL ")+r.name);
console.log('Evidence: '+data);
if(failure)throw Error(report.error||failure.message);
console.log(report.results.length+'/'+report.results.length+' native account wake checks passed');

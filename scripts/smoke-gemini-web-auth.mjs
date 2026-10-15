// Synthetic OAuth navigation only: isolated Electron profile, intercepted HTTPS, no Google requests.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, ".scratch", `gemini-auth-native-${Date.now()}`);
mkdirSync(data, { recursive: true });
const main = join(data, "main.cjs");
await build({ stdin: {resolveDir:root, loader:"ts", contents:`
import { app, session, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { GeminiWebBrowser } from './src/main/drivers/gemini-web-browser';
const data=${JSON.stringify(data)}, results: {name:string;ok:boolean}[]=[];
const check=(name:string,ok:unknown)=>{results.push({name,ok:!!ok});if(!ok)throw Error(name);};
const delay=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(predicate:()=>boolean){for(let n=0;n<100;n++){if(predicate())return;await delay(50);}throw Error('Auth transition did not settle');}
const editor='<button aria-label="Model picker">Argon</button><rich-textarea><div contenteditable="true" role="textbox" style="min-height:40px"></div></rich-textarea>';
app.setPath('userData',join(data,'electron'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
let browser:GeminiWebBrowser;
void app.whenReady().then(async()=>{
 try{
  const ses=session.fromPath(join(data,'web-accounts','gemini-1')), requested:string[]=[];
  let signedIn=false;
  await ses.protocol.handle('https',req=>{
   const u=new URL(req.url);requested.push(u.hostname+u.pathname);
   if(u.hostname==='www.google.com'&&u.pathname==='/accounts/SetSID')return Response.redirect('https://gemini.google.com/app',302);
   if(u.hostname==='accounts.google.com'&&u.pathname==='/finish'){signedIn=true;return Response.redirect('https://www.google.com/accounts/SetSID',302);}
   let body=u.hostname==='accounts.google.com'?'<button id="next" data-url="https://accounts.google.com/finish" onclick="location.href=this.dataset.url">Next</button>':signedIn?editor:'<button>Sign in</button>';
   if(u.hostname==='gemini.google.com'&&u.pathname==='/app'&&!signedIn)body+='<a id="auth" href="https://gemini.google.com/signin?continue=fixture" target="oauth">Login</a><script>document.getElementById("auth").click()</script>';
   return new Response('<!doctype html><html><body>'+body+'</body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  });
  const confirmed:any[]=[];browser=new GeminiWebBrowser(data,()=>{},'gemini-1',undefined,s=>confirmed.push(s));
  const b=browser as any,make=b.makeWindow.bind(browser);
  b.makeWindow=()=>{const win=make(false);win.setPosition(-4000,40);win.show=()=>win.showInactive();win.focus=()=>{};return win;};
  await browser.login();const original=b.win as BrowserWindow;
  check('first login survives a popup opened during initial page load',browser.status().state==='login_required'&&!original.isDestroyed());
  await until(()=>BrowserWindow.getAllWindows().some(w=>w!==original&&w.webContents.getURL().includes('/signin')));
  const popup=BrowserWindow.getAllWindows().find(w=>w!==original&&w.webContents.getURL().includes('/signin'))!;
  check('login popup preserves the opener without replacing the main page',original.webContents.getURL()==='https://gemini.google.com/app'&&await popup.webContents.executeJavaScript('!!window.opener'));
  check('authentication popup shares only its account session',popup.webContents.session===original.webContents.session);
  check('authentication popup stays sandboxed without Node or app preload',popup.webContents.getLastWebPreferences().sandbox===true&&popup.webContents.getLastWebPreferences().nodeIntegration===false&&!popup.webContents.getLastWebPreferences().preload);
  await popup.webContents.executeJavaScript("setTimeout(()=>location.href='https://accounts.google.com/login',0);true");
  await until(()=>popup.webContents.getURL()==='https://accounts.google.com/login');
  await delay(150);
  check('Google login page is never treated as completed',confirmed.length===0&&browser.status().state==='login_required');
  await popup.webContents.executeJavaScript("document.getElementById('next').click();true");
  await until(()=>confirmed.length===1);
  check('Google cookie handoff navigation reaches Gemini without a frozen Next button',requested.includes('www.google.com/accounts/SetSID'));
  check('authenticated popup refreshes the pending Gemini page and confirms once',signedIn&&browser.status().state==='ready'&&confirmed.length===1);
  check('completion hides the login window and closes the completed popup',!original.isVisible()&&popup.isDestroyed());
  await browser.open(true);
  await original.webContents.executeJavaScript("window.open('https://example.com/auth','blocked');true");
  await delay(200);
  check('unrelated popup hosts remain blocked',!requested.some(u=>u.startsWith('example.com'))&&BrowserWindow.getAllWindows().every(w=>!w.webContents.getURL().startsWith('https://example.com')));
  await original.webContents.executeJavaScript("setTimeout(()=>location.href='https://www.google.com/search?q=blocked',0);true");
  await delay(200);
  check('Google pages unrelated to authentication remain blocked',!requested.some(u=>u.startsWith('www.google.com/search'))&&original.webContents.getURL()==='https://gemini.google.com/app');
  await browser.dispose();
  check('shutdown releases authentication windows',BrowserWindow.getAllWindows().length===0);
  writeFileSync(join(data,'results.json'),JSON.stringify({results},null,2));app.exit(0);
 }catch(error){await browser?.dispose().catch(()=>{});writeFileSync(join(data,'results.json'),JSON.stringify({results,error:String(error)},null,2));app.exit(1);}
});
`}, outfile:main, bundle:true, platform:"node", format:"cjs", external:["electron"], logLevel:"error" });
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let failure;
await new Promise(resolve=>execFile(join(root,"node_modules","electron","dist","electron.exe"),[main],{cwd:root,env,windowsHide:true,timeout:60000},error=>{failure=error;resolve();}));
const report=JSON.parse(readFileSync(join(data,"results.json"),"utf8"));
for(const r of report.results)console.log((r.ok?"PASS ":"FAIL ")+r.name);
console.log('Evidence: '+data);
if(failure)throw Error(report.error||failure.message);
console.log(report.results.length+'/'+report.results.length+' native authentication checks passed');

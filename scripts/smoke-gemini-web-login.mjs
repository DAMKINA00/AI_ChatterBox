// Native Electron window lifecycle against local fixtures; no Google requests or production profile.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = join(root, ".scratch", `gemini-login-native-${Date.now()}`);
mkdirSync(data, { recursive: true });
const main = join(data, "main.cjs");
await build({
  stdin: { resolveDir: root, loader: "ts", contents: `
import { app, session } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { GeminiWebBrowser } from './src/main/drivers/gemini-web-browser';
const data = ${JSON.stringify(data)};
const results: {name: string; ok: boolean}[] = [];
const check = (name: string, ok: unknown) => { results.push({name, ok: !!ok}); if (!ok) throw new Error(name); };
const delay = (n: number) => new Promise(r => setTimeout(r, n));
async function until(predicate: () => boolean) { for(let n=0;n<100;n++){ if(predicate()) return; await delay(50); } throw new Error('Native window did not settle'); }
const loggedOut = '<button>Sign in</button>';
const loggedIn = '<button aria-label="Model picker">Argon</button><rich-textarea><div contenteditable="true" role="textbox" style="min-height:40px"></div></rich-textarea>';
app.setPath('userData', join(data, 'electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let browser: GeminiWebBrowser;
let secondBrowser: GeminiWebBrowser;
void app.whenReady().then(async () => {
 try {
  for (const id of ['gemini-1', 'gemini-2']) {
   const ses = session.fromPath(join(data, 'web-accounts', id));
   await ses.protocol.handle('https', req => new Response('<!doctype html><html><body>' + (new URL(req.url).pathname === '/usage'
    ? '<div data-test-id="gxu-currently">2% used</div><div data-test-id="gxu-weekly">0% used</div>' : loggedOut) + '</body></html>', { headers: {'content-type':'text/html; charset=utf-8'} }));
  }
  const confirmed: any[] = [];
  browser = new GeminiWebBrowser(data, () => {}, "gemini-1", undefined, s => confirmed.push(s));
  const isolated = (browser: GeminiWebBrowser) => {
   const b = browser as any, makeWindow = b.makeWindow.bind(browser);
   b.makeWindow = () => { const win = makeWindow(false); win.setPosition(-4000, 40); win.show = () => win.showInactive(); win.focus = () => {}; return win; };
   return b;
  };
  const b = isolated(browser), confirmedSecond: any[] = [];
  secondBrowser = new GeminiWebBrowser(data, () => {}, 'gemini-2', undefined, s => confirmedSecond.push(s));
  const second = isolated(secondBrowser);
  await secondBrowser.login();
  await browser.login();
  check('two native accounts use distinct persistent Electron sessions', b.win.webContents.session !== second.win.webContents.session);
  check('explicit login is pending with a visible isolated native window', browser.status().state === 'login_required' && b.win.isVisible());
  await b.win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(loggedIn));
  await until(() => confirmed.length === 1);
  check('native login window hides automatically and ready status remains', !b.win.isVisible() && browser.status().state === 'ready');
  check('completion feedback explains closed login window', /로그인 완료/.test(confirmed[0].message) && /닫았습니다/.test(confirmed[0].message));
  check('first confirmation leaves the other pending login window open', confirmed[0].accountId === 'gemini-1' && second.win.isVisible() && secondBrowser.status().state === 'login_required');
  await second.win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(loggedIn));
  await until(() => confirmedSecond.length === 1);
  check('second confirmation closes only its own account window', confirmedSecond[0].accountId === 'gemini-2' && !second.win.isVisible());
  await secondBrowser.dispose();
  await delay(1100);
  check('completed login watcher sends one notification', confirmed.length === 1 && !b.loginWatch);
  await browser.open(true);
  await delay(1100);
  check('manual browser open remains visible without automatic close', b.win.isVisible() && confirmed.length === 1);
  await b.win.webContents.executeJavaScript('document.querySelector("[contenteditable]").innerText = "unfinished dialogue"');
  await browser.login();
  check('native draft survives login confirmation and window stays open', b.win.isVisible() && (await browser.snapshot())?.draft === 'unfinished dialogue');
  await b.win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(loggedIn + '<button aria-label="Stop response">Stop</button>'));
  await browser.login();
  check('native generation controls prevent automatic close', b.win.isVisible() && (await browser.snapshot())?.generating);
  await b.win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(loggedOut));
  await browser.login();
  const beforeClose = confirmed.length, win = b.win;
  win.close();
  await until(() => win.isDestroyed());
  await delay(1100);
  check('manual close cancels login watcher without a success notification', !b.loginWatch && confirmed.length === beforeClose && browser.status().state === 'closed');
  await browser.login();
  await browser.claim('fixture-worker');
  await b.win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(loggedIn));
  await browser.refresh(false);
  check('worker ownership cancels login auto-close without stopping the worker', b.owner === 'fixture-worker' && !b.loginWatch && b.win.isVisible() && browser.status().state === 'busy');
  browser.release('fixture-worker');
  await browser.dispose();
  check('shutdown clears login timer and destroys native windows', !b.loginWatch && !b.owner && (!b.win || b.win.isDestroyed()));
  writeFileSync(join(data, 'results.json'), JSON.stringify({results}, null, 2));
  app.exit(0);
 } catch (error) {
  await secondBrowser?.dispose().catch(() => {});
  await browser?.dispose().catch(() => {});
  writeFileSync(join(data, 'results.json'), JSON.stringify({results,error:String(error)}, null, 2));
  app.exit(1);
 }
});
` },
  outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error",
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => execFile(join(root, "node_modules", "electron", "dist", "electron.exe"), [main],
  { cwd: root, env, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
const report = JSON.parse(readFileSync(join(data, "results.json"), "utf8"));
for (const result of report.results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}`);
console.log(`${report.results.filter(r => r.ok).length}/${report.results.length} native fixture checks passed; ${data}`);

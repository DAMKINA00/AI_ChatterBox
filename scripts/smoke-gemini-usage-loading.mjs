// Real sandboxed windows with delayed HTTPS fixtures; no Google requests or user profiles.
import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const data = join(root, ".scratch", `gemini-usage-loading-${Date.now()}`);
mkdirSync(data, { recursive: true });
const main = join(data, "main.cjs");
await build({ stdin: { resolveDir: root, loader: "ts", contents: String.raw`
import assert from 'node:assert/strict';
import { app, session, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { GeminiWebBrowser } from './src/main/drivers/gemini-web-browser';
import { USAGE_SCRIPT, webUsagePage } from './src/main/drivers/gemini-web-protocol';
const data = ${JSON.stringify(data)}, results: string[] = [], browsers: GeminiWebBrowser[] = [];
app.setPath('userData', join(data, 'electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
  let error: string | undefined;
  try {
    for (const [index, n] of [1, 3, 6, 7].entries()) {
      const accountId = ('gemini-' + n) as 'gemini-1';
      const ses = session.fromPath(join(data, 'web-accounts', accountId));
      const used = index === 0 ? 0 : n * 10, weekly = index === 0 ? 12 : n;
      ses.protocol.handle('https', request => {
        assert.equal(new URL(request.url).origin, 'https://gemini.google.com');
        // The reported page uses strong/span cards and data-testid, without Angular's gxu selectors.
        const modern = '<section id="fixture-current"' + (index === 2 ? ' data-testid="current-usage"' : '') + '><div><div><strong>현재 사용량</strong>'
          + '<button aria-label="사용량 한도에 관한 정보"><span aria-hidden="true">info</span></button></div><strong id="current-percent"></strong></div>'
          + '<div role="progressbar" aria-valuenow="99"></div><span id="current-reset"></span></section>'
          + '<div data-testid="weekly-usage"><span><strong>주간 한도</strong><span id="weekly-reset"></span></span><strong id="weekly-percent"></strong></div><script>'
          + 'setTimeout(()=>{document.getElementById("current-percent").textContent="' + used + '% 사용됨";document.getElementById("current-reset").textContent="오전 12:45에 초기화";},700);'
          + 'setTimeout(()=>{document.getElementById("weekly-percent").textContent="' + weekly + '% 사용됨";document.getElementById("weekly-reset").textContent="10월 21일 오후 3:45에 초기화";},1400);</script>';
        const legacy = '<div data-test-id="gxu-currently">현재 사용량</div><div data-test-id="gxu-weekly">주간 한도</div><script>'
          + 'setTimeout(()=>document.querySelector(\'[data-test-id="gxu-currently"]:not([hidden])\').innerText="현재 사용량\\n' + used + '% 사용됨\\n오전 12:45에 초기화",700);'
          + 'setTimeout(()=>document.querySelector(\'[data-test-id="gxu-weekly"]:not([hidden])\').innerText="주간 한도\\n10월 21일 오후 3:45에 초기화\\n' + weekly + '% 사용됨",1400);</script>';
        const html = new URL(request.url).pathname === '/usage'
          ? '<nav><strong>현재 사용량</strong><span>99% 사용됨</span></nav>'
            + (index ? '<div hidden data-test-id="gxu-currently">99% 사용됨</div><div hidden data-testid="weekly-usage">99% 사용됨</div>' : '')
            + (index % 2 === 0 ? modern : legacy)
          : '<button aria-label="Model picker">Argon</button><rich-textarea><div contenteditable="true" role="textbox" style="min-height:40px">보존할 초안</div></rich-textarea>';
        return new Response('<!doctype html><html><body>' + html + '</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      });
      browsers.push(new GeminiWebBrowser(data, () => {}, accountId));
    }
    for (const [index, browser] of browsers.entries()) {
      const n = [1, 3, 6, 7][index], b = browser as any;
      await b.createWindow(false);
      const before = await browser.snapshot();
      const usage = await browser.refreshUsage(true);
      assert.equal(usage.current?.usedPercent, index === 0 ? 0 : n * 10);
      assert.equal(usage.weekly?.usedPercent, index === 0 ? 12 : n);
      assert.equal(usage.current?.resetText, '오전 12:45에 초기화');
      assert.equal(usage.weekly?.resetText, '10월 21일 오후 3:45에 초기화');
      assert.deepEqual(await browser.snapshot(), before);
      assert.equal(b.usageWindow, undefined);
      results.push('account ' + n + ' (' + (index % 2 === 0 ? 'reported strong/span layout' : 'legacy gxu layout') + '): delayed percentages and resets collected; hidden values ignored; draft unchanged');
    }
    const browser = browsers[0], b = browser as any;
    await b.win.loadURL('https://gemini.google.com/usage');
    const status = await browser.refresh();
    assert.equal(status.state, 'ready');
    assert.equal(status.usage.current?.usedPercent, 0);
    assert.equal(status.usage.weekly?.usedPercent, 12);
    assert.equal(b.win.webContents.getURL(), 'https://gemini.google.com/usage');
    assert.ok((await b.win.webContents.executeJavaScript(USAGE_SCRIPT)).weekly.includes('12%'));
    results.push('usage-page refresh succeeds without requiring a chat editor or navigating the visible browser');
    await b.win.webContents.executeJavaScript("document.body.innerHTML='<main><section><strong>현재 사용량</strong><div role=progressbar aria-valuenow=99 style=width:99%></div></section><section data-testid=weekly-usage><strong>주간 한도</strong><span>12% 사용됨</span></section></main>'");
    let observed = await b.win.webContents.executeJavaScript(USAGE_SCRIPT);
    let parsed = webUsagePage(observed.current, observed.weekly);
    assert.equal(parsed.current, undefined);
    assert.equal(parsed.weekly?.usedPercent, 12);
    results.push('a missing current percentage never borrows the weekly value or a progress-bar width');
    await b.win.webContents.executeJavaScript("document.querySelector('[data-testid=weekly-usage]').setAttribute('hidden','')");
    observed = await b.win.webContents.executeJavaScript(USAGE_SCRIPT);
    assert.equal(webUsagePage(observed.current, observed.weekly).status, 'unknown');
    results.push('hidden percentages are never reported as visible quota');
    await b.win.loadURL('https://gemini.google.com/app');
    assert.equal(await b.win.webContents.executeJavaScript(USAGE_SCRIPT), null);
    results.push('chat pages remain outside the usage reader');
  } catch (e) { error = String(e); }
  finally {
    await Promise.all(browsers.map(browser => browser.dispose()));
    if (BrowserWindow.getAllWindows().length) error = error || 'test windows leaked';
    writeFileSync(join(data, 'results.json'), JSON.stringify({ results, error }, null, 2));
    app.exit(error ? 1 : 0);
  }
});
` }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error" });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let failure;
await new Promise(resolve => execFile(join(root, "node_modules/electron/dist/electron.exe"), [main],
  { cwd: root, env, windowsHide: true, timeout: 60000 }, error => { failure = error; resolve(); }));
const report = JSON.parse(readFileSync(join(data, "results.json"), "utf8"));
for (const result of report.results) console.log("PASS " + result);
console.log("Evidence: " + data);
if (failure || report.error) throw Error(report.error || failure.message);
console.log(report.results.length + "/" + report.results.length + " native usage loading checks passed");

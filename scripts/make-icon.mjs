// Renders build/icon.png (512x512) from an inline SVG using the built app's Electron window.
// electron-builder turns it into the .ico. Usage: npm run build && node scripts/make-icon.mjs
import { _electron as electron } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "icon.png");
mkdirSync(dirname(out), { recursive: true });

// Two overlapping speech bubbles: Claude orange and Codex green.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="104" fill="#1b1d22"/>
  <path d="M96 128h212a40 40 0 0 1 40 40v108a40 40 0 0 1-40 40H180l-64 52v-52h-20a40 40 0 0 1-40-40V168a40 40 0 0 1 40-40z" fill="#d9895b"/>
  <path d="M204 236h212a40 40 0 0 1 40 40v108a40 40 0 0 1-40 40h-20v52l-64-52H204a40 40 0 0 1-40-40V276a40 40 0 0 1 40-40z" fill="#5fbf9a"/>
  <circle cx="250" cy="330" r="16" fill="#1b1d22"/>
  <circle cx="310" cy="330" r="16" fill="#1b1d22"/>
  <circle cx="370" cy="330" r="16" fill="#1b1d22"/>
</svg>`;

const app = await electron.launch({ args: [root], env: { ...process.env, AI_CHATTERBOX_DATA: join(root, ".scratch", "icon-data") } });
const page = await app.firstWindow();
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: out, omitBackground: true });
await app.close();
console.log(out);

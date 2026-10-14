#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const assetRoot = join(root, "src", "renderer", "public", "characters");
const galleryPath = join(root, "docs", "character-gallery.html");
const previewPath = join(root, ".scratch", "character-gallery.png");
const roles = ["orch", "claude", "gpt", "gemini"];
const expressions = ["neutral", "thinking", "speaking", "happy", "confident", "surprised", "embarrassed", "worried", "sad", "angry", "tired", "waiting"];
const entries = roles.flatMap((role) => expressions.map((expression) => ({ role, expression })));
entries.push({ role: "admin", expression: "neutral" });
const files = entries.map(({ role, expression }) => join(assetRoot, role, `${expression}.png`));

function displayPath(file) {
  return relative(root, file).replaceAll("\\", "/");
}

function nativeImageWorkerSource() {
  return String.raw`const { app, nativeImage } = require("electron");

const files = ${JSON.stringify(files)};
app.setPath("userData", require("node:path").join(__dirname, "electron-data"));

function inspect(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return { file, empty: true };
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let hasTransparentPixel = false;
  let hasOpaquePixel = false;
  for (let i = 3; i < bitmap.length; i += 4) {
    const alpha = bitmap[i];
    if (alpha === 0) hasTransparentPixel = true;
    if (alpha === 255) hasOpaquePixel = true;
    if (hasTransparentPixel && hasOpaquePixel) break;
  }
  return { file, width: size.width, height: size.height, bitmapBytes: bitmap.length, hasTransparentPixel, hasOpaquePixel };
}

app.whenReady().then(() => {
  try {
    const report = files.map(inspect);
    process.stdout.write("CHARACTER_ASSET_REPORT:" + JSON.stringify(report) + "\n");
    app.quit();
  } catch (error) {
    process.stderr.write(String(error?.stack || error));
    app.exit(1);
  }
});
`;
}

async function inspectWithNativeImage() {
  const electronModule = await import("electron");
  const electronPath = typeof electronModule.default === "string" ? electronModule.default : undefined;
  if (!electronPath) throw new Error("Electron executable was not found for nativeImage validation.");

  const scratch = mkdtempSync(join(root, ".scratch", "character-assets-"));
  const workerPath = join(scratch, "native-image-worker.cjs");
  writeFileSync(workerPath, nativeImageWorkerSource(), "utf8");
  try {
    const result = spawnSync(electronPath, [workerPath], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const line = output.split(/\r?\n/).findLast((entry) => entry.startsWith("CHARACTER_ASSET_REPORT:"));
    if (result.error) throw result.error;
    if (!line) throw new Error(`Electron nativeImage worker did not return a report.\n${output.trim()}`);
    if (result.status !== 0) throw new Error(`Electron nativeImage worker exited with ${result.status}.\n${output.trim()}`);
    return JSON.parse(line.slice("CHARACTER_ASSET_REPORT:".length));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function validateReport(report) {
  const missing = report.filter((entry) => entry.empty);
  if (missing.length) throw new Error(`nativeImage could not decode:\n${missing.map((entry) => `  - ${displayPath(entry.file)}`).join("\n")}`);

  const dimensions = new Set(report.map((entry) => `${entry.width}x${entry.height}`));
  const invalidDimensions = report.filter((entry) => !entry.width || !entry.height || entry.width !== entry.height);
  if (dimensions.size !== 1 || invalidDimensions.length) {
    const detail = report.map((entry) => `  - ${displayPath(entry.file)}: ${entry.width || 0}x${entry.height || 0}`).join("\n");
    throw new Error(`Character PNGs must share one non-zero square dimension.\n${detail}`);
  }

  const opaqueOnly = report.filter((entry) => !entry.hasTransparentPixel || !entry.hasOpaquePixel);
  if (opaqueOnly.length) {
    throw new Error(
      `Character PNGs must contain both transparent and opaque pixels:\n${opaqueOnly
        .map((entry) => `  - ${displayPath(entry.file)} (transparent=${entry.hasTransparentPixel}, opaque=${entry.hasOpaquePixel})`)
        .join("\n")}`,
    );
  }
  return dimensions.values().next().value;
}

async function makePreview() {
  if (!existsSync(galleryPath)) throw new Error(`Gallery file is missing: ${displayPath(galleryPath)}`);
  const { _electron: electron } = await import("playwright-core");
  const dataDir = mkdtempSync(join(root, ".scratch", "character-gallery-data-"));
  mkdirSync(dirname(previewPath), { recursive: true });
  let app;
  try {
    app = await electron.launch({
      args: [root],
      env: { ...process.env, AI_CHATTERBOX_DATA: dataDir, AI_CHATTERBOX_HIDE: "1" },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(pathToFileURL(galleryPath).href, { waitUntil: "load" });
    await page.screenshot({ path: previewPath, fullPage: true });
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const missing = files.filter((file) => !existsSync(file));
if (missing.length) {
  console.error(`Character assets incomplete: expected ${files.length}, found ${files.length - missing.length}.`);
  console.error(missing.map((file) => `  - ${displayPath(file)}`).join("\n"));
  process.exitCode = 1;
} else {
  try {
    const report = await inspectWithNativeImage();
    const dimension = validateReport(report);
    console.log(`PASS  ${report.length} character PNGs decoded as ${dimension} with real transparency.`);
    if (!process.argv.includes("--no-preview")) {
      try {
        await makePreview();
        console.log(`PASS  gallery preview: ${displayPath(previewPath)}`);
      } catch (error) {
        console.warn(`WARN  gallery preview skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.error(`Character asset validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

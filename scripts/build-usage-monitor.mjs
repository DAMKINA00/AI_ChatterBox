import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(workspace, "build", "usage-monitor.json");
const publishDir = join(workspace, ".scratch", "usage-monitor-publish");
const sourceDir = resolve(process.env.AI_USAGE_SOURCE?.trim() || join(workspace, "..", "AIUsageMonitor"));

const log = (message) => console.log(`[usage-monitor] ${message}`);

function fail(message) {
  throw new Error(message);
}

function git(source, args) {
  try {
    return execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function isCi() {
  return !["", "0", "false", "no"].includes(String(process.env.CI ?? "").toLowerCase());
}

function loadManifest() {
  if (!existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
  }

  if (manifest.repository !== "DAMKINA00/AI_UsageMonitor") {
    fail("manifest.repository must be DAMKINA00/AI_UsageMonitor");
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.revision ?? "")) {
    fail("manifest.revision must be a 40-character commit revision");
  }
  if (manifest.project !== "AIUsageMonitor.csproj") {
    fail("manifest.project must be AIUsageMonitor.csproj");
  }
  if (manifest.publish?.runtime !== "win-x64" || manifest.publish?.selfContained !== true ||
      manifest.publish?.singleFile !== false || manifest.publish?.output !== ".scratch/usage-monitor-publish") {
    fail("manifest.publish must describe win-x64 self-contained non-single-file output");
  }
  return manifest;
}

function verifySource(manifest) {
  if (!existsSync(sourceDir)) fail(`AIUsageMonitor source directory not found: ${sourceDir}`);
  const projectPath = join(sourceDir, manifest.project);
  if (!existsSync(projectPath)) fail(`AIUsageMonitor project not found: ${projectPath}`);

  const head = git(sourceDir, ["rev-parse", "--verify", "HEAD"]);
  if (head.toLowerCase() !== manifest.revision.toLowerCase()) {
    fail(`source HEAD ${head} does not match manifest revision ${manifest.revision}`);
  }

  const dirty = git(sourceDir, ["status", "--porcelain"])
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (dirty.length > 0) {
    if (isCi()) fail(`source worktree is dirty in CI (${dirty.length} paths)`);
    log(`source worktree is dirty; continuing outside CI (${dirty.length} paths)`);
    for (const path of dirty) log(`dirty: ${path}`);
  } else {
    log("source worktree is clean");
  }
  log(`source: ${sourceDir}`);
  log(`revision: ${head}`);
  return projectPath;
}

function publish(projectPath) {
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });
  log(`publishing to ${publishDir}`);
  const result = spawnSync("dotnet", [
    "publish", projectPath,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=false",
    "--output", publishDir,
  ], { cwd: sourceDir, stdio: "inherit", windowsHide: true });
  if (result.error) fail(`dotnet publish could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`dotnet publish failed with exit code ${result.status}`);
}

function verifyOutput() {
  const required = [
    "AIUsageMonitor.exe",
    "AIUsageMonitor.dll",
    "AIUsageMonitor.deps.json",
    "AIUsageMonitor.runtimeconfig.json",
    "coreclr.dll",
    "hostfxr.dll",
    "hostpolicy.dll",
  ];
  const missing = required.filter((name) => !existsSync(join(publishDir, name)));
  if (missing.length > 0) fail(`publish output is missing: ${missing.join(", ")}`);
  log(`verified ${required.length} publish files; executable size ${statSync(join(publishDir, "AIUsageMonitor.exe")).size} bytes`);
}

try {
  const manifest = loadManifest();
  const projectPath = verifySource(manifest);
  publish(projectPath);
  verifyOutput();
  log("usage monitor publish complete");
} catch (error) {
  console.error(`[usage-monitor] ERROR: ${error.message}`);
  process.exitCode = 1;
}

// Regenerates src/main/codex-schema from the installed codex CLI (`codex app-server generate-ts`).
// Usage: npm run codex:schema [-- path\to\codex.exe]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "main", "codex-schema");

function newest(files) {
  return files.filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
function subdirs(dir) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : [];
}

const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const codex =
  process.argv[2] ??
  newest(subdirs(join(local, "OpenAI", "Codex", "bin")).map((d) => join(d, "codex.exe"))) ??
  "codex";

console.log(`codex: ${codex}`);
spawnSync(codex, ["--version"], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
const r = spawnSync(codex, ["app-server", "generate-ts", "--out", out], { stdio: "inherit" });
process.exit(r.status ?? 1);

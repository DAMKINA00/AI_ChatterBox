import { build } from "esbuild";
import { readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
function tests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? tests(join(dir, e.name)) : e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []);
}
const files = tests(join(root, "src"));
const out = join(root, ".scratch", "unit");
mkdirSync(out, { recursive: true });
const bundled = [];
for (const [i, file] of files.entries()) {
  const outfile = join(out, `${i}.test.cjs`);
  await build({ entryPoints: [file], outfile, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "error" });
  bundled.push(outfile);
}
const r = spawnSync(process.execPath, ["--test", ...bundled], { stdio: "inherit" });
process.exit(r.status ?? 1);

// Regenerates spike/codex-schema from the installed codex CLI (types match that CLI version).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findCodex, version, SPIKE_DIR } from "./common.ts";

const codex = findCodex();
console.log(`${codex}\n${version(codex)}`);
const r = spawnSync(codex, ["app-server", "generate-ts", "--out", join(SPIKE_DIR, "codex-schema")], { stdio: "inherit" });
process.exit(r.status ?? 1);

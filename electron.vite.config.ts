import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Remote web avatars: after the renderer build, small copies of the character art go to out/renderer/avatars
 * (scripts/make-remote-avatars.cjs, run in Electron for nativeImage). If it fails the build still succeeds
 * and the remote server falls back to the full-size art.
 */
function remoteAvatars(): Plugin {
  return {
    name: "chatterbox-remote-avatars",
    apply: "build",
    closeBundle() {
      const electron = createRequire(import.meta.url)("electron") as unknown as string;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(electron, [resolve("scripts/make-remote-avatars.cjs"), resolve("src/renderer/public/characters"), resolve("out/renderer/avatars"), "96"], { env, encoding: "utf8", timeout: 120_000, windowsHide: true });
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/).filter(l => /remote avatars/.test(l)).join("\n");
      if (r.status === 0) console.log(text);
      else console.warn(`[remote avatars] skipped (${r.error?.message ?? `exit ${r.status}`}) ${text}`);
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // Loaded by claude.exe / codex.exe as an MCP server (Electron's binary running as Node).
          "bridge-mcp": resolve("src/main/bridge-mcp.ts"),
          "antigravity-hook": resolve("src/main/antigravity-hook.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        // Sandboxed preloads must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), remoteAvatars()],
    build: {
      rollupOptions: {
        // remote.html is served to browsers by the remote web server (src/main/remote-web.ts).
        input: { index: resolve("src/renderer/index.html"), remote: resolve("src/renderer/remote.html") },
      },
    },
  },
});

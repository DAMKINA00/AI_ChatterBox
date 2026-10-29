import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // Loaded by claude.exe / codex.exe as an MCP server (Electron's binary running as Node).
          "bridge-mcp": resolve("src/main/bridge-mcp.ts"),
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // remote.html is served to browsers by the remote web server (src/main/remote-web.ts).
        input: { index: resolve("src/renderer/index.html"), remote: resolve("src/renderer/remote.html") },
      },
    },
  },
});

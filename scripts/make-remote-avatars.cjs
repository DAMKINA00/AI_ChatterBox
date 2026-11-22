// Small copies of the character art for the remote web page (AgentAvatar shows them at 24–36 CSS px; the
// originals are ~1 MB each). Runs inside Electron (dev dependency) for nativeImage; no image library.
// Usage: electron scripts/make-remote-avatars.cjs <characters dir> <out dir> [size]
// Called by the renderer build (electron.vite.config.ts); the originals and the desktop app are untouched.
const { app, nativeImage } = require("electron");
const { mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const [src, out, sizeArg] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const size = Number(sizeArg) || 96;
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  let count = 0, before = 0, after = 0;
  try {
    for (const kind of readdirSync(src)) {
      const dir = join(src, kind);
      if (!statSync(dir).isDirectory() || !/^[a-z]{2,16}$/.test(kind)) continue;
      mkdirSync(join(out, kind), { recursive: true });
      for (const file of readdirSync(dir)) {
        if (!/^[a-z]{2,16}\.png$/.test(file)) continue;
        const image = nativeImage.createFromPath(join(dir, file));
        if (image.isEmpty()) throw new Error(`${kind}/${file}: not an image`);
        const png = image.resize({ width: size, height: size, quality: "best" }).toPNG();
        writeFileSync(join(out, kind, file), png);
        before += statSync(join(dir, file)).size;
        after += png.length;
        count++;
      }
    }
    console.log(`remote avatars: ${count} files, ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(2)} MB (${size}px)`);
    app.exit(0);
  } catch (error) {
    console.error(`remote avatars failed: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
});

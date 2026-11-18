import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export type ExploreKind = "search" | "grep" | "docs";
export interface Evidence { path: string; line?: number; excerpt: string }
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "out", "bin", "obj", "target", "coverage", "__pycache__"]);
const TEXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".cs", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".html", ".css", ".scss", ".sql", ".sh", ".ps1", ".xml", ".yml", ".yaml", ".toml", ".md", ".mdx", ".txt", ".rst"]);
const DOCS = new Set([".md", ".mdx", ".txt", ".rst"]);

/** Literal searches only. No shell, plugins, symlink traversal, or model-controlled file paths. */
export async function exploreRepository(folder: string, query: string, kind: ExploreKind, signal: AbortSignal) {
  const root = await realpath(folder), needle = query.toLocaleLowerCase();
  const evidence: Evidence[] = [];
  const coverage = { visited: 0, read: 0, skipped: 0, limited: false };
  let bytes = 0, directories = 0;
  const inside = (path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !/^[A-Za-z]:|^[/\\]/.test(rel); };
  const walk = async (dir: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 20 || ++directories > 500) { coverage.limited = true; return; }
    // Recheck directories in case another process replaced one with a junction during the walk.
    if (!inside(await realpath(dir))) { coverage.skipped++; return; }
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (coverage.visited >= 3000 || bytes >= 8 * 1024 * 1024 || evidence.length >= 12) { coverage.limited = true; return; }
      if (entry.name.startsWith(".") || SKIP.has(entry.name.toLowerCase()) || /(?:^|[-_.])(?:credentials?|secrets?|tokens?)(?:[-_.]|$)|^(?:id_rsa|id_ed25519)$|\.(?:pem|key|pfx|p12)$/i.test(entry.name)) { coverage.skipped++; continue; }
      const path = join(dir, entry.name);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !inside(await realpath(path))) { coverage.skipped++; continue; }
        if (stat.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!stat.isFile()) continue;
        coverage.visited++;
        const name = relative(root, path).replaceAll("\\", "/");
        if (kind === "search") {
          if (needle.split(/\s+/).every(part => name.toLocaleLowerCase().includes(part))) evidence.push({ path: name, excerpt: "파일 경로 일치" });
          continue;
        }
        if (!(kind === "docs" ? DOCS : TEXT).has(extname(path).toLowerCase()) || stat.size > 256 * 1024) { coverage.skipped++; continue; }
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let data: Buffer;
        try {
          const buffer = Buffer.alloc(256 * 1024 + 1);
          const read = await file.read(buffer, 0, buffer.length, 0);
          data = buffer.subarray(0, read.bytesRead);
        } finally { await file.close(); }
        signal.throwIfAborted();
        bytes += data.length;
        if (data.length > 256 * 1024 || data.includes(0)) { coverage.skipped++; continue; }
        coverage.read++;
        const lines = data.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && evidence.length < 12; i++) {
          const hit = lines[i].toLocaleLowerCase().indexOf(needle);
          if (hit < 0) continue;
          evidence.push({ path: name, line: i + 1, excerpt: lines[i].slice(Math.max(0, hit - 80), hit + 240) });
        }
      } catch (error) {
        signal.throwIfAborted();
        // A changed/deleted or unreadable file makes this a partial scan, never a clean bill of health.
        coverage.skipped++;
      }
    }
  };
  await walk(root, 0);
  return { evidence, coverage, note: "프로젝트 내부의 제한된 검색입니다. 숨김·생성 폴더, 링크, 비밀 파일과 큰 파일은 제외합니다. 결과 없음은 전체 저장소에 없다는 뜻이 아닙니다." };
}

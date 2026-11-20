import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function hasSessionId(file: string, threadId: string): boolean {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(64 * 1024);
    const length = readSync(fd, header);
    const end = header.subarray(0, length).indexOf(10);
    if (end < 0) return false;
    const entry = JSON.parse(header.toString("utf8", 0, end));
    return entry.type === "session_meta" && entry.payload?.id === threadId;
  } finally {
    closeSync(fd);
  }
}

/** Repair one stale index entry in an app-managed CODEX_HOME without changing its session file. */
export function rebindCodexRollout(home: string, threadId: string): boolean {
  if (!isAbsolute(home) || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId)) return false;
  try {
    if (!lstatSync(home).isDirectory()) return false;
    const root = realpathSync.native(home);
    const database = join(root, "state_5.sqlite");
    if (!lstatSync(database).isFile()) return false;
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA busy_timeout = 250");
      const old = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path;
      if (typeof old !== "string" || !old || existsSync(old)) return false;

      // Use only Codex's known layout and the exact filename already indexed for this thread.
      const location = /(?:^|\/)(sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/([^/]+)$/.exec(old.replaceAll("\\", "/"));
      const filename = location?.[2];
      if (!location || !filename?.startsWith("rollout-") || !filename.endsWith(`-${threadId}.jsonl`)) return false;
      const path = join(root, ...location[1].split("/"), filename);
      if (!lstatSync(path).isFile() || realpathSync.native(path) !== path || !hasSessionId(path, threadId)) return false;

      return db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?").run(path, threadId, old).changes === 1;
    } finally {
      db.close();
    }
  } catch {
    // An unsupported index, locked database or unverified file should leave the original error intact.
    return false;
  }
}

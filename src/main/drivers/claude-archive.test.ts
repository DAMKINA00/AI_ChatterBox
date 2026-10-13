import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionArchive } from "./claude-archive";

const id = "12345678-1234-1234-1234-123456789abc";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbx-archive-"));
  const project = join(root, "projects", "C--test");
  mkdirSync(join(project, id), { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), '{"sessionId":"' + id + '"}\n');
  writeFileSync(join(project, id, "sidecar.json"), "kept");
  writeFileSync(join(project, "other.jsonl"), "unrelated");
  return { root, project, archived: join(root, "chatterbox-archived-sessions", "C--test"), api: new ClaudeSessionArchive(root) };
}
test("closed Claude transcript and sidecars disappear from active files and restore byte-for-byte", () => {
  const f = fixture(), original = readFileSync(join(f.project, `${id}.jsonl`));
  f.api.archive(id);
  f.api.archive(id); // idempotent
  assert.equal(existsSync(join(f.project, `${id}.jsonl`)), false);
  assert.equal(existsSync(join(f.project, id)), false);
  assert.equal(readFileSync(join(f.project, "other.jsonl"), "utf8"), "unrelated");
  assert.deepEqual(readFileSync(join(f.archived, `${id}.jsonl`)), original);
  new ClaudeSessionArchive(f.root).restore(id); // fresh instance after app restart
  f.api.restore(id);
  assert.deepEqual(readFileSync(join(f.project, `${id}.jsonl`)), original);
  assert.equal(readFileSync(join(f.project, id, "sidecar.json"), "utf8"), "kept");
  assert.equal(existsSync(join(f.archived, `${id}.jsonl`)), false);
});
test("Claude archive refuses collisions, unknown indexes and invalid IDs without changing history", () => {
  const f = fixture();
  assert.throws(() => f.api.archive("../outside"));
  mkdirSync(f.archived, { recursive: true });
  writeFileSync(join(f.archived, `${id}.jsonl`), "existing");
  assert.throws(() => f.api.archive(id), /덮어쓰지/);
  assert.equal(readFileSync(join(f.archived, `${id}.jsonl`), "utf8"), "existing");
  assert.equal(existsSync(join(f.project, id, "sidecar.json")), true);
  writeFileSync(join(f.project, "sessions-index.json"), "{}");
  assert.throws(() => f.api.archive(id), /색인/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_LIMITS } from "../../../shared/remote-web";
import type { Chat, ModelOption } from "../../../shared/types";
import {
  attachmentMime, attachmentProblem, chatGroups, effortChoices, folderNameProblem, isDark, modelChoices, nextTheme, parseSlash,
  projectApprovalMode, raisesAutonomy, readTheme, toBase64, withoutDeleted,
} from "./logic";

test("theme: stored value, system fallback and cycle", () => {
  assert.equal(readTheme("dark"), "dark");
  assert.equal(readTheme("light"), "light");
  assert.equal(readTheme(null), "system");
  assert.equal(readTheme("<script>"), "system");
  assert.equal(isDark("system", true), true);
  assert.equal(isDark("system", false), false);
  assert.equal(isDark("light", true), false);
  assert.deepEqual([nextTheme("system"), nextTheme("light"), nextTheme("dark")], ["light", "dark", "system"]);
});

test("approval: raising autonomy is detected, project delegateHighRisk counts as orchestrator-all", () => {
  assert.equal(raisesAutonomy("user", "orchestrator"), true);
  assert.equal(raisesAutonomy("orchestrator", "orchestrator-all"), true);
  assert.equal(raisesAutonomy("orchestrator-all", "user"), false);
  assert.equal(raisesAutonomy("orchestrator", "orchestrator"), false);
  assert.equal(projectApprovalMode({ approvalMode: "orchestrator", delegateHighRisk: true }), "orchestrator-all");
  assert.equal(projectApprovalMode({ approvalMode: "user", delegateHighRisk: true }), "user");
});

test("effort choices follow the model's efforts; workers get the medium..xhigh subset", () => {
  const models = { claude: [{ id: "opus", label: "Opus", reasoningEfforts: ["xhigh", "low", "high", "medium", "max"] }] };
  assert.deepEqual(effortChoices(models, "claude", "opus", false), ["auto", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortChoices(models, "claude", "opus", true), ["auto", "medium", "high", "xhigh"]);
  assert.deepEqual(effortChoices(models, "claude", "unknown", false), ["auto"]);
  const deepseek = { deepseek: [{ id: "deepseek-flash", label: "Flash", isDefault: true, reasoningEfforts: ["high", "max"] }] };
  assert.deepEqual(effortChoices(deepseek, "deepseek", "", true), ["auto", "high", "max"]);
});

test("model choices hide hidden models but keep the current value", () => {
  const list: ModelOption[] = [{ id: "a", label: "A" }, { id: "b", label: "B", hidden: true }];
  assert.deepEqual(modelChoices(list, "a").map(m => m.id), ["a"]);
  assert.deepEqual(modelChoices(list, "b").map(m => m.id), ["a", "b"]);
  assert.deepEqual(modelChoices(list, "gone").map(m => m.id), ["gone", "a"]);
  assert.deepEqual(modelChoices(undefined, "").map(m => m.id), []);
});

test("attachment pre-check mirrors D4", () => {
  const file = (name: string, size = 10, type = "") => ({ name, size, type });
  assert.equal(attachmentProblem(file("photo.png", 100, "image/png"), 0), null);
  assert.equal(attachmentProblem(file("notes.md"), 0), null);
  assert.equal(attachmentMime("notes.md", ""), "text/markdown");
  assert.equal(attachmentMime("x.bin", ""), "application/octet-stream");
  // Allow-list (same as the server): executables, scripts and SVG are refused like any unknown type.
  for (const name of ["setup.exe", "run.JS", "tool.py", "mod.psm1", "x.sh", "pic.svg", "blob.bin"])
    assert.match(attachmentProblem(file(name), 0)!, /이미지\(png·jpg·gif·webp\)·텍스트/, name);
  assert.match(attachmentProblem(file("a.txt:evil.ps1"), 0)!, /쓸 수 없는 파일 이름/);
  assert.match(attachmentProblem(file("con.txt"), 0)!, /쓸 수 없는 파일 이름/);
  assert.equal(attachmentProblem(file("trailing.txt. "), 0), null, "Windows trailing dot/space is normalized");
  assert.match(attachmentProblem(file("big.pdf", REMOTE_LIMITS.attachmentBytes + 1, "application/pdf"), 0)!, /10\.0 MB/);
  assert.match(attachmentProblem(file("a.txt"), REMOTE_LIMITS.attachmentsPendingPerChat)!, /10개/);
  assert.match(attachmentProblem(file("empty.txt", 0), 0)!, /빈 파일/);
});

test("base64 matches Buffer for large inputs", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("slash commands", () => {
  assert.deepEqual(parseSlash("/plan 로그인 고치기"), { kind: "command", name: "plan", arg: "로그인 고치기" });
  assert.deepEqual(parseSlash("/goal clear"), { kind: "command", name: "goal", arg: "clear" });
  assert.deepEqual(parseSlash("/review"), { kind: "command", name: "review", arg: "" });
  assert.deepEqual(parseSlash("  /compact  "), { kind: "command", name: "compact", arg: "" });
  assert.deepEqual(parseSlash("/stop"), { kind: "stop" });
  assert.equal(parseSlash("/plan")?.kind, "error");
  assert.equal(parseSlash("/plan-run"), null, "plan-run is only offered by the plan buttons");
  assert.equal(parseSlash("/unknown 그대로 보내기"), null);
  assert.equal(parseSlash("그냥 지시 /plan"), null);
  assert.deepEqual(parseSlash("/plan 첫 줄\n둘째 줄"), { kind: "command", name: "plan", arg: "첫 줄\n둘째 줄" });
});

test("folder names for D1", () => {
  assert.equal(folderNameProblem("my-project"), null);
  assert.equal(folderNameProblem("새 프로젝트"), null);
  for (const bad of ["", ".hidden", "a/b", "a\\b", "..", "a..b", "c:", "x".repeat(65)]) assert.ok(folderNameProblem(bad), bad);
});

const chat = (id: number, projectId: number, extra: Partial<Chat> = {}) => ({ id, projectId, title: `c${id}`, archived: false, lastActiveAt: id, ...extra }) as Chat;

test("chat groups: archived filtering, search matches, newest first", () => {
  const projects = [{ id: 1, name: "P1", archived: false }, { id: 2, name: "P2", archived: true }];
  const chats = [chat(1, 1), chat(2, 1, { archived: true }), chat(3, 1), chat(4, 2)];
  assert.deepEqual(chatGroups(chats, projects, false, null).map(g => [g.project.id, g.chats.map(c => c.id)]), [[1, [3, 1]]]);
  assert.deepEqual(chatGroups(chats, projects, true, null).map(g => [g.project.id, g.chats.map(c => c.id)]), [[1, [3, 2, 1]], [2, [4]]]);
  assert.deepEqual(chatGroups(chats, projects, true, new Set([2])).map(g => [g.project.id, g.chats.map(c => c.id)]), [[1, [2]]]);
  // An empty active project stays visible so a chat can be started in it.
  assert.deepEqual(chatGroups([], projects, false, null).map(g => g.project.id), [1]);
});

test("deleted chats stay gone", () => {
  const list = [chat(1, 1), chat(2, 1)];
  assert.deepEqual(withoutDeleted(list, new Set([2])).map(c => c.id), [1]);
  assert.equal(withoutDeleted(list, new Set()), list);
});

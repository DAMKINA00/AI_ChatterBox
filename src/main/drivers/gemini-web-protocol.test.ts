import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { webConversationId, webConversationUrl, webUsagePage } from "./gemini-web-protocol";
import { webPrompt } from "./gemini-web";
import type { AgentInput } from "./types";

const input = (attachments: AgentInput["attachments"]): AgentInput => ({
  text: "이 자료를 검토해 주세요.",
  attachments,
  noWrites: true,
});

function tempFile(name: string, data: string | Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "aichatterbox-gemini-web-protocol-"));
  const path = join(dir, name);
  writeFileSync(path, data);
  return { dir, path };
}

function attachment(path: string, name: string, mime: string) {
  return { id: 1, name, mime, size: statSync(path).size, path };
}

test("web conversation ids accept only account 1 Gemini app conversations", () => {
  const id = "web:gemini-1:/app/Abc_123-x";
  const url = "https://gemini.google.com/app/Abc_123-x";
  assert.equal(webConversationUrl(id), url);
  assert.equal(webConversationId(url), id);

  for (const invalid of [
    null,
    "",
    "web:gemini-2:/app/Abc_123-x",
    "web:gemini-1:/app/Abc_123-x/other",
    "web:gemini-1:/gemini/Abc_123-x",
    "web:gemini-1:https://accounts.google.com/app/Abc_123-x",
  ]) {
    assert.equal(webConversationUrl(invalid), "https://gemini.google.com/app");
  }

  for (const foreign of [
    "https://accounts.google.com/app/Abc_123-x",
    "https://myaccount.google.com/app/Abc_123-x",
    "http://gemini.google.com/app/Abc_123-x",
    "https://example.com/app/Abc_123-x",
    "https://gemini.google.com/",
    "https://gemini.google.com/app/Abc_123-x/other",
  ]) {
    assert.equal(webConversationId(foreign), null);
  }
});

test("webUsagePage preserves exact Korean and English current/weekly percentages and reset text", () => {
  const checkedAt = Date.parse("2026-10-14T06:00:00Z");
  const usage = webUsagePage(
    "현재 사용량\n12.5% 사용됨\n초기화: 오늘 18:00",
    "Weekly usage\n33.25% used\nReset: 2026-10-21 09:00",
    checkedAt,
  );

  assert.deepEqual(usage, {
    status: "available",
    detail: "현재 12.5% 사용됨 · 주간 33.25% 사용됨",
    checkedAt,
    current: { usedPercent: 12.5, resetText: "초기화: 오늘 18:00" },
    weekly: { usedPercent: 33.25, resetText: "Reset: 2026-10-21 09:00" },
  });

  const exhausted = webUsagePage("현재 100% 사용됨\n재설정: 내일", "Weekly 0% used\nReset tomorrow", checkedAt);
  assert.equal(exhausted.status, "limited");
  assert.equal(exhausted.current?.usedPercent, 100);
  assert.equal(exhausted.weekly?.usedPercent, 0);
});

test("invalid visible percentages become unknown and never fabricate a quota", () => {
  const checkedAt = 1234;
  const invalid = webUsagePage(
    "Current usage: 101% used\nReset: tomorrow",
    "주간 사용량: -1% 사용됨\n재설정: 다음 주",
    checkedAt,
  );
  assert.deepEqual(invalid, {
    status: "unknown",
    detail: "현재 웹 화면에서 잔여 사용량 수치를 확인할 수 없습니다.",
    checkedAt,
  });
  assert.equal("remaining" in invalid, false);
  assert.equal("limit" in invalid, false);
  assert.equal("current" in invalid, false);
  assert.equal("weekly" in invalid, false);

  const partial = webUsagePage("Current usage: 25% used", "Weekly usage: 140% used", checkedAt);
  assert.equal(partial.status, "available");
  assert.equal(partial.current?.usedPercent, 25);
  assert.equal(partial.current?.resetText, undefined);
  assert.equal(partial.weekly, undefined);
  assert.equal("remaining" in partial, false);
  assert.equal("limit" in partial, false);
});

test("webPrompt includes UTF-8 text attachments explicitly", async () => {
  const file = tempFile("자료.txt", "한글 자료\nUTF-8 본문");
  try {
    const prompt = await webPrompt(input([attachment(file.path, "자료.txt", "text/plain")]), "marker-utf8");
    assert.match(prompt, /^\[ChatterBox marker-utf8\]/);
    assert.match(prompt, /웹·CLI 모두 글쓰기 전용/);
    assert.match(prompt, /코드 분석·구현·디버깅·테스트·기술 리뷰·교차검증은 맡지 않는다/);
    assert.match(prompt, /\[참고 자료: 자료\.txt\]/);
    assert.match(prompt, /한글 자료\nUTF-8 본문/);
    assert.match(prompt, /\[참고 자료 끝\]/);
  } finally {
    rmSync(file.dir, { recursive: true, force: true });
  }
});

test("webPrompt rejects binary and non-UTF-8 attachments", async () => {
  const binary = tempFile("payload.bin", new Uint8Array([0, 1, 2, 255]));
  const broken = tempFile("broken.txt", new Uint8Array([0xc3, 0x28]));
  try {
    await assert.rejects(
      webPrompt(input([attachment(binary.path, "payload.bin", "application/octet-stream")]), "marker-binary"),
      /텍스트 자료만 지원/,
    );
    await assert.rejects(
      webPrompt(input([attachment(broken.path, "broken.txt", "text/plain")]), "marker-encoding"),
      /UTF-8 텍스트가 아닙니다/,
    );
  } finally {
    rmSync(binary.dir, { recursive: true, force: true });
    rmSync(broken.dir, { recursive: true, force: true });
  }
});

test("webPrompt rejects an attachment over the 200KB limit", async () => {
  const file = tempFile("large.txt", new Uint8Array(200_001).fill(0x61));
  try {
    await assert.rejects(
      webPrompt(input([attachment(file.path, "large.txt", "text/plain")]), "marker-large"),
      /최대 200KB/,
    );
  } finally {
    rmSync(file.dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { findTextMatches } from "./chat-search";

test("finds non-overlapping Korean and mixed-case English literals", () => {
  assert.deepEqual(findTextMatches("안녕 안녕", " 안녕 "), [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(findTextMatches("Alpha ALPHA alpha", "AlPhA"), [
    { start: 0, end: 5 }, { start: 6, end: 11 }, { start: 12, end: 17 },
  ]);
  assert.deepEqual(findTextMatches("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test("treats regex metacharacters, slashes, and backslashes literally", () => {
  const text = "C++ [] /path\\file C++ [] /path\\file";
  assert.deepEqual(findTextMatches(text, "C++"), [{ start: 0, end: 3 }, { start: 18, end: 21 }]);
  assert.deepEqual(findTextMatches(text, "[]"), [{ start: 4, end: 6 }, { start: 22, end: 24 }]);
  assert.deepEqual(findTextMatches(text, "/path\\file"), [{ start: 7, end: 17 }, { start: 25, end: 35 }]);
});

test("returns no matches for empty or whitespace-only queries", () => {
  assert.deepEqual(findTextMatches("text", ""), []);
  assert.deepEqual(findTextMatches("text", " \t\n "), []);
});

test("keeps original UTF-16 offsets around astral Unicode characters", () => {
  const text = "😀 Alpha 😀 alpha";
  assert.deepEqual(findTextMatches(text, "alpha"), [{ start: 3, end: 8 }, { start: 12, end: 17 }]);
});

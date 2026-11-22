import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDeleteTarget } from "./chat-list";

test("a delayed delete response identifies only the row shown in the confirmation", () => {
  const confirmed = { id: 1, title: "원래 채팅", createdAt: 20, projectId: 3 };
  assert.equal(matchesDeleteTarget({ ...confirmed }, confirmed), true);
  assert.equal(matchesDeleteTarget({ ...confirmed, createdAt: 21 }, confirmed), false);
  assert.equal(matchesDeleteTarget({ ...confirmed, projectId: 4 }, confirmed), false);
  assert.equal(matchesDeleteTarget({ ...confirmed, title: "바뀐 제목" }, confirmed), false);
  assert.equal(matchesDeleteTarget({ ...confirmed, id: 2 }, confirmed), false);
  assert.equal(matchesDeleteTarget(undefined, confirmed), false);
});

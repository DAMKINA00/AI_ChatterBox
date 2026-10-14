import assert from "node:assert/strict";
import test from "node:test";
import { artifactFileLabel, isLocalArtifactImage, markdownFileDestination, normalizeArtifactMarkdown } from "./artifact-markdown";

test("normalizes one and two colon citations into safe file links", () => {
  const text = `결과 :codex-file-citation{path="D:/결과 폴더/final report.pdf" purpose="output"}\n다음 ::codex-file-citation{path="D:/결과 폴더/최종본.png" purpose="output"}`;
  assert.equal(
    normalizeArtifactMarkdown(text),
    "결과 [final report.pdf](<D:/결과 폴더/final report.pdf>)\n다음 [최종본.png](<D:/결과 폴더/최종본.png>)",
  );
});

test("does not rewrite fenced or inline code", () => {
  const text = [
    "` :codex-file-citation{path=\"inline.md\"} `",
    "`` inline ` :codex-file-citation{path=\"double-inline.md\"} ``",
    "",
    "```text",
    ":codex-file-citation{path=\"fenced.md\"}",
    "```",
    "",
    ":codex-file-citation{path=\"visible.md\"}",
  ].join("\n");
  const result = normalizeArtifactMarkdown(text);
  assert.match(result, /` :codex-file-citation\{path=\"inline\.md\"\} `/);
  assert.match(result, /`` inline ` :codex-file-citation\{path=\"double-inline\.md\"\} ``/);
  assert.match(result, /```text\n:codex-file-citation\{path=\"fenced\.md\"\}\n```/);
  assert.match(result, /\[visible\.md\]\(<visible\.md>\)$/);
});

test("keeps malformed and unsafe citations as visible text", () => {
  const malformed = ":codex-file-citation{purpose=\"output\"}";
  const unsafe = ":codex-file-citation{path=\"javascript:alert(1)\" purpose=\"output\"}";
  const tripleColon = ":::codex-file-citation{path=\"triple.md\" purpose=\"output\"}";
  assert.equal(normalizeArtifactMarkdown(`${malformed}\n${unsafe}\n${tripleColon}`), `${malformed}\n${unsafe}\n${tripleColon}`);
});

test("recognizes local image links without treating remote images as previews", () => {
  assert.equal(isLocalArtifactImage("사진 폴더/최종본.png"), true);
  assert.equal(isLocalArtifactImage("D:/사진/최종본.PNG#page"), true);
  assert.equal(isLocalArtifactImage("https://example.com/image.png"), false);
  assert.equal(isLocalArtifactImage("javascript:alert(1).png"), false);
  assert.equal(artifactFileLabel("D:/결과 폴더/final report.pdf"), "final report.pdf");
  assert.equal(markdownFileDestination("D:/결과 폴더/a#b?.png"), "<D:/결과 폴더/a%23b%3F.png>");
});

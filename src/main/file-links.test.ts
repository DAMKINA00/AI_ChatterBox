import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLink, mayOpenDocument } from "./file-links";
import { safeLinkHref } from "../shared/links";
import { resolve } from "node:path";

test("local links survive Markdown transformation and resolve with spaces and source line suffixes", () => {
  const folder = process.cwd();
  assert.deepEqual(resolveLink("docs/report%20one.md:12:3", folder), { path: resolve(folder, "docs/report one.md") });
  assert.deepEqual(resolveLink("docs/report.md#L12", folder), { path: resolve(folder, "docs/report.md") });
  if (process.platform === "win32") {
    for (const link of ["C:/Apps/report%20one.zip", "/C:/Apps/report%20one.zip", "file:///C:/Apps/report%20one.zip"])
      assert.equal((resolveLink(link, folder) as { path: string }).path.replace(/\\/g, "/"), "C:/Apps/report one.zip");
  }
  assert.equal(safeLinkHref("D:/works/report.md"), "D:/works/report.md");
});

test("web URLs remain web URLs and executable schemes/device paths are refused", () => {
  assert.deepEqual(resolveLink("https://example.com/a?b=1", process.cwd()), { url: "https://example.com/a?b=1" });
  for (const href of ["javascript:alert(1)", "data:text/html,x", "powershell:calc", "//example.com/path", "\\\\?\\C:\\secret", "docs/a.md%00.cmd"])
    assert.throws(() => resolveLink(href, process.cwd()), href);
  assert.equal(mayOpenDocument("report.zip"), true);
  assert.equal(mayOpenDocument("report.md"), true);
  assert.equal(mayOpenDocument("click.cmd"), false);
  assert.equal(mayOpenDocument("link.lnk"), false);
});

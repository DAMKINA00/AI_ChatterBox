import { isAbsolute, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { safeLinkHref } from "../shared/links";

export function resolveLink(href: string, folder: string): { url: string } | { path: string } {
  const safe = typeof href === "string" ? safeLinkHref(href) : "";
  if (!safe || safe.startsWith("#")) throw new Error("지원하지 않는 링크입니다.");
  if (/^https?:\/\//i.test(safe)) {
    const url = new URL(safe);
    if (!url.hostname) throw new Error("올바른 웹 주소가 아닙니다.");
    return { url: url.href };
  }
  let path = safe;
  if (/^file:\/\//i.test(path)) path = fileURLToPath(path);
  else { try { path = decodeURIComponent(path); } catch { /* A literal % can be part of a filename. */ } }
  path = path.replace(/^\/(?=[a-z]:[\\/])/i, "").replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  if (/[\u0000-\u001f]/.test(path) || /^\\\\[?.]\\/.test(path) || /:(?![\\/])/.test(path.replace(/^[a-z]:/i, "")))
    throw new Error("올바른 파일 경로가 아닙니다.");
  return { path: isAbsolute(path) ? path : resolve(folder, path) };
}

export function mayOpenDocument(path: string): boolean {
  return !/\.(?:exe|com|msi|msp|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|scr|pif|lnk|url|hta|reg)$/i.test(extname(path));
}

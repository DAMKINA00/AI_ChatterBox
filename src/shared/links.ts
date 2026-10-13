/** Preserve local Markdown links which react-markdown's web-only default removes. */
export function safeLinkHref(value: string): string {
  const s = value.trim();
  if (!s || /[\u0000-\u001f]/.test(s)) return "";
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s) || /^\/?[a-z]:[\\/]/i.test(s)) return s;
  if (/^[a-z][a-z\d+.-]*:/i.test(s) || /^\/\//.test(s) || /^\\\\[?.]\\/.test(s)) return "";
  return s;
}

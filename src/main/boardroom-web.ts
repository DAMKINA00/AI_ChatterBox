import { isIP } from "node:net";

export type WebLookup = { query?: string; urls: string[] };
export type WebSource = { url: string; title: string; note: string; kind: "page" | "search" };
export type WebObservation = Pick<WebSource, "kind"> & { title?: string; snippet?: string };

export function publicWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
      || !host.includes(".") || isIP(host) || /\.(?:local|localhost|internal|test|invalid|example|onion)$/i.test(host)) return;
    url.hash = "";
    return url.href;
  } catch { return undefined; }
}

export function agendaUrls(text: string) {
  return [...new Set((text.match(/https?:\/\/[^\s<>"\x27\]]+/gi) ?? []).flatMap(value => {
    const url = publicWebUrl(value.replace(/[).,!?;。]+$/, ""));
    return url ? [url] : [];
  }))].slice(0, 4);
}

export function parseWebSources(raw: string, observed: ReadonlyMap<string, WebObservation>): WebSource[] {
  let items: Array<Partial<WebSource>> = [];
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")) as { sources?: Array<Partial<WebSource>> };
    if (Array.isArray(value?.sources)) items = value.sources.slice(0, 8);
  } catch { /* Actual search snippets can still be shared if prose was returned instead of JSON. */ }
  const sources = new Map<string, WebSource>();
  const add = (url: string, source: WebObservation, item?: Partial<WebSource>) => {
    if (sources.has(url)) return;
    const note = (source.kind === "page" && typeof item?.note === "string" ? item.note : source.snippet)?.trim();
    if (!note) return;
    const title = (source.title || (typeof item?.title === "string" ? item.title : "")).replace(/[\[\]\r\n]/g, " ").trim().slice(0, 110);
    sources.set(url, { url, kind: source.kind, title: title || new URL(url).hostname, note: note.slice(0, 900) });
  };
  for (const item of items) {
    const url = publicWebUrl(item?.url);
    const source = url && observed.get(url);
    if (url && source) add(url, source, item);
  }
  for (const [url, source] of observed) if (source.kind === "search") add(url, source);
  return [...sources.values()].slice(0, 5);
}

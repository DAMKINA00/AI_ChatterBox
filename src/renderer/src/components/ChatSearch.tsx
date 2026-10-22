import { createContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { findTextMatches } from "../lib/chat-search";
import { Button, Input } from "./ui";

export const ChatSearchQuery = createContext("");

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

function blockAncestor(node: Text, root: HTMLElement): Element {
  let parent = node.parentElement;
  while (parent && parent !== root) {
    if (BLOCK_TAGS.has(parent.tagName)) return parent;
    parent = parent.parentElement;
  }
  return root;
}

function matchingRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  if (!query.trim()) return ranges;
  for (const body of root.querySelectorAll<HTMLElement>("[data-chat-search-text]")) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const nodes: { node: Text; start: number; end: number }[] = [];
    let text = "";
    let previousBlock: Element | undefined;
    let separatorPending = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).tagName === "BR") separatorPending = true;
        continue;
      }
      const parent = node.parentElement;
      if (parent?.closest("[data-chat-search-ignore]") || parent?.closest("[data-chat-search-text]") !== body) {
        separatorPending = true;
        continue;
      }
      const value = node.textContent ?? "";
      if (!value) continue;
      const block = blockAncestor(node as Text, body);
      if (text && (separatorPending || previousBlock !== block)) text += "\n";
      const start = text.length;
      text += value;
      nodes.push({ node: node as Text, start, end: text.length });
      previousBlock = block;
      separatorPending = false;
    }
    for (const match of findTextMatches(text, query)) {
      const first = nodes.find(n => n.end > match.start);
      const last = nodes.find(n => n.end >= match.end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, match.start - first.start);
      range.setEnd(last.node, match.end - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}

function scrollRangeIntoView(range: Range, root: HTMLElement) {
  let element = range.startContainer.parentElement;
  while (element && element !== root) {
    if (element.scrollHeight > element.clientHeight) {
      const rect = range.getBoundingClientRect();
      const viewport = element.getBoundingClientRect();
      if (rect.top < viewport.top || rect.bottom > viewport.bottom) {
        element.scrollTop += rect.top - viewport.top - viewport.height / 2 + rect.height / 2;
      }
    }
    element = element.parentElement;
  }
}

export function ChatSearch({ root, revision, query, onQuery, onClose }: {
  root: RefObject<HTMLDivElement | null>;
  revision: unknown;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const active = useRef(0);
  const lastQuery = useRef("");
  const [draft, setDraft] = useState(query);
  const [composing, setComposing] = useState(false);
  const [result, setResult] = useState({ active: 0, count: 0 });
  const pending = draft !== query;

  useEffect(() => {
    if (!pending || composing) return;
    const timer = setTimeout(() => onQuery(draft), 500);
    return () => clearTimeout(timer);
  }, [draft, query, pending, composing, onQuery]);

  const show = (index: number, scroll: boolean) => {
    active.current = index;
    const range = ranges.current[index];
    CSS.highlights.set("chat-search-active", new Highlight(...(range ? [range] : [])));
    setResult({ active: range ? index + 1 : 0, count: ranges.current.length });
    if (scroll && range && root.current) {
      scrollRangeIntoView(range, root.current);
      const rect = range.getBoundingClientRect();
      const viewport = root.current.getBoundingClientRect();
      root.current.scrollTop += rect.top - viewport.top - viewport.height / 2 + rect.height / 2;
    }
  };
  const move = (direction: number) => {
    const count = ranges.current.length;
    if (count) show((active.current + direction + count) % count, true);
  };

  useLayoutEffect(() => { input.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (!root.current) return;
    const changed = lastQuery.current !== query;
    lastQuery.current = query;
    const previous = ranges.current[active.current];
    ranges.current = matchingRanges(root.current, query).reverse();
    const retained = !changed && previous ? ranges.current.findIndex(range =>
      range.startContainer === previous.startContainer && range.startOffset === previous.startOffset) : -1;
    const highlight = new Highlight();
    for (const range of ranges.current) highlight.add(range);
    CSS.highlights.set("chat-search", highlight);
    show(changed ? 0 : retained >= 0 ? retained : Math.max(0, Math.min(active.current, ranges.current.length - 1)), changed);
  }, [root, query, revision]);
  useLayoutEffect(() => () => {
    CSS.highlights.delete("chat-search");
    CSS.highlights.delete("chat-search-active");
  }, []);

  return <div className="flex shrink-0 items-center gap-2 border-b bg-card px-4 py-2" role="search" aria-label="대화 내용 검색" data-testid="chat-search">
    <Search className="size-4 shrink-0 text-muted-foreground" />
    <Input ref={input} value={draft} onChange={e => setDraft(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} className="h-8 max-w-md" aria-label="대화에서 찾을 내용" placeholder="검색어 입력 · Enter 또는 0.5초 뒤 검색" onKeyDown={e => {
      if (composing || e.nativeEvent.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Enter") {
        e.preventDefault();
        if (pending) onQuery(draft);
        else move(e.shiftKey ? -1 : 1);
      }
    }} />
    <span className="min-w-20 text-[12px] tabular-nums text-muted-foreground" role="status" data-testid="chat-search-count">
      {pending ? "검색 대기…" : query.trim() ? result.count ? `${result.active} / ${result.count}` : "결과 없음" : "내용 입력"}
    </span>
    <Button variant="ghost" size="icon-sm" disabled={pending || !result.count} onClick={() => move(1)} aria-label="다음 검색 결과" title="위쪽 결과 · Enter"><ChevronUp /></Button>
    <Button variant="ghost" size="icon-sm" disabled={pending || !result.count} onClick={() => move(-1)} aria-label="이전 검색 결과" title="아래쪽 결과 · Shift+Enter"><ChevronDown /></Button>
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="대화 검색 닫기" title="Esc"><X /></Button>
  </div>;
}

import type { Item } from "./timeline";

export function needsAttention(item: Item, live: boolean): boolean {
  switch (item.kind) {
    case "approval": return !item.decision;
    case "ask": return item.answer === undefined;
    case "message": return live && item.streaming;
    case "tool": return live && !item.result;
    case "image": return live && item.status === "running";
    case "consult": return (live && item.status === "running") || item.children.some(child => needsAttention(child, live));
    default: return false;
  }
}

/** Older active work stays visible even when surrounding history is outside the window. */
export function windowItems(items: Item[], start: number, live: boolean) {
  const pinned = items.slice(0, start).filter(item => needsAttention(item, live));
  return { visible: [...pinned, ...items.slice(start)], hidden: start - pinned.length };
}

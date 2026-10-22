type TextMatch = { start: number; end: number };

export function findTextMatches(text: string, query: string): TextMatch[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const literal = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches: TextMatch[] = [];
  for (const match of text.matchAll(new RegExp(literal, "giu"))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

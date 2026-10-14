import { safeLinkHref } from "./links";

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
const CITATION = /(?<!:):{1,2}codex-file-citation\{[^}\r\n]*\}/g;

/**
 * Return the part of a local Markdown destination that is safe to put in a
 * link. Angle brackets keep spaces, Korean characters, and parentheses from
 * changing the Markdown parse; # and ? still need escaping as file names.
 */
export function markdownFileDestination(path: string): string {
  return `<${path.replace(/[<>?#\r\n]/g, (character) => encodeURIComponent(character))}>`;
}

export function artifactFileLabel(path: string): string {
  const withoutSuffix = path.replace(/[?#].*$/, "").replace(/[\\/]$/, "");
  const name = withoutSuffix.split(/[\\/]/).pop()?.trim();
  return name || "파일";
}

/** A safe local candidate for the automatic image preview request. */
export function isLocalArtifactImage(href: string): boolean {
  const safe = safeLinkHref(href);
  if (!safe || safe.startsWith("#") || /^https?:\/\//i.test(safe)) return false;
  return IMAGE_EXTENSIONS.test(safe.replace(/[?#].*$/, ""));
}

function citationPath(raw: string): string | null {
  const match = /\bpath\s*=\s*(["'])([\s\S]*?)\1/.exec(raw);
  if (!match) return null;
  const path = match[2].replace(/\\(["'\\])/g, "$1");
  return safeLinkHref(path) ? path : null;
}

function replaceCitations(segment: string): string {
  return segment.replace(CITATION, (token) => {
    const path = citationPath(token.slice(token.indexOf("{") + 1, -1));
    if (!path) return token;
    return `[${artifactFileLabel(path)}](${markdownFileDestination(path)})`;
  });
}

/**
 * Convert renderer citation tokens into ordinary file links without touching
 * fenced or inline code. Citation syntax is emitted with one or two colons by
 * different providers, so both forms are accepted.
 */
export function normalizeArtifactMarkdown(text: string): string {
  const lines = text.split(/(\r?\n)/);
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineRun = 0;

  return lines
    .map((line) => {
      if (/^\r?\n$/.test(line)) return line;
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
        return line;
      }
      if (fenceMatch) {
        fence = { marker: fenceMatch[1][0] as "`" | "~", length: fenceMatch[1].length };
        return line;
      }

      let output = "";
      let plainStart = 0;
      for (let index = 0; index < line.length; index++) {
        if (line[index] !== "`") continue;
        let run = 1;
        while (line[index + run] === "`") run++;
        if (!inlineRun) {
          output += replaceCitations(line.slice(plainStart, index));
          inlineRun = run;
          output += line.slice(index, index + run);
          plainStart = index + run;
        } else if (run === inlineRun) {
          output += line.slice(plainStart, index + run);
          inlineRun = 0;
          plainStart = index + run;
        }
        index += run - 1;
      }
      output += inlineRun ? line.slice(plainStart) : replaceCitations(line.slice(plainStart));
      return output;
    })
    .join("");
}

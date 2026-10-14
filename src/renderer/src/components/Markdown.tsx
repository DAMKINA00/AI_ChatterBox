import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/utils";
import { safeLinkHref } from "../../../shared/links";
import { normalizeArtifactMarkdown } from "../../../shared/artifact-markdown";
import { ArtifactPreview } from "./ArtifactPreview";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

export function CopyButton({ text, className, label = "복사" }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {done ? "복사됨" : null}
    </button>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  const code = textOf(children);
  const lang = /language-(\w+)/.exec(
    (children as { props?: { className?: string } } | undefined)?.props?.className ?? "",
  )?.[1];
  return (
    <div className="group relative overflow-hidden rounded-lg border bg-code-bg">
      <div className="flex items-center justify-between border-b px-3 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{lang ?? "code"}</span>
        <CopyButton text={code.replace(/\n$/, "")} label="코드 복사" />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        urlTransform={safeLinkHref}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: Pre,
          a: ({ href, children }) => <ArtifactPreview href={href ?? ""} label={children} />,
          img: ({ src, alt }) => <ArtifactPreview href={src ?? ""} label={alt || src || "이미지"} image />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {normalizeArtifactMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});

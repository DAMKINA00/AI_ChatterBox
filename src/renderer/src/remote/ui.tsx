// Small building blocks of the remote web page (no Radix: the page stays light and mobile-first).
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

export const FIELD = "h-10 w-full rounded-md border border-input bg-transparent px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Btn({ className, variant = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "destructive" | "ghost" }) {
  return <button type="button" className={cn(
    "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:opacity-45 [&_svg]:size-4",
    variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
    variant === "outline" && "border hover:bg-accent",
    variant === "destructive" && "bg-destructive text-white hover:bg-destructive/90",
    variant === "ghost" && "hover:bg-accent",
    className,
  )} {...props} />;
}

export function Md({ text }: { text: string }) {
  return (
    <div className="prose-chat break-words text-[14px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          // External images would leak the page to third parties; show the alt text instead.
          img: ({ alt, src }) => <span className="text-muted-foreground">[이미지: {alt || src}]</span>,
          table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded-lg border bg-code-bg p-3 font-mono text-[12.5px]">{children}</pre>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border bg-card p-3", className)}>{children}</div>;
}

export function Clip({ text, limit = 4000 }: { text: string; limit?: number }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code-bg p-2 font-mono text-[11.5px]">{text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit}자 생략)` : text}</pre>;
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? <div role="alert" className="text-[12.5px] text-destructive">{error}</div> : null;
}

/** Bottom sheet on phones, centered dialog on wide screens. Escape and the backdrop close it. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass inline handlers; keep the latest without re-running the focus effect (it would steal focus while typing).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Only the topmost dialog (e.g. the confirm over a settings sheet) reacts to Escape.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && [...document.querySelectorAll("[role=dialog]")].at(-1) === panel.current) close.current(); };
    window.addEventListener("keydown", key);
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className={cn("flex max-h-[90dvh] w-full flex-col rounded-t-xl border bg-background shadow-xl outline-none md:rounded-xl", wide ? "md:max-w-2xl" : "md:max-w-md")}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
          <Btn variant="ghost" onClick={onClose} aria-label="닫기"><X /></Btn>
        </div>
        <div className="overflow-y-auto px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}

// ---------- confirm dialog usable from async code (D3 428 → confirm → resend)

type Pending = { message: string; resolve: (ok: boolean) => void };
let show: ((p: Pending) => void) | null = null;

/** Ask the user; resolves false when no host is mounted. */
export const askConfirm = (message: string) => new Promise<boolean>(resolve => (show ? show({ message, resolve }) : resolve(false)));

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => { show = setPending; return () => { show = null; }; }, []);
  if (!pending) return null;
  const done = (ok: boolean) => { pending.resolve(ok); setPending(null); };
  return (
    <Modal title="확인" onClose={() => done(false)}>
      <p className="whitespace-pre-wrap text-[14px]">{pending.message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="outline" onClick={() => done(false)}>취소</Btn>
        <Btn variant="destructive" onClick={() => done(true)}>계속</Btn>
      </div>
    </Modal>
  );
}

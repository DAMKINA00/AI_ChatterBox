import { useState } from "react";
import { ChevronRight, FilePlus2, FileMinus2, FilePen } from "lucide-react";
import type { FileDiff } from "../../../shared/types";
import { cn } from "../lib/utils";

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

const shortPath = (p: string) => {
  const parts = p.split(/[\\/]/);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
};

export function Stats({ diff }: { diff: string }) {
  const { add, del } = diffStats(diff);
  return (
    <span className="font-mono text-[11px] tabular-nums">
      <span className="text-success">+{add}</span> <span className="text-destructive">−{del}</span>
    </span>
  );
}

export function DiffBody({ diff }: { diff: string }) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("==="));
  if (!lines.some((l) => l.trim())) return <div className="px-3 py-2 text-[12px] text-muted-foreground">변경 내용 미리보기가 없습니다.</div>;
  return (
    <div className="max-h-96 overflow-auto bg-code-bg font-mono text-[12px] leading-[1.55] select-text">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre",
            l.startsWith("+") && "bg-success/12 text-success",
            l.startsWith("-") && "bg-destructive/12 text-destructive",
            l.startsWith("@@") && "bg-primary/8 text-muted-foreground",
          )}
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
}

export function DiffList({ files, defaultOpen = false }: { files: FileDiff[]; defaultOpen?: boolean }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border">
      {files.map((f) => (
        <DiffFile key={f.path} file={f} defaultOpen={defaultOpen || files.length === 1} />
      ))}
    </div>
  );
}

function DiffFile({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = file.kind === "add" ? FilePlus2 : file.kind === "delete" ? FileMinus2 : FilePen;
  return (
    <div>
      <button
        className="flex w-full items-center gap-2 bg-card px-3 py-1.5 text-left text-[12.5px] hover:bg-accent"
        onClick={() => setOpen(!open)}
        title={file.movePath ? `${file.path} → ${file.movePath}` : file.path}
      >
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">{shortPath(file.path)}{file.movePath && ` → ${shortPath(file.movePath)}`}</span>
        <Stats diff={file.diff} />
      </button>
      {open && <DiffBody diff={file.diff} />}
    </div>
  );
}

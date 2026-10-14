import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { isAgentExpression, type AgentExpression } from "../../../shared/types";
import { cn } from "../lib/utils";

export type AvatarKind = "orch" | "claude" | "gpt" | "gemini";
export type AvatarSize = 24 | 32 | 36;

const SIZE_CLASS: Record<AvatarSize, string> = { 24: "size-6", 32: "size-8", 36: "size-9" };

function source(kind: AvatarKind, expression: AgentExpression): string {
  const base = import.meta.env.BASE_URL || "./";
  return `${base.endsWith("/") ? base : `${base}/`}characters/${kind}/${expression}.png`;
}

/** Character art with a neutral fallback for stale or missing expression assets. */
export function AgentAvatar({
  kind,
  expression,
  size = 36,
  alt,
  className,
}: {
  kind: AvatarKind;
  expression?: AgentExpression | string | null;
  size?: AvatarSize;
  alt: string;
  className?: string;
}) {
  const requested = isAgentExpression(expression) ? expression : "neutral";
  const [current, setCurrent] = useState<AgentExpression>(requested);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setCurrent(requested);
    setMissing(false);
  }, [kind, requested]);

  const classes = cn("shrink-0 rounded-full object-cover", SIZE_CLASS[size], className);
  if (kind === "gemini") {
    return (
      <span
        className={cn(classes, "inline-flex items-center justify-center bg-gradient-to-br from-sky-500/20 via-violet-500/20 to-indigo-500/30")}
        role="img"
        aria-label={alt}
        data-testid="agent-avatar"
        data-kind={kind}
        data-expression={current}
      >
        <Sparkles className="size-[60%] text-violet-600 dark:text-sky-300" strokeWidth={2.25} aria-hidden="true" />
      </span>
    );
  }
  if (missing) return <span className={classes} role="img" aria-label={alt} data-testid="agent-avatar" data-kind={kind} data-expression="neutral" />;
  return (
    <img
      src={source(kind, current)}
      alt={alt}
      className={classes}
      draggable={false}
      data-testid="agent-avatar"
      data-kind={kind}
      data-expression={current}
      onError={() => {
        if (current === "neutral") setMissing(true);
        else setCurrent("neutral");
      }}
    />
  );
}

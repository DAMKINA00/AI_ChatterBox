import { chatOrchestrator, roleTone, type Role, type WorkerKind } from "../../../shared/types";
import { activeWorkingKinds, WORKING_COLORS } from "../lib/working-colors";
import { useStore } from "../store";
import { cn } from "../lib/utils";

export function WorkingIndicator({ chatId, role = "orch", kind, className, label = "작업 중" }: { chatId?: number; role?: Role; kind?: WorkerKind; className?: string; label?: string }) {
  const agents = useStore(s => chatId === undefined ? undefined : s.agents[chatId]);
  const consults = useStore(s => chatId === undefined ? undefined : s.consults[chatId]);
  const chat = useStore(s => s.chats.find(c => c.id === chatId));
  const project = useStore(s => s.projects.find(p => p.id === chat?.projectId));
  const provider = chat && project ? chatOrchestrator(chat, project).agent : "claude";
  const fallback = provider === "codex" ? "gpt" : provider;
  const tone = roleTone(role, agents);
  const kinds = kind ? [kind] : tone === "orch" ? activeWorkingKinds(agents, consults, fallback) : [tone];
  return <svg viewBox="0 0 24 24" className={cn("working-indicator size-3.5 shrink-0 overflow-visible", className)} role="img" aria-label={label} data-testid="working-indicator" data-colors={kinds.join(",")}>
    <g className="working-orbit">
      {Array.from({ length: 6 }, (_, index) => {
        const angle = index * Math.PI / 3;
        return <circle key={index} className="working-dot" cx={12 + Math.cos(angle) * 7.3} cy={12 + Math.sin(angle) * 7.3} r={1.7} fill={WORKING_COLORS[kinds[index % kinds.length]]} style={{ animationDelay: `${-index * 0.15}s` }} />;
      })}
    </g>
  </svg>;
}

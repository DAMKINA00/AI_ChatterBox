import type { ChatAgent, Consult, WorkerKind } from "../../../shared/types";

export const WORKING_COLORS: Record<WorkerKind, string> = {
  claude: "var(--claude)", gpt: "var(--gpt)", gemini: "var(--gemini)", grok: "#7298b0", deepseek: "var(--deepseek)",
};

export function activeWorkingKinds(agents: ChatAgent[] | undefined, consults: Consult[] | undefined, fallback: WorkerKind): WorkerKind[] {
  const running = new Set(consults?.filter(c => c.status === "running").map(c => c.toRole));
  const kinds = new Set(agents?.filter(a => a.status === "active" && running.has(a.key)).map(a => a.kind));
  return kinds.size ? (Object.keys(WORKING_COLORS) as WorkerKind[]).filter(k => kinds.has(k)) : [fallback];
}

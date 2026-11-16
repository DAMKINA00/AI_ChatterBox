import type { AgentKind } from "../../../shared/types";

/** Display only; provider model IDs remain unchanged in saved settings and requests. */
export function shortModelLabel(agent: AgentKind, label: string): string {
  if (agent === "gemini") return label.replace(/^Gemini\s+/i, "");
  if (agent === "codex") return label.replace(/^GPT-/i, "");
  if (agent === "deepseek") return label.replace(/^DeepSeek(?:\s+|-)/i, "");
  return label;
}
